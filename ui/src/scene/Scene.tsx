/*
 * Adapted from adewaskar/jarvis (MIT) — Copyright (c) 2026 Aditya Dewaskar — see THIRD_PARTY_NOTICES.md
 *
 * Origin: src/scene/Scene.tsx — the Canvas, the per-frame Rig that smooths
 * phase colour/spin/loudness into a shared Drive object, the idle breath and
 * the slow camera drift. Changes: driven by Shadow's five phases and a level
 * callback (platform adapter) instead of the Jarvis store; quality presets
 * (dpr, particles, shader octaves, lazy postprocessing); the render loop stops
 * while the app is in the background; reduced-motion support; orbits, reactor
 * overrides and UI effects were not taken.
 */
import { Suspense, lazy, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Phase } from "../assistant/state.ts";
import { Core } from "./Core.tsx";
import type { Drive } from "./drive.ts";
import { Particles } from "./Particles.tsx";
import { PHASE_COLOR, PHASE_SPIN } from "./phaseStyle.ts";
import { QUALITY_PRESETS, type Quality } from "./quality.ts";

const Effects = lazy(() => import("./Effects.tsx"));

/** Motion multiplier when the user prefers reduced motion. */
const REDUCED_MOTION = 0.15;

export type SceneProps = {
  phase: Phase;
  quality: Quality;
  /** false while the app is in the background: the render loop stops. */
  active: boolean;
  reducedMotion: boolean;
  /** 0..1 loudness (mic while listening, playback while speaking). Called every frame. */
  level: () => number;
};

function Rig({ phase, reducedMotion, level, quality }: Omit<SceneProps, "active">) {
  const preset = QUALITY_PRESETS[quality];
  // A ref, not state: written every frame, never rendered.
  const driveRef = useRef<Drive>({
    color: new THREE.Color(PHASE_COLOR.idle),
    level: 0,
    spin: PHASE_SPIN.idle,
    open: 0,
    confirm: 0,
    motion: 1,
  });
  const target = useMemo(() => new THREE.Color(), []);

  useFrame((state, dt) => {
    const drive = driveRef.current;
    // Background tabs can hand back a huge dt on the first frame after resume.
    const step = Math.min(dt, 0.1);
    drive.motion = reducedMotion ? REDUCED_MOTION : 1;
    target.set(PHASE_COLOR[phase]);
    drive.color.lerp(target, Math.min(1, step * 2.5));
    drive.spin += (PHASE_SPIN[phase] - drive.spin) * Math.min(1, step * 2);
    drive.open = 1.6;
    drive.confirm = phase === "awaiting_confirm" ? 1 : 0;

    const t = state.clock.elapsedTime;
    const idle = phase === "idle" ? 0.05 : 0.12;
    const breathe = reducedMotion ? idle * 0.5 : (Math.sin(t * 0.9) * 0.5 + 0.5) * idle;
    const live = phase === "listening" || phase === "speaking" ? level() : 0;
    const want = Math.max(reducedMotion ? live * 0.4 : live, breathe);
    drive.level += (want - drive.level) * Math.min(1, step * 9);

    // Slow drift keeps handheld-ish life in the shot; off for reduced motion.
    if (!reducedMotion) {
      state.camera.position.x = Math.sin(t * 0.13) * 0.35;
      state.camera.position.y = Math.cos(t * 0.17) * 0.22;
    }
    state.camera.lookAt(0, 0, 0);
  });

  return (
    <>
      <Core drive={driveRef} octaves={preset.octaves} />
      <Particles drive={driveRef} count={preset.particles} />
    </>
  );
}

export default function Scene({ phase, quality, active, reducedMotion, level }: SceneProps) {
  const preset = QUALITY_PRESETS[quality];
  return (
    // Keyed by quality: antialias is fixed at context creation and the shader
    // octave count is a compile-time define, so a quality change remounts.
    <Canvas
      key={quality}
      className="scene-canvas"
      camera={{ position: [0, 0, 6.2], fov: 45 }}
      gl={{ antialias: preset.antialias, alpha: true, powerPreference: quality === "high" ? "high-performance" : "low-power" }}
      dpr={preset.dpr}
      frameloop={active ? "always" : "never"}
      aria-hidden="true"
    >
      <Rig phase={phase} quality={quality} reducedMotion={reducedMotion} level={level} />
      {preset.postprocessing && (
        <Suspense fallback={null}>
          <Effects />
        </Suspense>
      )}
    </Canvas>
  );
}
