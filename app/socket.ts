"use client";

import { io } from "socket.io-client";

export const socket = io();

export const startLivePoller = (options?: {
  pollIntervalMs?: number;
  liveDelayMs?: number;
}) => {
  socket.emit("poller:start", {
    mode: "live",
    pollIntervalMs: options?.pollIntervalMs,
    liveDelayMs: options?.liveDelayMs,
  });
};

export const startReplayPoller = (options: {
  sessionKey: string;
  replayDurationMs: number;
  liveDelayMs?: number;
}) => {
  socket.emit("poller:start", {
    mode: "replay",
    sessionKey: options.sessionKey,
    replayDurationMs: options.replayDurationMs,
    liveDelayMs: options.liveDelayMs,
  });
};

export const pauseReplayPoller = () => {
  socket.emit("poller:pause");
};

export const playReplayPoller = () => {
  socket.emit("poller:play");
};

export const seekReplayPoller = (position: number) => {
  socket.emit("poller:seek", position);
};

export const stopPoller = () => {
  socket.emit("poller:stop");
};

export const setLiveDelay = (ms: number) => {
  socket.emit("live:setDelay", ms);
};

export const requestLatestSessions = () => {
  socket.emit("sessions:latest");
};
