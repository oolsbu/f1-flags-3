"use client";
import Footer from "@/components/footer";
import Header from "@/components/header";
import {
  pauseReplayPoller,
  playReplayPoller,
  requestLatestSessions,
  seekReplayPoller,
  setLiveDelay,
  socket,
  startLivePoller,
  startReplayPoller,
  stopPoller,
} from "@/app/socket";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PollerStatus,
  ReplaySession,
  ReplayTimeline,
  TimelineEvent,
} from "@/types/socket";

const SETTINGS_KEY = "f1-flags:poller-settings:v1";

interface PersistedSettings {
  selectedSessionKey: string;
  replayDurationSec: number;
  broadcastDelaySec: number;
  realtime: boolean;
  lastMode: "live" | "replay";
}

const defaultSettings: PersistedSettings = {
  selectedSessionKey: "latest",
  replayDurationSec: 60,
  broadcastDelaySec: 30,
  realtime: false,
  lastMode: "live",
};

const readSettings = (): PersistedSettings => {
  if (typeof window === "undefined") return defaultSettings;

  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;

    return {
      selectedSessionKey:
        typeof parsed.selectedSessionKey === "string"
          ? parsed.selectedSessionKey
          : defaultSettings.selectedSessionKey,
      replayDurationSec:
        typeof parsed.replayDurationSec === "number" &&
        Number.isFinite(parsed.replayDurationSec)
          ? Math.max(5, parsed.replayDurationSec)
          : defaultSettings.replayDurationSec,
      broadcastDelaySec:
        typeof parsed.broadcastDelaySec === "number" &&
        Number.isFinite(parsed.broadcastDelaySec)
          ? Math.max(0, parsed.broadcastDelaySec)
          : defaultSettings.broadcastDelaySec,
      realtime:
        typeof parsed.realtime === "boolean"
          ? parsed.realtime
          : defaultSettings.realtime,
      lastMode: parsed.lastMode === "replay" ? "replay" : "live",
    };
  } catch {
    return defaultSettings;
  }
};

const FLAG_COLORS: Record<number, string> = {
  1: "#00c853", // green
  2: "#ffea00", // yellow
  3: "#ff1744", // red
  4: "#ff9100", // safety car (orange)
  5: "#e040fb", // vsc (purple)
};

const flagLabel = (flag: number) => {
  switch (flag) {
    case 1:
      return "Green";
    case 2:
      return "Yellow";
    case 3:
      return "Red";
    case 4:
      return "SC";
    case 5:
      return "VSC";
    default:
      return `Flag ${flag}`;
  }
};

