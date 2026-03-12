import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { Server } from "socket.io";
import { setIO } from "./socket.ts";
import { initLeds, resetLeds } from "./led-controller.ts";
import { stopAnimation } from "./led-animation.ts";
import {
  startHttpPoller,
  stopHttpPoller,
  pauseReplayPoller,
  playReplayPoller,
  seekReplayPoller,
  fetchLatestReplaySessions,
  getHttpPollerStatus,
  getReplayTimeline,
} from "./http-poller.ts";
import { setLiveDelay } from "./signalr-client.ts";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const srv = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  const io = new Server(srv);
  setIO(io);
  initLeds();

  io.on("connection", (socket) => {
    console.log("[IO] Client connected");

    const emitSnapshot = () => {
      const status = getHttpPollerStatus();
      socket.emit("poller:status", status);
      if (typeof status.flag === "number") {
        socket.emit("flag", status.flag);
      }
      if (status.mode === "replay") {
        const timeline = getReplayTimeline();
        if (timeline) {
          socket.emit("replay:timeline", timeline);
        }
        if (typeof status.replayProgress === "number") {
          socket.emit("replay:progress", status.replayProgress);
        }
      }
    };

    emitSnapshot();

    socket.on("poller:start", (opts) => {
      startHttpPoller(opts);
      io.emit("poller:status", {
        running: true,
        replayPlaying: opts.mode === "replay",
      });
    });

    socket.on("poller:stop", () => {
      stopHttpPoller();
      io.emit("poller:status", { running: false, replayPlaying: false });
    });

    socket.on("poller:pause", () => {
      pauseReplayPoller();
      io.emit("poller:status", { running: true, replayPlaying: false });
    });

    socket.on("poller:play", () => {
      playReplayPoller();
      io.emit("poller:status", { running: true, replayPlaying: true });
    });

    socket.on("poller:seek", (pos: number) => {
      seekReplayPoller(pos);
    });

    socket.on("live:setDelay", (ms: number) => {
      if (typeof ms === "number" && ms >= 0) {
        setLiveDelay(ms);
        console.log(`[IO] Broadcast delay set to ${ms}ms`);
      }
    });

    socket.on("status", () => {
      emitSnapshot();
    });

    socket.on("sessions:latest", async () => {
      try {
        const sessions = await fetchLatestReplaySessions();
        socket.emit("sessions:latest", sessions);
      } catch (err) {
        console.error("[IO] Failed to fetch latest sessions:", err);
        socket.emit("sessions:error", "Failed to load replay sessions");
      }
    });

    socket.on("disconnect", () => {
      console.log("[IO] Client disconnected");
    });
  });

  const port = Number(process.env.PORT ?? 3000);
  srv.listen(port, () => {
    console.log(`> F1 Flags ready on http://localhost:${port}`);
  });

  const cleanup = () => {
    stopHttpPoller();
    stopAnimation();
    resetLeds();
    process.exit();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
});
