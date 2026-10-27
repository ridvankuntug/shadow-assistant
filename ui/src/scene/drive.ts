/*
 * Adapted from adewaskar/jarvis (MIT) — Copyright (c) 2026 Aditya Dewaskar — see THIRD_PARTY_NOTICES.md
 *
 * Origin: the `Drive` object in src/scene/Scene.tsx (reduced to the fields
 * Shadow uses; reactor overrides removed, confirm/motion added).
 */
import type * as THREE from "three";

/**
 * Per-frame values the scene children animate from, in one mutable object.
 * The Rig writes it once per frame and the children read it in their own
 * useFrame, so loudness never goes through React state (no 60 Hz re-renders).
 */
export type Drive = {
  color: THREE.Color;
  /** 0..1 smoothed loudness with an idle breath under it. */
  level: number;
  /** Phase spin multiplier. */
  spin: number;
  /** 0..1+ power-up reveal. */
  open: number;
  /** 0..1 awaiting-confirmation emphasis. */
  confirm: number;
  /** 1 normally; small when the user prefers reduced motion. */
  motion: number;
};
