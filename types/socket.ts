export interface TimelineEvent {
  flag: number;
  position: number; // 0–1
}

export interface ReplayTimeline {
  events: TimelineEvent[];
  firstTimestamp: number;
  realSpanMs: number;
  totalDurationMs: number;
}

export interface ReplaySession {
  sessionKey: string;
  sessionName: string;
  meetingName: string;
  dateStart: string;
  label: string;
}

export type PollerMode = "live" | "replay";

export interface PollerStatus {
  running: boolean;
  mode?: PollerMode;
  replayPlaying?: boolean;
  liveDelayMs?: number;
  sessionKey?: string;
  replayDurationMs?: number;
  replayProgress?: number;
  flag?: number;
}
