/**
 * Model routing and usage hook (T7 extension point).
 *
 * v1 ships only the pass-through router: every turn uses the configured
 * CORE_MODEL and usage is merely recorded. T7 can replace `Router` with a
 * cheaper-model-first policy without touching the session code.
 */

export interface RouteInput {
  text: string;
  source: "text" | "voice";
  device: string;
}

export interface RouteDecision {
  model: string;
}

export interface UsageRecord {
  turnId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd?: number;
}

export interface Router {
  route(input: RouteInput): RouteDecision | Promise<RouteDecision>;
  onUsage?(usage: UsageRecord): void;
}

export class PassthroughRouter implements Router {
  constructor(private readonly model: string) {}

  route(): RouteDecision {
    return { model: this.model };
  }

  onUsage(): void {
    // Recorded by the session log; nothing else to do in v1.
  }
}
