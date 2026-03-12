import { createRequire } from "node:module";

export const NUM_LEDS = 19;
const TICK_MS = 40; // ~25 fps for smooth animations
const BLINK_TICKS = 12; // blink toggles every 12 ticks (~480 ms)

const require = createRequire(import.meta.url);

const COLOR_OFF = 0x000000;
const COLOR_WHITE = 0xffffff;
const COLOR_GREEN = 0x00c853;
const COLOR_YELLOW = 0xffea00;
const COLOR_RED = 0xff1744;
const COLOR_ORANGE = 0xff9100;
const COLOR_VSC = 0xe040fb;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SegmentMode = "off" | "static" | "flowing" | "blink";

export interface SegmentConfig {
  color: number;
  mode: SegmentMode;
  /** Segments sharing the same blinkGroup blink in sync; different groups alternate. */
  blinkGroup?: number;
}

export interface FlagConfig {
  /** "per_segment" — each segment has its own config.
   *  "blink_sequential" — segments light one at a time in order. */
  type: "per_segment" | "blink_sequential";
  /** Colour used by blink_sequential mode. */
  color?: number;
  /** Per-segment configs [seg0, seg1, seg2] for per_segment mode. */
  segments?: [SegmentConfig, SegmentConfig, SegmentConfig];
}

// ---------------------------------------------------------------------------
// Segment definitions
// ---------------------------------------------------------------------------
// Seg 0: LEDs 1-5 (forward) ↔ 16-19 (backward / mirrored)
// Seg 1: LEDs 6-8 (standalone, no mirror)
// Seg 2: LEDs 9-11 (forward) ↔ 12-15 (backward / mirrored)

interface Segment {
  forward: number[];
  backward: number[];
}

const SEGMENTS: Segment[] = [
  { forward: [0, 1, 2, 3, 4], backward: [18, 17, 16, 15] },
  { forward: [5, 6, 7], backward: [] },
  { forward: [8, 9, 10], backward: [14, 13, 12, 11] },
];

// ---------------------------------------------------------------------------
// Flag lookup
// ---------------------------------------------------------------------------

const IGNORED_FLAG = -1;

export const FLAG_COLORS: Record<number, number> = {
  0: COLOR_OFF,
  1: COLOR_GREEN,
  2: COLOR_YELLOW,
  3: COLOR_RED,
  4: COLOR_ORANGE,
  5: COLOR_VSC,
};

const FLAG_NAME_TO_NUMBER: Record<string, number> = {
  CLEAR: 0,
  GREEN: 1,
  YELLOW: 2,
  "DOUBLE YELLOW": 2,
  RED: 3,
  "SAFETY CAR": 4,
  SC: 4,
  VSC: 5,
  "VIRTUAL SAFETY CAR": 5,
  BLUE: IGNORED_FLAG,
};

// ---------------------------------------------------------------------------
// Flag → animation config
// ---------------------------------------------------------------------------

export const FLAG_CONFIGS: Record<number, FlagConfig> = {
  // CLEAR / idle — red flowing trails on mirrored segments, white static on center
  0: {
    type: "per_segment",
    segments: [
      { color: COLOR_RED, mode: "flowing" },
      { color: COLOR_WHITE, mode: "static" },
      { color: COLOR_RED, mode: "flowing" },
    ],
  },
  // GREEN — stays green until a new flag is received
  1: {
    type: "per_segment",
    segments: [
      { color: COLOR_GREEN, mode: "flowing" },
      { color: COLOR_GREEN, mode: "flowing" },
      { color: COLOR_GREEN, mode: "flowing" },
    ],
  },
  // YELLOW — flowing
  2: {
    type: "per_segment",
    segments: [
      { color: COLOR_YELLOW, mode: "flowing" },
      { color: COLOR_YELLOW, mode: "flowing" },
      { color: COLOR_YELLOW, mode: "flowing" },
    ],
  },
  // RED — full blink
  3: {
    type: "per_segment",
    segments: [
      { color: COLOR_RED, mode: "blink", blinkGroup: 0 },
      { color: COLOR_RED, mode: "blink", blinkGroup: 0 },
      { color: COLOR_RED, mode: "blink", blinkGroup: 0 },
    ],
  },
  // SAFETY CAR — mirrored segments blink together, standalone blinks on the opposite phase
  4: {
    type: "per_segment",
    segments: [
      { color: COLOR_ORANGE, mode: "blink", blinkGroup: 0 },
      { color: COLOR_ORANGE, mode: "blink", blinkGroup: 1 },
      { color: COLOR_ORANGE, mode: "blink", blinkGroup: 0 },
    ],
  },
  // VSC — each segment blinks one at a time in order
  5: { type: "blink_sequential", color: COLOR_VSC },
};

