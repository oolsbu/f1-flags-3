import type { Server } from "socket.io";
import type { ReplayTimeline } from "./types/socket.ts";

let io: Server | null = null;

export const setIO = (server: Server) => {
  io = server;
};

export const getIO = () => io;

export const broadcastFlag = (flag: number) => {
  io?.emit("flag", flag);
};

export const broadcastProgress = (pos: number) => {
  io?.emit("replay:progress", pos);
};

export const broadcastTimeline = (tl: ReplayTimeline) => {
  io?.emit("replay:timeline", tl);
};
