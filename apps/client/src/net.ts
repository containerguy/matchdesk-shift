import type { ClientMessage, OnlinePlayer, ServerMessage, TableSummary, TableView } from "@dreierschub/protocol";

export type ChatLine = { from: string; text: string; at: number };

export type NetState = {
  status: "idle" | "connecting" | "online" | "offline";
  me: { id: string; name: string } | null;
  tables: TableSummary[];
  online: OnlinePlayer[];
  table: TableView | null;
  lobbyChat: ChatLine[];
  tableChat: ChatLine[];
  error: string | null;
};

const TOKEN_KEY = "dreierschub.token";
const NAME_KEY = "dreierschub.name";

function storage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Ohne Speicher geht es auch, nur ohne Wiederverbinden nach Neuladen
  }
  return null;
}

/**
 * WebSocket-Adresse relativ zur Seite, damit das Spiel auch unter einem Unterpfad läuft
 * (z. B. `/game-servers/shift/` hinter einem Reverse Proxy).
 */
export function socketUrl(loc: { href: string } = location): string {
  const url = new URL("ws", loc.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  url.hash = "";
  return url.toString();
}

type GameListener = (msg: Extract<ServerMessage, { t: "moved" | "preview" }>) => void;

/** Verbindung zum Spielserver mit automatischem Wiederverbinden. */
export class NetClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private gameListener: GameListener | null = null;
  private retry = 0;
  private name = "";
  private pendingCode: string | null = null;
  private seat: string | null = null;
  private stopped = false;
  state: NetState = { status: "idle", me: null, tables: [], online: [], table: null, lobbyChat: [], tableChat: [], error: null };

  static savedName() {
    return storage(NAME_KEY) ?? "";
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = () => this.state;

  onGame(listener: GameListener | null) {
    this.gameListener = listener;
  }

  /** Mit Code aus einem Einladungslink beitreten, sobald verbunden. */
  joinOnConnect(code: string) {
    this.pendingCode = code;
  }

  connect(name: string) {
    this.name = name;
    storage(NAME_KEY, name);
    this.stopped = false;
    this.open();
  }

  /** Mit Platz-Link eines reservierten Tisches verbinden (Name und Platz kommen vom Server). */
  connectSeat(seat: string) {
    this.seat = seat;
    this.name = "";
    this.stopped = false;
    this.open();
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  clearError() {
    this.patch({ error: null });
  }

  private open() {
    this.patch({ status: "connecting" });
    const ws = new WebSocket(socketUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(
        JSON.stringify({ t: "hello", name: this.name, token: storage(TOKEN_KEY) ?? undefined, seat: this.seat ?? undefined } satisfies ClientMessage)
      );
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.patch({ status: "offline" });
      if (this.stopped) return;
      const delay = Math.min(10_000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  private receive(msg: ServerMessage) {
    switch (msg.t) {
      case "welcome":
        storage(TOKEN_KEY, msg.token);
        this.patch({ status: "online", me: { id: msg.playerId, name: msg.name }, error: null });
        if (this.pendingCode) {
          this.send({ t: "joinTable", code: this.pendingCode });
          this.pendingCode = null;
        }
        return;
      case "lobby":
        return this.patch({ tables: msg.tables, online: msg.online });
      case "table": {
        const sameTable = msg.table && this.state.table?.id === msg.table.id;
        return this.patch({ table: msg.table, tableChat: sameTable ? this.state.tableChat : [] });
      }
      case "chat": {
        const line = { from: msg.from, text: msg.text, at: msg.at };
        if (msg.scope === "lobby") return this.patch({ lobbyChat: [...this.state.lobbyChat, line].slice(-100) });
        return this.patch({ tableChat: [...this.state.tableChat, line].slice(-100) });
      }
      case "moved":
      case "preview":
        this.gameListener?.(msg);
        return;
      case "error":
        return this.patch({ error: msg.message });
    }
  }

  private patch(p: Partial<NetState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
}
