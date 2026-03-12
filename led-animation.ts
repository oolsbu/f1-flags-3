/**
 * LED Animation Engine
 *
 * Splits the LED strip into 3 configurable (non-equal) segments and runs
 * animations in a loop until explicitly stopped (i.e. when a new flag is
 * selected).
 *
 * ## Quick-start – creating a custom animation
 *
 * ```ts
 * import { defineAnimation, setFlagAnimation } from "./led-animation.ts";
 *
 * // 1. Define the animation
 * const myAnim = defineAnimation((ctx) => {
 *   // ctx.segments   – array of { start, length } for each segment
 *   // ctx.setPixel    – set a single LED: setPixel(index, 0xRRGGBB)
 *   // ctx.setSegment  – fill an entire segment: setSegment(segIndex, color)
 *   // ctx.flagColor   – the color associated with the current flag
 *   // ctx.tick         – increments every frame
 *   // ctx.elapsed      – milliseconds since the animation started
 *   // ctx.NUM_LEDS     – total number of LEDs on the strip
 *
 *   const on = Math.floor(ctx.tick / 10) % 2 === 0;
 *   ctx.setSegment(0, on ? ctx.flagColor : 0x000000);
 *   ctx.setSegment(1, on ? 0x000000 : ctx.flagColor);
 *   ctx.setSegment(2, on ? ctx.flagColor : 0x000000);
 * });
 *
 * // 2. Assign it to a flag (e.g. flag 2 = yellow)
 * setFlagAnimation(2, myAnim);
 * ```
 *
 * Any flag without a custom animation will display as a solid color.
 */

/* ── helpers re-exported from led-controller ── */
import {
  NUM_LEDS,
  FLAG_COLORS,
  setPixel,
  renderLeds,
} from "./led-controller.ts";

/* ── Segment configuration ── */

export interface Segment {
  start: number;
  length: number;
}

/** Default segments – 3 non-equal parts of 19 LEDs: 8 / 4 / 7 */
let segments: Segment[] = [
  { start: 0, length: 8 },
  { start: 8, length: 4 },
  { start: 12, length: 7 },
];

/** Reconfigure the segment layout. Lengths must sum to NUM_LEDS. */
export const setSegments = (segs: Segment[]) => {
  segments = segs;
};

export const getSegments = (): Segment[] => segments;

/* ── Animation context passed to every frame callback ── */

export interface AnimationContext {
  /** Frame counter (starts at 0, increments each frame). */
  tick: number;
  /** Milliseconds elapsed since the animation started. */
  elapsed: number;
  /** The three LED segments. */
  segments: Readonly<Segment[]>;
  /** Set a single LED by strip index (0-based). */
  setPixel: (index: number, color: number) => void;
  /** Fill every LED in a segment with one color. */
  setSegment: (segmentIndex: number, color: number) => void;
  /** The base color for the active flag. */
  flagColor: number;
  /** Total number of LEDs. */
  NUM_LEDS: number;
}

/* ── Animation type ── */

export type AnimationFn = (ctx: AnimationContext) => void;

/**
 * Convenience wrapper – simply returns the function you pass in.
 * Useful for documentation and IDE autocompletion.
 */
export const defineAnimation = (fn: AnimationFn): AnimationFn => fn;

/* ── Built-in animations ── */

/** Solid color (no animation – the default fallback). */
export const solidAnimation = defineAnimation((ctx) => {
  for (let i = 0; i < ctx.NUM_LEDS; i++) ctx.setPixel(i, ctx.flagColor);
});

/** All LEDs blink on/off together. `rate` = ticks per half-cycle. */
export const blinkAnimation = (rate = 15) =>
  defineAnimation((ctx) => {
    const on = Math.floor(ctx.tick / rate) % 2 === 0;
    const color = on ? ctx.flagColor : 0x000000;
    for (let i = 0; i < ctx.NUM_LEDS; i++) ctx.setPixel(i, color);
  });

/** Each segment blinks in turn while the others stay off. `rate` = ticks per step. */
export const alternateAnimation = (rate = 20) =>
  defineAnimation((ctx) => {
    const active = Math.floor(ctx.tick / rate) % ctx.segments.length;
    for (let s = 0; s < ctx.segments.length; s++) {
      ctx.setSegment(s, s === active ? ctx.flagColor : 0x000000);
    }
  });

/**
 * A single lit LED "flows" along the entire strip.
 * `speed` = how many ticks per step.
 */
