/*
 * Adapted from adewaskar/jarvis (MIT) — Copyright (c) 2026 Aditya Dewaskar — see THIRD_PARTY_NOTICES.md
 *
 * Origin: src/scene/Core.tsx — the reactor ring drawn as one camera-facing
 * quad with a polar fragment shader. Changes: the ring/sphere/wire style
 * weights and the per-reactor scale/intensity overrides were removed, the fbm
 * octave count is a compile-time define driven by the quality level, and the
 * phase speed is scaled by the motion factor (prefers-reduced-motion).
 */
import { useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Drive } from "./drive.ts";

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  uniform vec3  uColor;
  uniform vec3  uHot;
  uniform float uLevel;
  uniform float uPhase;
  uniform float uOpen;
  uniform float uZoom;
  uniform float uConfirm;

  varying vec2 vUv;

  vec2 hash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(dot(hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
          dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
      mix(dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
          dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
      u.y);
  }

  // OCTAVES comes from the material defines (quality level).
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < OCTAVES; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  float band(float r, float r0, float w) {
    return exp(-pow((r - r0) / w, 2.0));
  }

  #define TAU 6.28318530718

  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * uZoom;
    float r = length(p);
    float a = atan(p.y, p.x);
    // Turbulence sampled on the unit circle stays continuous across the seam.
    vec2 ring = vec2(cos(a), sin(a));

    // A wandering, eroded rim — the dusty breathing edge is the character.
    float wob   = fbm(ring * 2.6 + vec2(uPhase * 0.22, 0.0)) * 0.055;
    float grain = fbm(ring * 9.0 - vec2(uPhase * 0.4, 0.0)) * 0.020;
    float R = 0.74 + wob + grain + uLevel * 0.03;
    float erode = smoothstep(-0.25, 0.35, fbm(ring * 5.0 + vec2(uPhase * 0.5, 3.0)));

    float outer = band(r, R, 0.030) * (0.45 + erode * 0.6);
    float wall  = band(r, R - 0.055, 0.020) * 0.5;
    float edge  = band(r, R + 0.004, 0.007) * (0.5 + uLevel * 0.45);

    float speck = fbm(ring * 46.0 + vec2(uPhase * 0.15, 11.0));
    speck = pow(max(speck, 0.0), 3.0);
    float dust = speck * band(r, R + 0.028, 0.055) * (1.4 + uLevel);

    // Radar sweep with an eased wake.
    float sweepA = mod(uPhase * 0.55, TAU);
    float dA = mod(a - sweepA + TAU + 3.14159, TAU) - 3.14159;
    float wake = smoothstep(-2.6, -0.15, dA) * (1.0 - smoothstep(0.0, 0.22, dA));
    float radar = wake * band(r, R - 0.02, 0.075) * (0.55 + uLevel * 0.45);

    float lines =
        band(r, 0.615, 0.0035) * 0.45
      + band(r, 0.560, 0.0030) * 0.28
      + band(r, 0.470, 0.0035) * 0.36;

    // Counter-rotating polar meshes: the woven core membrane.
    float m1 = (sin(a * 96.0 + uPhase * 0.6) * 0.5 + 0.5) * (sin(r * 210.0) * 0.5 + 0.5);
    float m2 = (sin(a * 60.0 - uPhase * 0.4) * 0.5 + 0.5) * (sin(r * 150.0 - uPhase) * 0.5 + 0.5);
    float mesh = mix(m1, m2, 0.5);
    float core = smoothstep(0.40, 0.36, r);
    float coreTex = core * (0.04 + mesh * 0.12) * (0.55 + uLevel * 0.9);
    float coreEdge = band(r, 0.385, 0.010) * (0.55 + uLevel * 0.5);
    float pulse = band(r, fract(uPhase * 0.08) * 0.40, 0.020) * core * 0.45;
    float bloom = exp(-r * 3.4) * (0.16 + uLevel * 0.34);

    // Awaiting confirmation: a slow attention ring outside the rim.
    float attention = uConfirm * band(r, R + 0.09, 0.012) * (0.5 + 0.5 * sin(uPhase * 2.4));

    float v = (outer + wall + edge + coreEdge) + dust + radar + lines + coreTex + pulse + bloom + attention;
    vec3 col = mix(uColor, uHot, clamp(edge * 1.3 + radar * 0.7 + pulse * 0.5 + dust * 0.4, 0.0, 1.0));

    // Radial reveal: the ring assembles from the centre outward.
    v *= smoothstep(0.0, 0.35, uOpen - r * 0.45);
    gl_FragColor = vec4(col * v, v);
  }
`;

const HALF = 2.7;
const RING_R = 0.74;
/** Ring diameter as a fraction of the shorter viewport side. */
const FIT = 0.6;

export function Core({ drive, octaves }: { drive: RefObject<Drive>; octaves: number }) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  const viewport = useThree((s) => s.viewport);

  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color("#19c4c4") },
      uHot: { value: new THREE.Color("#c9fdff") },
      uLevel: { value: 0 },
      uPhase: { value: 0 },
      uOpen: { value: 0 },
      uZoom: { value: 1.2 },
      uConfirm: { value: 0 },
    }),
    [],
  );
  const defines = useMemo(() => ({ OCTAVES: Math.max(1, Math.round(octaves)) }), [octaves]);

  useFrame((_, dt) => {
    if (!mat.current) return;
    const d = drive.current;
    const u = mat.current.uniforms;
    const fit = Math.min(viewport.width, viewport.height);
    u.uZoom.value = (RING_R * HALF) / (FIT * 0.5 * fit);
    u.uLevel.value += (d.level - u.uLevel.value) * Math.min(1, dt * 8);
    // Accumulated rather than derived from elapsed time, so a speed change
    // never rewrites turbulence that already happened.
    u.uPhase.value += dt * (0.5 + u.uLevel.value * 0.7) * (0.6 + d.spin * 0.4) * d.motion;
    u.uOpen.value += (d.open - u.uOpen.value) * Math.min(1, dt * 1.6);
    u.uConfirm.value += (d.confirm - u.uConfirm.value) * Math.min(1, dt * 3);
    (u.uColor.value as THREE.Color).lerp(d.color, Math.min(1, dt * 2.5));
  });

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[5.4, 5.4]} />
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        defines={defines}
        vertexShader={vertex}
        fragmentShader={fragment}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  );
}
