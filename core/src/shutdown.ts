/**
 * Graceful-shutdown signal wiring. SIGINT (Ctrl+C), SIGTERM and SIGBREAK
 * (Windows Ctrl+Break; never raised elsewhere, so listening is harmless) all
 * run the same shutdown, once: a different signal arriving while the first
 * shutdown is still closing the server is ignored instead of starting another.
 * Each listener is `once`, as before: repeating the *same* signal (a second
 * Ctrl+C) falls back to Node's default and exits at once, the escape hatch for
 * a shutdown that hangs.
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
