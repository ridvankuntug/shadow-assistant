/**
 * Graceful-shutdown signal wiring. SIGINT (Ctrl+C), SIGTERM and SIGBREAK
 * (Windows Ctrl+Break; never raised elsewhere, so listening is harmless) all
 * run the same shutdown, once: a different signal arriving while the first
 * shutdown is still closing the server is ignored instead of starting another.
 * Each listener is `once`, as before: repeating the *same* signal (a second
 * Ctrl+C) falls back to Node's default and exits at once, the escape hatch for
 * a shutdown that hangs.
 *
 * `runShutdown` (T7.w.10h) runs the shutdown itself: closes in order (at most
 * SHUTDOWN_CLOSE_BUDGET_MS, so a hanging close never keeps the flushes from
 * starting), every flush even if another fails, each failure logged, and a
 * forced exit after SHUTDOWN_TIMEOUT_MS in total. Timers and exit are
 * injected for tests.
 */

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const satisfies readonly NodeJS.Signals[];

/** The part of `process` this needs (an EventEmitter in tests). */
export interface SignalSource {
  once(event: NodeJS.Signals, listener: () => void): unknown;
}

export function onShutdownSignal(
  source: SignalSource,
  signals: readonly NodeJS.Signals[],
  shutdown: (signal: NodeJS.Signals) => void,
): void {
  let done = false;
  for (const signal of signals) {
    source.once(signal, () => {
      if (done) return;
      done = true;
      shutdown(signal);
    });
  }
}

/**
 * Total time the shutdown may take before the process is forced out
 * (`process.exit`). The tray waits at most about 5 s on a Windows sign-out
 * (CoreSupervisor.cs), so this stays at 5 s.
 */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Time the `close` steps may take together. When it runs out the steps still
 * closing are logged and left running, the remaining close steps are skipped,
 * and the flushes start anyway: the stores hold changes in memory (the
 * notifications up to 1 s, T7.w.10g), so a hanging `server.close()` must not
 * cost them. The rest (SHUTDOWN_TIMEOUT_MS minus this, 2 s) is left for the
 * flushes.
 */
export const SHUTDOWN_CLOSE_BUDGET_MS = 3_000;

/** One named shutdown step; `run` may return a promise or throw. */
export interface ShutdownStep {
  name: string;
  run: () => unknown;
}

export interface ShutdownPlan {
  /** Closed one after another, in order (stop new work first); a failure is logged and the next still runs. */
  close: readonly ShutdownStep[];
  /** Run together after `close` (`Promise.allSettled`): one failure never skips another; each is logged. */
  flush: readonly ShutdownStep[];
}

export interface ShutdownDeps {
  log: (msg: string) => void;
  exit: (code: number) => void;
  /** Default SHUTDOWN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Default SHUTDOWN_CLOSE_BUDGET_MS. */
  closeBudgetMs?: number;
  /** Timer for the close budget and the forced exit (tests: a fake). Returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const realTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/** Error code or name only: an fs message holds a path, and a step's message may hold more. */
function errText(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (err instanceof Error) return err.name;
  }
  return typeof err;
}

/**
 * Runs the shutdown: the `close` steps in order, then every `flush` step at
 * once, then `exit(0)`. Every failure is logged by step name and never stops
 * the rest. Two time limits, both started at once:
 * - `closeBudgetMs`: if the close steps take longer (a step that hangs), the
 *   steps still closing are named in the log and left running, the close
 *   steps not yet started are skipped (named too), and the flushes start.
 *   The flushes therefore always run.
 * - `timeoutMs`: if the whole run takes longer, the process exits anyway,
 *   with the steps still running named in the log.
 * `exit` is called exactly once. The exit code is 0 in every case: the stop
 * was asked for, and a non-zero code would make run-core.ps1 and the tray
 * restart the Core (docs/05-deploy.md).
 */
export async function runShutdown(plan: ShutdownPlan, deps: ShutdownDeps): Promise<void> {
  let exited = false;
  const running = new Set<string>();
  const setTimer = deps.setTimer ?? realTimer;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    deps.exit(0);
  };

  // Close budget: ends the close phase early. `endClose` also runs on the
  // forced exit, so a pending budget timer never outlives the shutdown.
  let closeOver = false;
  let endClose!: () => void;
  const budget = new Promise<void>((resolve) => (endClose = resolve));
  const closeBudgetMs = deps.closeBudgetMs ?? SHUTDOWN_CLOSE_BUDGET_MS;
  let next = 0;
  const cancelBudget = setTimer(() => {
    if (exited || closeOver) return;
    closeOver = true;
    const skipped = plan.close.slice(next).map((s) => s.name);
    deps.log(
      `[shadow-core] shutdown: close still running after ${closeBudgetMs} ms (${[...running].join(", ") || "none"})` +
        `${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}; flushing`,
    );
    endClose();
  }, closeBudgetMs);

  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const cancel = setTimer(() => {
    if (exited) return;
    deps.log(`[shadow-core] shutdown: still running after ${timeoutMs} ms (${[...running].join(", ") || "none"}); exiting`);
    exitOnce();
    cancelBudget();
    endClose();
  }, timeoutMs);

  const step = async (s: ShutdownStep): Promise<void> => {
    running.add(s.name);
    try {
      await s.run();
    } catch (err) {
      deps.log(`[shadow-core] shutdown: ${s.name} failed: ${errText(err)}`);
    } finally {
      running.delete(s.name);
    }
  };

  const closing = (async () => {
    while (next < plan.close.length && !closeOver && !exited) {
      await step(plan.close[next++]!);
    }
  })();
  await Promise.race([closing, budget]);
  closeOver = true;
  cancelBudget();
  if (exited) return;
  // step() never rejects; allSettled keeps every flush running even so.
  await Promise.allSettled(plan.flush.map(step));
  cancel();
  exitOnce();
}
