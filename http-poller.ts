import {
  broadcastFlag,
  broadcastProgress,
  broadcastTimeline,
} from "./socket.ts";
import { setFlag as setLedFlag } from "./led-controller.ts";
import { startAnimation, stopAnimation } from "./led-animation.ts";
import { startSignalR, stopSignalR } from "./signalr-client.ts";
import type { RaceControl } from "./types/race_control.ts";
import type {
  PollerStatus,
  ReplaySession,
  ReplayTimeline,
} from "./types/socket.ts";

const API = "https://api.openf1.org/v1/race_control";
const SESSIONS_API = "https://api.openf1.org/v1/sessions";
const MEETINGS_API = "https://api.openf1.org/v1/meetings";

type Mode = "live" | "replay";

let mode: Mode | null = null;
let timerId: ReturnType<typeof setInterval> | null = null;
let lastFlag: number | null = null;
let currentLiveDelayMs = 30000;
let currentSessionKey: string | undefined;
let currentReplayDurationMs: number | undefined;
let currentTimeline: ReplayTimeline | null = null;
let currentReplayProgress = 0;

// Replay state
let replayEvents: { flag: number; delayMs: number }[] = [];
let replayTotalMs = 0;
let replayFirstTimestamp = 0;
let replayRealSpanMs = 0;
let replayIndex = 0;
let replayStartMs = 0;
let replayElapsedMs = 0;
let replayPlaying = false;

interface OpenF1Session {
  session_key: number;
  meeting_key?: number;
  session_type?: string;
  session_name: string;
  location?: string;
  country_name?: string;
  year?: number;
  date_start: string;
}

interface OpenF1Meeting {
  meeting_key: number;
  meeting_name?: string;
  meeting_official_name?: string;
}

const parseReplayFlag = (item: RaceControl): number | null => {
  const flag = String(item.flag ?? "").trim().toUpperCase();
  const msg = item.message.toUpperCase();

  // Remove blue flags from replay data regardless of source format.
  if (flag === "BLUE" || msg.includes("BLUE FLAG")) return null;

  if (msg.includes("VIRTUAL SAFETY CAR") || msg.includes("VSC")) return 5;
  if (msg.includes("SAFETY CAR")) return 4;

  switch (flag) {
    case "1":
    case "GREEN":
    case "CLEAR":
    case "CHEQUERED":
      return 1;
    case "2":
    case "YELLOW":
    case "DOUBLE YELLOW":
      return 2;
    case "3":
    case "RED":
      return 3;
    case "4":
    case "SAFETY CAR":
    case "SC":
      return 4;
    case "5":
    case "VSC":
    case "VIRTUAL SAFETY CAR":
      return 5;
    default:
      return null;
  }
};

const emitIfChanged = (flag: number) => {
  if (flag !== lastFlag) {
    lastFlag = flag;
    broadcastFlag(flag);
    startAnimation(flag);
  }
};

const clear = () => {
  if (timerId) clearInterval(timerId);
  timerId = null;
  stopSignalR();
  mode = null;
  lastFlag = null;
  replayEvents = [];
  replayIndex = 0;
  replayPlaying = false;
  replayTotalMs = 0;
  replayFirstTimestamp = 0;
  replayRealSpanMs = 0;
  currentSessionKey = undefined;
  currentReplayDurationMs = undefined;
  currentTimeline = null;
  currentReplayProgress = 0;
  stopAnimation();
  setLedFlag(0);
};

const tickReplay = () => {
  if (!replayPlaying) return;
  const elapsed = Date.now() - replayStartMs;

  while (
    replayIndex < replayEvents.length &&
    replayEvents[replayIndex].delayMs <= elapsed
  ) {
    emitIfChanged(replayEvents[replayIndex].flag);
    replayIndex++;
  }

  // Broadcast progress (0–1)
  if (replayTotalMs > 0) {
    currentReplayProgress = Math.min(1, elapsed / replayTotalMs);
    broadcastProgress(currentReplayProgress);
  }

  if (replayIndex >= replayEvents.length) {
    if (timerId) clearInterval(timerId);
    timerId = null;
    replayPlaying = false;
    mode = null;
    currentReplayProgress = 1;
    broadcastProgress(1);
  }
};

/* ── Live mode: SignalR WebSocket with broadcast delay buffer ── */

const startLive = (liveDelayMs: number) => {
  mode = "live";
  currentLiveDelayMs = liveDelayMs;
  startSignalR({
    delayMs: liveDelayMs,
    onFlag: (flag) => emitIfChanged(flag),
  });
};

/* ── Replay mode: OpenF1 API with time-scaled playback ── */

const startReplay = async (sessionKey: string, durationMs?: number) => {
  mode = "replay";
  currentSessionKey = sessionKey;
  currentReplayDurationMs = durationMs;

  try {
    const res = await fetch(
      `${API}?session_key=${encodeURIComponent(sessionKey)}`,
    );
    if (!res.ok) return;

    const items = (await res.json()) as RaceControl[];
    const flags = items
      .map((i) => ({ flag: parseReplayFlag(i), ts: Date.parse(i.date) }))
      .filter((i): i is { flag: number; ts: number } => i.flag !== null)
      .sort((a, b) => a.ts - b.ts);

    if (!flags.length) return;

    const span = flags[flags.length - 1].ts - flags[0].ts || 1;
    const target = durationMs && durationMs > 0 ? durationMs : span;
    replayTotalMs = target;
    replayFirstTimestamp = flags[0].ts;
    replayRealSpanMs = span;

    replayEvents = flags.map((e) => ({
      flag: e.flag,
      delayMs: ((e.ts - flags[0].ts) / span) * target,
    }));

    const timeline: ReplayTimeline = {
      events: replayEvents.map((e) => ({
        flag: e.flag,
        position: replayTotalMs > 0 ? e.delayMs / replayTotalMs : 0,
      })),
      firstTimestamp: replayFirstTimestamp,
      realSpanMs: replayRealSpanMs,
      totalDurationMs: replayTotalMs,
    };
    currentTimeline = timeline;
    broadcastTimeline(timeline);

    replayIndex = 0;
    replayStartMs = Date.now();
    replayElapsedMs = 0;
    replayPlaying = true;
    currentReplayProgress = 0;

    tickReplay();
    timerId = setInterval(tickReplay, 100);
  } catch (err) {
    console.error("Replay fetch failed:", err);
  }
};

