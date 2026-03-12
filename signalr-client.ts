import WebSocket from "ws";

const SIGNALR_BASE = "https://livetiming.formula1.com/signalr";
const HUB = "Streaming";

interface BufferedEvent {
  utcMs: number;
  flag: number;
}

type FlagCallback = (flag: number) => void;

let ws: WebSocket | null = null;
let running = false;
let delayMs = 30_000;
let buffer: BufferedEvent[] = [];
let onFlag: FlagCallback | null = null;
let dispatchTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const flagNameToNumber = (flag?: string, message?: string): number | null => {
  const msg = (message ?? "").toUpperCase();
  const f = (flag ?? "").toUpperCase();

  // Check message-based flags first (SC / VSC)
  if (msg.includes("VIRTUAL SAFETY CAR") || msg.includes("VSC")) return 5;
  if (msg.includes("SAFETY CAR")) return 4;

  switch (f) {
    case "GREEN":
      return 1;
    case "CLEAR":
      return 0;
    case "YELLOW":
    case "DOUBLE YELLOW":
      return 2;
    case "RED":
      return 3;
    case "CHEQUERED":
      return 1;
    case "BLUE":
      return null;
    default:
      return null;
  }
};

/* ──────────────────── SignalR legacy protocol helpers ──────────────────── */

const negotiate = async (): Promise<string> => {
  const cd = encodeURIComponent(JSON.stringify([{ Name: HUB }]));
  const url = `${SIGNALR_BASE}/negotiate?connectionData=${cd}&clientProtocol=1.5`;
  console.log("[SignalR] Negotiate →", url);
  const res = await fetch(url);
  console.log("[SignalR] Negotiate ←", res.status, res.statusText);
  if (!res.ok) {
    const body = await res.text();
    console.error("[SignalR] Negotiate error body:", body);
    throw new Error(`Negotiate failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  console.log("[SignalR] Negotiate response:", JSON.stringify(json, null, 2));
  if (!json.ConnectionToken) {
    throw new Error(`Negotiate response missing ConnectionToken`);
  }
  return json.ConnectionToken as string;
};

const openSocket = async () => {
  if (!running) return;

  try {
    const token = await negotiate();
    const et = encodeURIComponent(token);
    const cd = encodeURIComponent(JSON.stringify([{ Name: HUB }]));

    const wsUrl = `wss://livetiming.formula1.com/signalr/connect?transport=webSockets&clientProtocol=1.5&connectionToken=${et}&connectionData=${cd}`;
    console.log("[SignalR] Opening WebSocket →", wsUrl);

    ws = new WebSocket(wsUrl);

    ws.on("open", async () => {
      console.log("[SignalR] WebSocket open");

      // Activate the server-side transport
      const startUrl = `${SIGNALR_BASE}/start?transport=webSockets&clientProtocol=1.5&connectionToken=${et}&connectionData=${cd}`;
      console.log("[SignalR] Start →", startUrl);
      const startRes = await fetch(startUrl);
      console.log("[SignalR] Start ←", startRes.status, startRes.statusText);
      const startBody = await startRes.text();
      console.log("[SignalR] Start response:", startBody);

      // Subscribe to race control
      const subscribeMsg = {
        H: HUB,
        M: "Subscribe",
        A: [["RaceControlMessages"]],
        I: 1,
      };
      console.log("[SignalR] Sending subscribe:", JSON.stringify(subscribeMsg));
      ws?.send(JSON.stringify(subscribeMsg));
      console.log("[SignalR] Subscribed to RaceControlMessages");
    });

    ws.on("message", (raw: Buffer) => {
      const text = raw.toString();
      console.log(
        "[SignalR] ← message:",
        text.length > 500 ? text.slice(0, 500) + "…" : text,
      );
      try {
        const pkt = JSON.parse(raw.toString());

        // Hub invocation messages
        if (Array.isArray(pkt.M)) {
          for (const m of pkt.M) {
            if (m.A?.[0] === "RaceControlMessages") handleRC(m.A[1]);
          }
        }

        // Initial state / invoke result
        if (pkt.R?.RaceControlMessages) handleRC(pkt.R.RaceControlMessages);
      } catch {
        /* keepalive / non-JSON frame */
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      console.log(
        "[SignalR] Closed code=%d reason=%s",
        code,
        reason.toString() || "(none)",
      );
      scheduleReconnect();
    });

    ws.on("error", (e: Error) => {
      console.error("[SignalR] WebSocket error:", e.message);
      ws?.close();
    });

    ws.on(
      "unexpected-response",
      (
        _req: unknown,
        res: { statusCode: number; headers: Record<string, string> },
      ) => {
        console.error(
          "[SignalR] Unexpected HTTP response: status=%d",
          res.statusCode,
        );
        console.error(
          "[SignalR] Response headers:",
          JSON.stringify(res.headers, null, 2),
        );
        ws?.close();
      },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SignalR] Connect failed:", msg);
    scheduleReconnect();
  }
};

/* ──────────────────── Race-control message handling ──────────────────── */

const handleRC = (data: Record<string, unknown>) => {
  let msgs: Record<string, unknown>[] = [];

  if (Array.isArray((data as { Messages?: unknown[] }).Messages)) {
    msgs = (data as { Messages: Record<string, unknown>[] }).Messages;
  } else {
    // Incremental update keyed by index
    msgs = Object.values(data).filter(
      (v): v is Record<string, unknown> => !!v && typeof v === "object",
    );
  }

  for (const m of msgs) {
    const flag = flagNameToNumber(
      m.Flag as string | undefined,
      m.Message as string | undefined,
    );
    if (flag === null) continue;

    const utcMs = m.Utc ? new Date(m.Utc as string).getTime() : Date.now();
    buffer.push({ utcMs, flag });
    console.log(
      `[SignalR] Buffered flag=${flag} utc=${new Date(utcMs).toISOString()} delay=${delayMs}ms`,
    );
  }
};

/* ──────────────────── Delayed dispatch ──────────────────── */

const dispatchTick = () => {
  const now = Date.now();
  while (buffer.length > 0 && buffer[0].utcMs + delayMs <= now) {
    const evt = buffer.shift()!;
    onFlag?.(evt.flag);
  }
};

const scheduleReconnect = () => {
  if (!running) return;
  reconnectTimer = setTimeout(openSocket, 5000);
};

/* ──────────────────── Public API ──────────────────── */

export const startSignalR = (opts: {
  delayMs: number;
  onFlag: FlagCallback;
}) => {
  stopSignalR();
  delayMs = opts.delayMs;
  onFlag = opts.onFlag;
  buffer = [];
  running = true;

  openSocket();
  dispatchTimer = setInterval(dispatchTick, 100);
};

export const stopSignalR = () => {
  running = false;
  ws?.close();
  ws = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (dispatchTimer) {
    clearInterval(dispatchTimer);
    dispatchTimer = null;
  }
  buffer = [];
  onFlag = null;
};

export const setLiveDelay = (ms: number) => {
  delayMs = ms;
};