/** Update the animation config for a flag at runtime. */
export const updateFlagConfig = (flagCode: number, config: FlagConfig) => {
  FLAG_CONFIGS[flagCode] = config;
};

// ---------------------------------------------------------------------------
// Hardware init
// ---------------------------------------------------------------------------

let render: (() => void) | null = null;
let reset: (() => void) | null = null;
let pixelData: Uint32Array = new Uint32Array(NUM_LEDS);

export const initLeds = () => {
  const errors: string[] = [];

  try {
    const ws281x = require("rpi-ws281x");
    ws281x.configure({ leds: NUM_LEDS, gpio: 18, brightness: 128 });
    pixelData = new Uint32Array(NUM_LEDS);
    render = () => ws281x.render(pixelData);
    reset = () => ws281x.reset();
    console.log(`[LED] Initialized ${NUM_LEDS} LEDs on GPIO 18 via rpi-ws281x`);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`rpi-ws281x: ${message}`);
  }

  try {
    const ws281x = require("rpi-ws281x-native");
    const channel = ws281x(NUM_LEDS, { gpio: 18, brightness: 128 });
    pixelData = channel.array;
    render = () => ws281x.render();
    reset = () => ws281x.reset();
    console.log(
      `[LED] Initialized ${NUM_LEDS} LEDs on GPIO 18 via rpi-ws281x-native`,
    );
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`rpi-ws281x-native: ${message}`);
  }

  console.warn(
    "[LED] No hardware LED driver available — running in simulation mode",
  );
};

/* ── Low-level helpers used externally ── */

/** Set a single LED by index (does NOT render – call renderLeds() after). */
export const setPixel = (index: number, color: number) => {
  if (index >= 0 && index < NUM_LEDS) pixelData[index] = color;
};

/** Push the current pixelData to the hardware. */
export const renderLeds = () => {
  render?.();
};

/** Fill every LED with the same color and render. */
export const fillAll = (color: number) => {
  pixelData.fill(color);
  render?.();
};

// ---------------------------------------------------------------------------
// Animation engine
// ---------------------------------------------------------------------------

let animationTimer: ReturnType<typeof setInterval> | null = null;
let animationStep = 0;

const stopAnimation = () => {
  if (animationTimer !== null) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
  animationStep = 0;
};

/** Linearly interpolate between two RGB colours. t = 0→a, t = 1→b. */
const lerpColor = (a: number, b: number, t: number): number => {
  const ra = (a >> 16) & 0xff,
    ga = (a >> 8) & 0xff,
    ba = a & 0xff;
  const rb = (b >> 16) & 0xff,
    gb = (b >> 8) & 0xff,
    bb = b & 0xff;
  const r = Math.round(ra + (rb - ra) * t);
  const g = Math.round(ga + (gb - ga) * t);
  const bl = Math.round(ba + (bb - ba) * t);
  return (r << 16) | (g << 8) | bl;
};

// ---- per_segment ----------------------------------------------------------
// The flowing animation now uses a continuous floating-point position
// with a smooth gaussian-ish falloff so the colour fades gradually from
// LED to LED instead of jumping.

/** Number of TICK_MS ticks it takes for the head to travel one LED. */
const FLOW_TICKS_PER_LED = 6;

/** How wide the glow trail is expressed in LED-widths. */
const FLOW_TRAIL_WIDTH = 2.5;

