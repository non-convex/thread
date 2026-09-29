import { MacOSScrollAccel, type ScrollAcceleration } from "@opentui/core";

/**
 * OpenTUI's default LinearScrollAccel moves one row per mouse-wheel event.
 * Terminal mouse protocols also report every notch as delta 1, so long
 * transcripts and document screens feel heavy. Scale each notch to three rows
 * (the Windows default) and keep a modest burst multiplier for continuous flicks.
 */
const inner = new MacOSScrollAccel({ A: 0.6, tau: 3, maxMultiplier: 2.5 });

export const wheelScrollAcceleration: ScrollAcceleration = {
  tick: (now?: number) => 3 * inner.tick(now),
  reset: () => inner.reset(),
};
