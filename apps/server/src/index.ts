import { parseClientMessage, type ServerMessage } from "@dreierschub/protocol";
import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { Hub, type Connection } from "./hub";
import { createEventSender, integrationRouter } from "./integration";

const PORT = Number(process.env.PORT ?? 3000);
/** Unterpfad hinter einem Reverse Proxy, z. B. `/game-servers/shift`. Leer = Wurzel. */
const BASE_PATH = (process.env.BASE_PATH ?? "").replace(/\/+$/, "");
/** Wer das Spiel in einem iframe zeigen darf (CSP frame-ancestors). */
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS ?? "'self'";
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(process.env.CLIENT_DIR ?? resolve(here, "../../client/dist"));

const hub = new Hub(undefined, undefined, createEventSender(process.env.INTEGRATION_WEBHOOK_SECRET));

const app = express();
app.disable("x-powered-by");
const site = express.Router();
site.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", `frame-ancestors ${FRAME_ANCESTORS}`);
  next();
});
site.get("/health", (_req, res) => {
  res.json({ ok: true });
});
site.use("/api/integrations/v1", integrationRouter(hub, process.env.INTEGRATION_API_KEY));
if (existsSync(CLIENT_DIR)) {
  site.use(express.static(CLIENT_DIR, { index: "index.html", maxAge: "1h" }));
  site.get(/^\/(?!ws|health|api\/).*/, (_req, res) => res.sendFile(resolve(CLIENT_DIR, "index.html")));
} else {
  console.warn(`[server] Kein Client-Build unter ${CLIENT_DIR}; nur WebSocket, API und /health aktiv.`);
}
if (BASE_PATH) {
  // Ohne Schrägstrich am Ende würden relative Pfade auf den übergeordneten Ordner zeigen
  app.get(BASE_PATH, (req, res, next) => {
    const [path = "", query = ""] = req.originalUrl.split(/\?(.*)/s);
    if (path.endsWith("/")) return next();
    res.redirect(301, `${BASE_PATH}/${query ? `?${query}` : ""}`);
  });
}
app.use(BASE_PATH || "/", site);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: `${BASE_PATH}/ws`, maxPayload: 16 * 1024 });

wss.on("connection", (socket) => {
  const conn: Connection = {
    send(message: ServerMessage) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
  };
  let player: ReturnType<Hub["hello"]> = null;
  let alive = true;
  let budget = 60; // Nachrichten pro Sekunde, grobe Bremse gegen Fluten
  const refill = setInterval(() => (budget = 60), 1000);
  const ping = setInterval(() => {
    if (!alive) return socket.terminate();
    alive = false;
    socket.ping();
  }, 20_000);
  socket.on("pong", () => (alive = true));

  socket.on("message", (data) => {
    if (--budget < 0) return;
    const msg = parseClientMessage(String(data));
    if (!msg) return conn.send({ t: "error", message: "Unbekannte Nachricht" });
    if (msg.t === "hello") {
      player = hub.hello(conn, msg.name, msg.token, msg.seat);
      return;
    }
    if (!player) return conn.send({ t: "error", message: "Bitte zuerst anmelden" });
    hub.handle(player, msg);
  });

  socket.on("close", () => {
    clearInterval(refill);
    clearInterval(ping);
    if (player) hub.disconnect(player, conn);
  });
});

setInterval(() => hub.sweep(), 5_000).unref();

server.listen(PORT, () => {
  console.log(`[server] Dreierschub läuft auf http://localhost:${PORT}${BASE_PATH}/`);
});
