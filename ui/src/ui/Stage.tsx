import { Component, Suspense, lazy, type ReactNode } from "react";
import type { Phase } from "../assistant/state.ts";
import type { SceneProps } from "../scene/Scene.tsx";
import { PHASE_LABEL } from "./strings.ts";

// The 3D scene (three.js) is a separate chunk: the interface is usable before
// it arrives, and hosts without WebGL never download it.
const Scene = lazy(() => import("../scene/Scene.tsx"));

let webglCache: boolean | null = null;
function hasWebGL(): boolean {
  if (webglCache !== null) return webglCache;
  try {
    const canvas = document.createElement("canvas");
    webglCache = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    webglCache = false;
  }
  return webglCache;
}

/** CSS-only orb used while the scene loads and when WebGL is unavailable. */
function FallbackOrb() {
  return <div className="orb-fallback" aria-hidden="true" />;
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn("[shadow] 3D scene failed, using the fallback orb:", err);
  }
  render() {
    return this.state.failed ? <FallbackOrb /> : this.props.children;
  }
}

export function Stage(props: SceneProps & { phase: Phase }) {
  const webgl = hasWebGL();
  return (
    <section className="stage" aria-label="Durum">
      <div className="stage-visual">
        {webgl ? (
          <SceneBoundary>
            <Suspense fallback={<FallbackOrb />}>
              <Scene {...props} />
            </Suspense>
          </SceneBoundary>
        ) : (
          <FallbackOrb />
        )}
      </div>
      <p className="phase-label" role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        {PHASE_LABEL[props.phase]}
      </p>
    </section>
  );
}
