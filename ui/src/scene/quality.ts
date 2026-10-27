/**
 * 3D quality levels. Phones default to low (battery and heat); the user can
 * change it and the choice is stored through the platform adapter.
 */
import type { DeviceClass } from "../platform/types.ts";

export type Quality = "high" | "medium" | "low";

export const QUALITIES: readonly Quality[] = ["high", "medium", "low"];

export type QualityPreset = {
  /** Device pixel ratio range passed to the renderer ([min, max]). */
  dpr: [number, number];
  /** Number of dust particles around the core. */
  particles: number;
  /** fbm octaves in the core shader (the dominant per-pixel cost). */
  octaves: number;
  /** Bloom / chromatic aberration / vignette pass (lazy-loaded chunk). */
  postprocessing: boolean;
  antialias: boolean;
};

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  high: { dpr: [1, 2], particles: 4000, octaves: 5, postprocessing: true, antialias: true },
  medium: { dpr: [1, 1.5], particles: 1500, octaves: 4, postprocessing: false, antialias: true },
  low: { dpr: [0.75, 1], particles: 400, octaves: 3, postprocessing: false, antialias: false },
};

export function defaultQuality(deviceClass: DeviceClass): Quality {
  switch (deviceClass) {
    case "phone":
      return "low";
    case "tablet":
      return "medium";
    case "desktop":
      return "high";
  }
}

export function isQuality(value: unknown): value is Quality {
  return typeof value === "string" && (QUALITIES as readonly string[]).includes(value);
}

/** The stored choice if valid, otherwise the device default. */
export function resolveQuality(stored: string | null, deviceClass: DeviceClass): Quality {
  return isQuality(stored) ? stored : defaultQuality(deviceClass);
}