const formatElapsed = (ms: number) => {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const formatDatetime = (epochMs: number) => {
  const d = new Date(epochMs);
  return d.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
};

const Page = () => {
  const initialSettings = readSettings();
  const [flag, setFlag] = useState(0);
  const [replayDurationSec, setReplayDurationSec] = useState(
    initialSettings.replayDurationSec,
  );
  const [broadcastDelaySec, setBroadcastDelaySec] = useState(
    initialSettings.broadcastDelaySec,
  );
  const [realtime, setRealtime] = useState(initialSettings.realtime);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replayActive, setReplayActive] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [sessions, setSessions] = useState<ReplaySession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [selectedSessionKey, setSelectedSessionKey] = useState(
    initialSettings.selectedSessionKey,
  );
  const [firstTimestamp, setFirstTimestamp] = useState(0);
  const [realSpanMs, setRealSpanMs] = useState(0);
  const [totalDurationMs, setTotalDurationMs] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const settingsRef = useRef<PersistedSettings>(initialSettings);
  const bootstrapDone = useRef(false);

  const persistLastMode = useCallback((mode: "live" | "replay") => {
    settingsRef.current.lastMode = mode;
    if (typeof window === "undefined") return;

    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        ...settingsRef.current,
        lastMode: mode,
      } satisfies PersistedSettings),
    );
  }, []);

  useEffect(() => {
    settingsRef.current = {
      selectedSessionKey,
      replayDurationSec,
      broadcastDelaySec,
      realtime,
      lastMode: settingsRef.current.lastMode,
    };
  }, [selectedSessionKey, replayDurationSec, broadcastDelaySec, realtime]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        ...settingsRef.current,
        selectedSessionKey,
        replayDurationSec,
        broadcastDelaySec,
        realtime,
      } satisfies PersistedSettings),
    );
  }, [selectedSessionKey, replayDurationSec, broadcastDelaySec, realtime]);

  useEffect(() => {
    socket.emit("status");

    socket.on("flag", (data: number) => setFlag(data));

    socket.on("replay:timeline", (data: ReplayTimeline) => {
      setTimeline(data.events);
      setFirstTimestamp(data.firstTimestamp);
      setRealSpanMs(data.realSpanMs);
      setTotalDurationMs(data.totalDurationMs);
      setReplayActive(true);
    });

    socket.on("replay:progress", (pos: number) => {
      if (!dragging.current) setProgress(pos);
    });

    socket.on("poller:status", (status: PollerStatus) => {
      setPlaying(status.replayPlaying ?? false);

      if (typeof status.flag === "number") {
        setFlag(status.flag);
      }

      if (typeof status.liveDelayMs === "number") {
        setBroadcastDelaySec(Math.max(0, Math.round(status.liveDelayMs / 1000)));
      }

      if (status.mode === "replay") {
        persistLastMode("replay");
        if (status.sessionKey) {
          setSelectedSessionKey(status.sessionKey);
        }

        if (typeof status.replayDurationMs === "number") {
          if (status.replayDurationMs <= 0) {
            setRealtime(true);
          } else {
            setRealtime(false);
            setReplayDurationSec(
              Math.max(5, Math.round(status.replayDurationMs / 1000)),
            );
          }
        }

        if (typeof status.replayProgress === "number" && !dragging.current) {
          setProgress(status.replayProgress);
        }
      } else if (status.mode === "live") {
        persistLastMode("live");
      }

      if (!status.running) {
        setReplayActive(false);
        if (bootstrapDone.current) return;

        bootstrapDone.current = true;
        const saved = settingsRef.current;
        if (saved.lastMode === "replay") {
          startReplayPoller({
            sessionKey: saved.selectedSessionKey,
            replayDurationMs: saved.realtime ? 0 : saved.replayDurationSec * 1000,
            liveDelayMs: saved.broadcastDelaySec * 1000,
          });
          return;
        }

        startLivePoller({ liveDelayMs: saved.broadcastDelaySec * 1000 });
        return;
      }

      bootstrapDone.current = true;
    });

    socket.on("sessions:latest", (data: ReplaySession[]) => {
      setSessions(data);
      setSessionsLoading(false);
      setSessionsError(null);
      setSelectedSessionKey((prev) => {
        if (data.some((s) => s.sessionKey === prev)) return prev;
        return data[0]?.sessionKey ?? "latest";
      });
    });

    socket.on("sessions:error", (message: string) => {
      setSessionsLoading(false);
      setSessionsError(message || "Failed to load sessions");
    });

    requestLatestSessions();

    return () => {
      socket.off("flag");
      socket.off("replay:timeline");
      socket.off("replay:progress");
      socket.off("poller:status");
      socket.off("sessions:latest");
      socket.off("sessions:error");
    };
  }, [persistLastMode]);

  const posFromEvent = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }, []);

  const onTrackMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      setIsDragging(true);
      const pos = posFromEvent(e);
      setProgress(pos);
      seekReplayPoller(pos);

      const onMove = (ev: MouseEvent) => {
        const p = posFromEvent(ev);
        setProgress(p);
        seekReplayPoller(p);
      };
      const onUp = () => {
        dragging.current = false;
        setIsDragging(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [posFromEvent],
  );

  return (
    <>
      <Header />

      <main style={{ padding: "1rem", maxWidth: 800, margin: "0 auto" }}>
        {/* Current flag display */}
        <div
          style={{
            textAlign: "center",
            padding: "2rem",
            marginBottom: "1.5rem",
            borderRadius: 12,
            background: FLAG_COLORS[flag] ?? "#333",
            color: flag === 2 ? "#000" : "#fff",
            fontSize: "2rem",
            fontWeight: 700,
            transition: "background 0.3s",
          }}
        >
          {flag ? flagLabel(flag) : "No flag"}
        </div>

        {/* Controls row */}
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: "1rem",
          }}
        >
          <button
            className="btn"
            onClick={() => {
              persistLastMode("live");
              startLivePoller({ liveDelayMs: broadcastDelaySec * 1000 });
            }}
          >
            Live
          </button>
          <button
            className="btn"
            disabled={sessionsLoading || sessions.length === 0}
            onClick={() => {
              persistLastMode("replay");
              startReplayPoller({
                sessionKey: selectedSessionKey,
                replayDurationMs: realtime ? 0 : replayDurationSec * 1000,
                liveDelayMs: broadcastDelaySec * 1000,
              });
            }}
          >
            Replay {realtime ? "(realtime)" : `(${replayDurationSec}s)`}
          </button>
          <button className="btn" onClick={stopPoller}>
            Stop
          </button>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 14, opacity: 0.7 }}>Session</span>
            <select
              value={selectedSessionKey}
              onChange={(e) => setSelectedSessionKey(e.target.value)}
              disabled={sessionsLoading || sessions.length === 0}
              style={{
                minWidth: 240,
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid #555",
                background: "#1a1a1a",
                color: "#fff",
                fontSize: 14,
              }}
            >
              {sessions.map((session) => (
                <option key={session.sessionKey} value={session.sessionKey}>
                  {session.label}
                </option>
              ))}
            </select>
          </label>

          <button
            className="btn"
            onClick={() => {
              setSessionsLoading(true);
              requestLatestSessions();
            }}
          >
            Refresh Sessions
          </button>

          {/* Broadcast delay for live mode */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 14, opacity: 0.7 }}>Delay (s)</span>
            <input
              type="number"
              min={0}
              max={120}
              value={broadcastDelaySec}
              onChange={(e) => {
                const v = Number(e.target.value) || 0;
                setBroadcastDelaySec(v);
                setLiveDelay(v * 1000);
              }}
              style={{
                width: 60,
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid #555",
                background: "#1a1a1a",
                color: "#fff",
                fontSize: 14,
              }}
            />
          </label>

          {/* Realtime toggle */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginLeft: "auto",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <span style={{ fontSize: 14, opacity: 0.7 }}>Realtime</span>
            <div
              onClick={() => setRealtime((v) => !v)}
              style={{
                width: 40,
                height: 22,
                borderRadius: 11,
                background: realtime ? "#e10600" : "#444",
                position: "relative",
                transition: "background 0.2s",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 2,
                  left: realtime ? 20 : 2,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left 0.2s",
                }}
              />
            </div>
          </label>

          {/* Duration input — hidden when realtime */}
          {!realtime && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span style={{ fontSize: 14, opacity: 0.7 }}>Duration (s)</span>
              <input
                type="number"
                min={5}
                value={replayDurationSec}
                onChange={(e) =>
                  setReplayDurationSec(Number(e.target.value) || 60)
                }
                style={{
                  width: 70,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid #555",
                  background: "#1a1a1a",
                  color: "#fff",
                  fontSize: 14,
                }}
              />
            </label>
          )}
        </div>

        {sessionsError && (
          <div style={{ color: "#ff8a80", marginBottom: "1rem", fontSize: 14 }}>
            {sessionsError}
          </div>
        )}

        {/* Timeline player */}
        {replayActive && (
          <div
            style={{ background: "#1a1a1a", borderRadius: 12, padding: "1rem" }}
          >
            {/* Play/Pause + skip buttons + timestamps */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 8,
              }}
            >
              <button
                className="btn-icon"
                onClick={() => {
                  if (totalDurationMs <= 0) return;
                  const delta = 15000 / totalDurationMs;
                  const pos = Math.max(0, progress - delta);
                  setProgress(pos);
                  seekReplayPoller(pos);
                }}
                title="Rewind 15s"
                style={{ fontSize: 13 }}
              >
                -15
              </button>
              <button
                className="btn-icon"
                onClick={() =>
                  playing ? pauseReplayPoller() : playReplayPoller()
                }
                title={playing ? "Pause" : "Play"}
              >
                {playing ? "⏸" : "▶"}
              </button>
              <button
                className="btn-icon"
                onClick={() => {
                  if (totalDurationMs <= 0) return;
                  const delta = 15000 / totalDurationMs;
                  const pos = Math.min(1, progress + delta);
                  setProgress(pos);
                  seekReplayPoller(pos);
                }}
                title="Skip 15s"
                style={{ fontSize: 13 }}
              >
                +15
              </button>

              {/* Timestamps */}
              <div
                style={{
                  marginLeft: "auto",
                  textAlign: "right",
                  fontFamily: "monospace",
                  fontSize: 13,
                  lineHeight: 1.4,
                  opacity: 0.75,
                }}
              >
                <div>
                  {formatElapsed(progress * totalDurationMs)} /{" "}
                  {formatElapsed(totalDurationMs)}
                </div>
                <div style={{ opacity: 0.6 }}>
                  {firstTimestamp > 0 &&
                    formatDatetime(firstTimestamp + progress * realSpanMs)}
                </div>
              </div>
            </div>

            {/* Scrub track */}
            <div
              ref={trackRef}
              onMouseDown={onTrackMouseDown}
              style={{
                position: "relative",
                height: 32,
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              {/* Background rail */}
              <div
                style={{
                  position: "absolute",
                  top: 14,
                  left: 0,
                  right: 0,
                  height: 4,
                  borderRadius: 2,
                  background: "#333",
                }}
              />

              {/* Filled portion */}
              <div
                style={{
                  position: "absolute",
                  top: 14,
                  left: 0,
                  width: `${progress * 100}%`,
                  height: 4,
                  borderRadius: 2,
                  background: "#e10600",
                  transition: isDragging ? "none" : "width 0.1s linear",
                }}
              />

              {/* Flag dots */}
              {timeline.map((evt, i) => (
                <div
                  key={i}
                  title={flagLabel(evt.flag)}
                  style={{
                    position: "absolute",
                    left: `${evt.position * 100}%`,
                    top: 8,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: FLAG_COLORS[evt.flag] ?? "#888",
                    border: "2px solid #1a1a1a",
                    transform: "translateX(-50%)",
                    zIndex: 2,
                    transition: "transform 0.15s",
                  }}
                />
              ))}

              {/* Playhead */}
              <div
                style={{
                  position: "absolute",
                  left: `${progress * 100}%`,
                  top: 6,
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "#fff",
                  border: "2px solid #e10600",
                  transform: "translateX(-50%)",
                  zIndex: 3,
                  boxShadow: "0 0 6px rgba(0,0,0,0.5)",
                  transition: isDragging ? "none" : "left 0.1s linear",
                }}
              />
            </div>
          </div>
        )}
      </main>

      <Footer />
    </>
  );
};

export default Page;