export const flowAnimation = (speed = 3) =>
  defineAnimation((ctx) => {
    const pos = Math.floor(ctx.tick / speed) % ctx.NUM_LEDS;
    for (let i = 0; i < ctx.NUM_LEDS; i++) {
      ctx.setPixel(i, i === pos ? ctx.flagColor : 0x000000);
    }
  });

/**
 * A "chase" pattern – a window of lit LEDs moves along the strip.
 * `windowSize` = number of lit LEDs, `speed` = ticks per step.
 */
export const chaseAnimation = (windowSize = 4, speed = 3) =>
  defineAnimation((ctx) => {
    const head = Math.floor(ctx.tick / speed) % ctx.NUM_LEDS;
    for (let i = 0; i < ctx.NUM_LEDS; i++) {
      const dist = (i - head + ctx.NUM_LEDS) % ctx.NUM_LEDS;
      ctx.setPixel(i, dist < windowSize ? ctx.flagColor : 0x000000);
    }
  });

/**
 * Brightness pulses smoothly between dim and full.
 * `period` = ticks for one full cycle.
 */
export const pulseAnimation = (period = 60) =>
  defineAnimation((ctx) => {
    const phase = (ctx.tick % period) / period;
    const brightness = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
    const r = ((ctx.flagColor >> 16) & 0xff) * brightness;
    const g = ((ctx.flagColor >> 8) & 0xff) * brightness;
    const b = (ctx.flagColor & 0xff) * brightness;
    const color =
      ((Math.round(r) & 0xff) << 16) |
      ((Math.round(g) & 0xff) << 8) |
      (Math.round(b) & 0xff);
    for (let i = 0; i < ctx.NUM_LEDS; i++) ctx.setPixel(i, color);
  });

/**
 * Each segment pulses at a staggered phase offset.
 * `period` = ticks for one full cycle.
 */
export const segmentPulseAnimation = (period = 60) =>
  defineAnimation((ctx) => {
    for (let s = 0; s < ctx.segments.length; s++) {
      const offset = s / ctx.segments.length;
      const phase = ((ctx.tick % period) / period + offset) % 1;
      const brightness = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
      const r = ((ctx.flagColor >> 16) & 0xff) * brightness;
      const g = ((ctx.flagColor >> 8) & 0xff) * brightness;
      const b = (ctx.flagColor & 0xff) * brightness;
      const color =
        ((Math.round(r) & 0xff) << 16) |
        ((Math.round(g) & 0xff) << 8) |
        (Math.round(b) & 0xff);
      ctx.setSegment(s, color);
    }
  });

/* ── Per-flag animation registry ── */

const flagAnimations = new Map<number, AnimationFn>();

/** Assign an animation to a specific flag number. */
export const setFlagAnimation = (flag: number, anim: AnimationFn) => {
  flagAnimations.set(flag, anim);
};

/** Remove a custom animation (flag will revert to solid color). */
export const clearFlagAnimation = (flag: number) => {
  flagAnimations.delete(flag);
};

/* ── Animation loop ── */

const FRAME_INTERVAL_MS = 33; // ~30 fps

let loopTimer: ReturnType<typeof setInterval> | null = null;
let tick = 0;
let animStart = 0;

const buildContext = (): AnimationContext => ({
  tick,
  elapsed: Date.now() - animStart,
  segments,
  setPixel,
  setSegment: (segIndex, color) => {
    const seg = segments[segIndex];
    if (!seg) return;
    for (let i = seg.start; i < seg.start + seg.length; i++) {
      setPixel(i, color);
    }
  },
  flagColor: 0,
  NUM_LEDS,
});

const frame = (flagColor: number, anim: AnimationFn) => {
  const ctx = buildContext();
  ctx.flagColor = flagColor;
  anim(ctx);
  renderLeds();
  tick++;
};

/** Start (or restart) the animation loop for the given flag. */
export const startAnimation = (flag: number) => {
  stopAnimation();

  const color = FLAG_COLORS[flag] ?? 0x000000;
  const anim = flagAnimations.get(flag) ?? solidAnimation;
  tick = 0;
  animStart = Date.now();

  // Render the first frame immediately
  frame(color, anim);

  // For the solid animation there is no need for a recurring timer.
  if (anim === solidAnimation) return;

  loopTimer = setInterval(() => frame(color, anim), FRAME_INTERVAL_MS);
};

/** Stop the running animation loop (if any). */
export const stopAnimation = () => {
  if (loopTimer !== null) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  tick = 0;
};
