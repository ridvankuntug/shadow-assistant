/*
 * Adapted from adewaskar/jarvis (MIT) — Copyright (c) 2026 Aditya Dewaskar — see THIRD_PARTY_NOTICES.md
 *
 * Origin: src/scene/Particles.tsx — a shell of soft points around the core
 * that loudness pushes outward. Changes: particle count comes from the quality
 * level, the orbit clock is accumulated and scaled by phase spin and the
 * reduced-motion factor, and the reactor intensity/visibility overrides were
 * removed.
 */
import { useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Drive } from "./drive.ts";

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uLevel;
  uniform float uSize;

  attribute float aSeed;
  attribute float aRadius;

  varying float vAlpha;

  void main() {
    float t = uTime * (0.06 + aSeed * 0.05);
    float c = cos(t), s = sin(t);
    vec3 p = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c);

    float push = 1.0 + uLevel * 0.35 + sin(uTime * 2.0 + aSeed * 12.0) * 0.02;
    p *= push;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Fade the far side so the cloud reads as volumetric.
    vAlpha = smoothstep(-11.5, -2.5, mv.z) * (0.30 + uLevel * 0.35) * (1.0 - aRadius * 0.55);
    gl_PointSize = uSize * (1.0 + uLevel * 0.7) * (13.0 / -mv.z);
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    float falloff = 1.0 - smoothstep(0.0, 0.5, r);
    gl_FragColor = vec4(uColor, vAlpha * falloff);
  }
`;

/** Small deterministic PRNG so the shell is stable across re-renders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeShell(count: number) {
  const random = mulberry32(0x5eed + count);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const radii = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Even distribution on a sphere, jittered into a shell.
    const u = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const radius = 1.9 + Math.pow(random(), 2) * 2.6;
    positions[i * 3] = Math.cos(theta) * r * radius;
    positions[i * 3 + 1] = u * radius;
    positions[i * 3 + 2] = Math.sin(theta) * r * radius;
    seeds[i] = random();
    radii[i] = (radius - 1.9) / 2.6;
  }
  return { positions, seeds, radii };
}

export function Particles({ drive, count }: { drive: RefObject<Drive>; count: number }) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  const { positions, seeds, radii } = useMemo(() => makeShell(count), [count]);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uSize: { value: 3.4 },
      uColor: { value: new THREE.Color("#00e5ff") },
    }),
    [],
  );

  useFrame((_, dt) => {
    if (!mat.current) return;
    const d = drive.current;
    const u = mat.current.uniforms;
    u.uTime.value += dt * (0.5 + d.spin * 0.5) * d.motion;
    u.uLevel.value += (d.level - u.uLevel.value) * Math.min(1, dt * 6);
    (u.uColor.value as THREE.Color).lerp(d.color, Math.min(1, dt * 3));
  });

  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aSeed" args={[seeds, 1]} />
        <bufferAttribute attach="attributes-aRadius" args={[radii, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={vertex}
        fragmentShader={fragment}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
}
