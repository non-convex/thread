import { MacOSScrollAccel, type ScrollAcceleration } from "@opentui/core";

/** Windows-style default: three terminal rows per discrete wheel notch. */
export const WHEEL_SCROLL_BASE = 3;

/**
 * OpenTUI's default LinearScrollAccel moves one row per mouse-wheel event.
 * Terminal mouse protocols also report every notch as delta 1, so long
 * transcripts and document screens feel heavy. Scale each notch and keep a
 * modest burst multiplier for continuous flicks.
 */
export function createWheelScrollAcceleration(options?: {
  base?: number;
  maxMultiplier?: number;
}): ScrollAcceleration {
  const base = options?.base ?? WHEEL_SCROLL_BASE;
  const inner = new MacOSScrollAccel({
    A: 0.6,
    tau: 3,
    maxMultiplier: options?.maxMultiplier ?? 2.5,
  });
  return {
    tick(now?: number) {
      return base * inner.tick(now);
    },
    reset() {
      inner.reset();
    },
  };
}

export const wheelScrollAcceleration = createWheelScrollAcceleration();
