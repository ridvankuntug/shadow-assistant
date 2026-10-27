/*
 * Adapted from adewaskar/jarvis (MIT) — Copyright (c) 2026 Aditya Dewaskar — see THIRD_PARTY_NOTICES.md
 *
 * Origin: the `phaseColor` palette in src/store.ts and the per-phase ring
 * spin table in src/scene/Scene.tsx, remapped to Shadow's five phases.
 */
import type { Phase } from "../assistant/state.ts";

/** One accent per phase, shared by the 3D scene and the 2D interface. */
export const PHASE_COLOR: Record<Phase, string> = {
  idle: "#12908f",
  listening: "#19d8d2",
  thinking: "#f0a93c",
  speaking: "#3ef2a8",
  awaiting_confirm: "#c17bff",
};

/** Rotation multiplier — the rings spin harder while Shadow is working. */
export const PHASE_SPIN: Record<Phase, number> = {
  idle: 0.25,
  listening: 1.1,
  thinking: 2.8,
  speaking: 1.4,
  awaiting_confirm: 0.9,
};
