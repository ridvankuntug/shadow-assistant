/*
 * Adapted from adewaskar/jarvis (MIT) — Copyright (c) 2026 Aditya Dewaskar — see THIRD_PARTY_NOTICES.md
 *
 * Origin: the EffectComposer chain in src/scene/Scene.tsx (bloom, chromatic
 * aberration, vignette). Film-grain noise was dropped. Lazy-loaded so only
 * the "high" quality level pays for the postprocessing library.
 */
import { useMemo } from "react";
import { Bloom, ChromaticAberration, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

export default function Effects() {
  const offset = useMemo(() => new THREE.Vector2(0.0009, 0.0012), []);
  // multisampling 0: the scene is additive soft blobs and points; MSAA buys
  // nothing and costs a large half-float target.
  return (
    <EffectComposer multisampling={0}>
      <Bloom intensity={1.15} luminanceThreshold={0.22} luminanceSmoothing={0.85} mipmapBlur radius={0.72} />
      <ChromaticAberration offset={offset} radialModulation={false} modulationOffset={0} />
      <Vignette eskil={false} offset={0.22} darkness={0.95} />
    </EffectComposer>
  );
}