export const startHttpPoller = ({
  mode: m,
  sessionKey,
  liveDelayMs = 30000,
  replayDurationMs,
}: {
  mode: Mode;
  sessionKey?: string;
  liveDelayMs?: number;
  replayDurationMs?: number;
}) => {
  // Avoid restarting upstream clients when the requested config already runs.
  if (
    mode === m &&
    ((m === "live" && currentLiveDelayMs === liveDelayMs) ||
      (m === "replay" &&
        currentSessionKey === sessionKey &&
        currentReplayDurationMs === replayDurationMs))
  ) {
    return;
  }

  clear();
  if (m === "replay" && sessionKey) {
    startReplay(sessionKey, replayDurationMs);
  } else {
    startLive(liveDelayMs);
  }
};

export const stopHttpPoller = clear;

export const pauseReplayPoller = () => {
  if (!replayPlaying) return;
  replayElapsedMs = Date.now() - replayStartMs;
  replayPlaying = false;
};

export const playReplayPoller = () => {
  if (replayPlaying || !replayEvents.length) return;
  replayStartMs = Date.now() - replayElapsedMs;
  replayPlaying = true;
  mode = "replay";
  if (!timerId) timerId = setInterval(tickReplay, 100);
};

export const seekReplayPoller = (position: number) => {
  if (!replayEvents.length || replayTotalMs <= 0) return;

  const targetMs = Math.max(0, Math.min(1, position)) * replayTotalMs;
  replayElapsedMs = targetMs;
  replayStartMs = Date.now() - targetMs;

  // Find the right index
  replayIndex = 0;
  lastFlag = null;
  for (let i = 0; i < replayEvents.length; i++) {
    if (replayEvents[i].delayMs <= targetMs) {
      replayIndex = i + 1;
      lastFlag = replayEvents[i].flag;
    } else break;
  }

  if (lastFlag !== null) {
    broadcastFlag(lastFlag);
    startAnimation(lastFlag);
  }
  currentReplayProgress = position;
  broadcastProgress(position);
};

// If was playing, keep ticking
if (replayPlaying) {
  tickReplay();
}

export const getHttpPollerStatus = (): PollerStatus => ({
  running: mode !== null,
  mode: mode ?? undefined,
  replayPlaying: mode === "replay" ? replayPlaying : undefined,
  liveDelayMs: currentLiveDelayMs,
  sessionKey: currentSessionKey,
  replayDurationMs: currentReplayDurationMs,
  replayProgress: mode === "replay" ? currentReplayProgress : undefined,
  flag: lastFlag ?? 0,
});

export const getReplayTimeline = () => currentTimeline;

export const fetchLatestReplaySessions = async (
  limit = 12,
): Promise<ReplaySession[]> => {
  const currentYear = new Date().getUTCFullYear();
  const years = [currentYear, currentYear - 1];
  const now = Date.now();
  const collected: OpenF1Session[] = [];

  for (const year of years) {
    try {
      const res = await fetch(`${SESSIONS_API}?year=${year}`);
      if (!res.ok) continue;
      const sessions = (await res.json()) as OpenF1Session[];
      collected.push(...sessions);
      if (collected.length >= limit) break;
    } catch (err) {
      console.error(`Session fetch failed for year ${year}:`, err);
    }
  }

  const dedup = new Map<number, OpenF1Session>();
  for (const session of collected) {
    if (!session?.session_key || !session?.date_start) continue;
    const startTs = Date.parse(session.date_start);
    if (!Number.isFinite(startTs) || startTs > now) continue;
    dedup.set(session.session_key, session);
  }

  const sessions = [...dedup.values()]
    .sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start))
    .slice(0, limit);

  const meetingKeys = [...new Set(sessions.map((s) => s.meeting_key).filter(
    (key): key is number => typeof key === "number",
  ))];
  const meetingsByKey = new Map<number, OpenF1Meeting>();

  await Promise.all(
    meetingKeys.map(async (meetingKey) => {
      try {
        const res = await fetch(
          `${MEETINGS_API}?meeting_key=${encodeURIComponent(String(meetingKey))}`,
        );
        if (!res.ok) return;
        const items = (await res.json()) as OpenF1Meeting[];
        const meeting = items[0];
        if (meeting?.meeting_key) {
          meetingsByKey.set(meeting.meeting_key, meeting);
        }
      } catch (err) {
        console.error(`Meeting fetch failed for key ${meetingKey}:`, err);
      }
    }),
  );

  return sessions
    .map((session) => {
      const date = new Date(session.date_start);
      const meeting =
        session.meeting_key !== undefined
          ? meetingsByKey.get(session.meeting_key)
          : undefined;
      const meetingName =
        meeting?.meeting_name ??
        meeting?.meeting_official_name ??
        session.location ??
        session.country_name ??
        "Unknown meeting";

      return {
        sessionKey: String(session.session_key),
        sessionName: session.session_name,
        meetingName,
        dateStart: session.date_start,
        label: `${meetingName} - ${session.session_name} (${date.toLocaleDateString("en-GB")})`,
      };
    });
};