/** Gaussian-like brightness falloff: 1 at dist=0, fading toward 0. */
const glowFalloff = (dist: number): number => {
  if (dist > FLOW_TRAIL_WIDTH) return 0;
  const x = dist / FLOW_TRAIL_WIDTH;
  return Math.max(0, 1 - x * x);
};

const animatePerSegment = (
  segConfigs: [SegmentConfig, SegmentConfig, SegmentConfig],
) => {
  let blinkOn = true;

  const tick = () => {
    if (animationStep > 0 && animationStep % BLINK_TICKS === 0) {
      blinkOn = !blinkOn;
    }

    for (let i = 0; i < SEGMENTS.length; i++) {
      const cfg = segConfigs[i];
      const seg = SEGMENTS[i];
      const allLeds = [...seg.forward, ...seg.backward];

      switch (cfg.mode) {
        case "static":
          for (const led of allLeds) pixelData[led] = cfg.color;
          break;

        case "off":
          for (const led of allLeds) pixelData[led] = COLOR_OFF;
          break;

        case "flowing": {
          for (const arr of [seg.forward, seg.backward]) {
            if (arr.length === 0) continue;
            // Continuous head position (wraps smoothly)
            const headPos = (animationStep / FLOW_TICKS_PER_LED) % arr.length;
            for (let j = 0; j < arr.length; j++) {
              // Shortest distance around the loop
              let dist = headPos - j;
              if (dist < 0) dist += arr.length;
              if (dist > arr.length / 2) dist = arr.length - dist;
              const brightness = glowFalloff(dist);
              pixelData[arr[j]] = lerpColor(COLOR_OFF, cfg.color, brightness);
            }
          }
          break;
        }

        case "blink": {
          const group = cfg.blinkGroup ?? 0;
          const isOn = group === 0 ? blinkOn : !blinkOn;
          for (const led of allLeds) {
            pixelData[led] = isOn ? cfg.color : COLOR_OFF;
          }
          break;
        }
      }
    }

    render?.();
    animationStep++;
  };

  tick();
  animationTimer = setInterval(tick, TICK_MS);
};

// ---- blink_sequential -----------------------------------------------------

const animateBlinkSequential = (color: number) => {
  const tick = () => {
    pixelData.fill(COLOR_OFF);
    const segIdx = animationStep % SEGMENTS.length;
    const seg = SEGMENTS[segIdx];
    for (const led of [...seg.forward, ...seg.backward]) {
      pixelData[led] = color;
    }
    render?.();
    animationStep++;
  };

  tick();
  animationTimer = setInterval(tick, 400);
};

// ---------------------------------------------------------------------------
// Start a flag config
// ---------------------------------------------------------------------------

const startConfig = (config: FlagConfig) => {
  stopAnimation();

  switch (config.type) {
    case "per_segment":
      if (config.segments) animatePerSegment(config.segments);
      break;
    case "blink_sequential":
      animateBlinkSequential(config.color ?? COLOR_WHITE);
      break;
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const normalizeFlag = (flag: number | string): number => {
  if (typeof flag === "number" && Number.isFinite(flag)) return flag;
  const normalized = String(flag).trim().toUpperCase();
  return FLAG_NAME_TO_NUMBER[normalized] ?? 0;
};

export const setFlag = (flag: number | string) => {
  const normalizedFlag = normalizeFlag(flag);

  if (normalizedFlag === IGNORED_FLAG) {
    console.log(`[LED] Flag ${String(flag)} → ignored`);
    return;
  }

  const config: FlagConfig = FLAG_CONFIGS[normalizedFlag] ?? {
    type: "per_segment" as const,
    segments: [
      { color: COLOR_OFF, mode: "static" as const },
      { color: COLOR_OFF, mode: "static" as const },
      { color: COLOR_OFF, mode: "static" as const },
    ],
  };

  startConfig(config);
  console.log(
    `[LED] Flag ${String(flag)} (code ${normalizedFlag}) → type=${config.type}`,
  );
};

export const resetLeds = () => {
  stopAnimation();
  pixelData.fill(0);
  render?.();
  reset?.();
  console.log("[LED] Reset");
};

// new commit
