import { otherSeat, type GameDefinition, type Seat } from "@dreierschub/core";
import { cleanName, type ClientMessage, type OnlinePlayer, type ServerMessage, type TableSummary, type TableView } from "@dreierschub/protocol";
import { randomBytes, randomInt } from "node:crypto";
import { shift } from "@dreierschub/shift";

/** Eine Verbindung zu einem Browser. In Tests ein einfaches Objekt, im Betrieb ein WebSocket. */
export interface Connection {
  send(message: ServerMessage): void;
}

/** So lange bleibt ein Platz für einen getrennten Spieler frei. */
export const RECONNECT_GRACE_MS = 60_000;
/** Getrennte Spieler ohne Tisch werden nach dieser Zeit vergessen. */
const FORGET_AFTER_MS = 10 * 60_000;
/** Ein reservierter Tisch, an den sich nie jemand gesetzt hat, verfällt nach dieser Zeit. */
export const RESERVATION_TTL_MS = 30 * 60_000;
/** Ein reservierter Tisch ohne Spieler wird nach dieser Zeit ohne Aktivität geschlossen. */
export const RESERVATION_IDLE_MS = 2 * 60 * 60_000;

/** Spieler eines reservierten Tisches, wie die Integration (z. B. Matchdesk) ihn kennt. */
export type ReservedPlayer = { id: string; name: string };

export type ReserveInput = {
  players: [ReservedPlayer, ReservedPlayer];
  name?: string;
  /** Kennung der Integration, kommt in jedem Ereignis zurück (z. B. Partie-ID in Matchdesk). */
  ref?: string;
  /** Adresse für Ereignisse (Ergebnis, Verfall). */
  callbackUrl?: string;
};

export type ReservedTableInfo = {
  id: string;
  code: string;
  ref: string | null;
  status: "waiting" | "playing" | "finished";
  players: Array<{ id: string; name: string; seat: Seat; connected: boolean; score: number }>;
  /** Externe ID des Siegers der letzten beendeten Partie. */
  winner: string | null;
  gamesPlayed: number;
};

/** Ereignis eines reservierten Tisches für die Integration. */
export type TableEvent = {
  type: "game.finished" | "table.expired" | "table.closed";
  reason?: "won" | "forfeit";
  at: string;
  table: ReservedTableInfo;
};

/** Platz-Link-Daten für einen Spieler eines reservierten Tisches. */
export type SeatTicket = { playerId: string; seat: Seat; token: string };

export type TableEventListener = (event: TableEvent, callbackUrl: string | null) => void;

type AnyGame = GameDefinition<unknown, unknown, unknown>;
const GAMES: Record<string, AnyGame> = { [shift.id]: shift as unknown as AnyGame };

type Player = {
  id: string;
  token: string;
  name: string;
  conn: Connection | null;
  disconnectedAt: number | null;
  tableId: string | null;
};

type Table = {
  id: string;
  name: string;
  code: string;
  private: boolean;
  game: AnyGame;
  hostName: string;
  seats: [string | null, string | null];
  status: "waiting" | "playing" | "finished";
  state: unknown;
  score: [number, number];
  nextStart: Seat;
  rematch: [boolean, boolean];
  endNote: string | null;
  reservation: Reservation | null;
};

type Reservation = {
  ref: string | null;
  callbackUrl: string | null;
  players: [ReservedPlayer, ReservedPlayer];
  tokens: [string, string];
  createdAt: number;
  lastActiveAt: number;
  joined: boolean;
  winner: string | null;
  gamesPlayed: number;
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Lobby und Tische des Spielservers. Hält den gesamten Zustand im Speicher
 * und ist die einzige Instanz, die Züge prüft und anwendet.
 */
export class Hub {
  private players = new Map<string, Player>();
  private byToken = new Map<string, Player>();
  private tables = new Map<string, Table>();
  private seatTokens = new Map<string, { tableId: string; seat: Seat }>();

  constructor(
    private now: () => number = Date.now,
    private seed: () => number = () => randomInt(2 ** 31),
    private onEvent: TableEventListener = () => {}
  ) {}

  /**
   * Erste Nachricht einer Verbindung: neuer Spieler oder Wiederverbinden per Token.
   * Mit `seat` (Platz-Token eines reservierten Tisches) kommen Name und Platz aus der Reservierung.
   */
  hello(conn: Connection, name: string, token?: string, seat?: string): Player | null {
    const claim = seat ? this.seatTokens.get(seat) : undefined;
    if (seat && !claim) {
      conn.send({ t: "error", message: "Der Platz-Link ist ungültig oder abgelaufen" });
      return null;
    }
    const player = this.greet(conn, claim ? this.reservedName(claim) : name, token);
    if (player && claim) this.claimSeat(player, claim);
    return player;
  }

  private reservedName(claim: { tableId: string; seat: Seat }) {
    return this.tables.get(claim.tableId)?.reservation?.players[claim.seat].name ?? "";
  }

  private greet(conn: Connection, name: string, token?: string): Player | null {
    const existing = token ? this.byToken.get(token) : undefined;
    const clean = cleanName(name);
    if (existing) {
      if (existing.conn && existing.conn !== conn) existing.conn.send({ t: "error", message: "In einem anderen Fenster angemeldet" });
      existing.conn = conn;
      existing.disconnectedAt = null;
      if (clean) existing.name = clean;
      conn.send({ t: "welcome", playerId: existing.id, token: existing.token, name: existing.name });
      this.sendLobby(existing);
      const table = existing.tableId ? this.tables.get(existing.tableId) : undefined;
      if (table) this.broadcastTable(table);
      else conn.send({ t: "table", table: null });
      this.broadcastLobby();
      return existing;
    }
    if (!clean) {
      conn.send({ t: "error", message: "Bitte einen Namen eingeben" });
      return null;
    }
    const player: Player = {
      id: randomBytes(8).toString("hex"),
      token: randomBytes(24).toString("base64url"),
      name: clean,
      conn,
      disconnectedAt: null,
      tableId: null
    };
    this.players.set(player.id, player);
    this.byToken.set(player.token, player);
    conn.send({ t: "welcome", playerId: player.id, token: player.token, name: player.name });
    conn.send({ t: "table", table: null });
    this.broadcastLobby();
    return player;
  }

  handle(player: Player, msg: ClientMessage) {
    switch (msg.t) {
      case "hello":
        return;
      case "createTable":
        return this.createTable(player, msg.name, msg.private);
      case "joinTable":
        return this.joinTable(player, msg.tableId, msg.code);
      case "leaveTable":
        return this.leaveTable(player, "hat den Tisch verlassen");
      case "chat":
        return this.chat(player, msg.scope, msg.text);
      case "preview":
        return this.preview(player, msg.move);
      case "move":
        return this.move(player, msg.move);
      case "rematch":
        return this.rematch(player);
    }
  }

  disconnect(player: Player, conn: Connection) {
    if (player.conn !== conn) return;
    player.conn = null;
    player.disconnectedAt = this.now();
    const table = player.tableId ? this.tables.get(player.tableId) : undefined;
    if (table) this.broadcastTable(table);
    this.broadcastLobby();
  }

  /** Regelmäßig aufrufen: gibt Plätze von Spielern frei, die nicht zurückgekommen sind. */
  sweep() {
    const now = this.now();
    for (const p of [...this.players.values()]) {
      if (p.conn || p.disconnectedAt === null) continue;
      const gone = now - p.disconnectedAt;
      if (p.tableId && gone >= RECONNECT_GRACE_MS) this.leaveTable(p, "ist nicht zurückgekommen");
      if (!p.tableId && gone >= FORGET_AFTER_MS) {
        this.players.delete(p.id);
        this.byToken.delete(p.token);
      }
    }
    for (const table of [...this.tables.values()]) {
      const r = table.reservation;
      if (!r || table.seats[0] || table.seats[1]) continue;
      if (!r.joined && now - r.createdAt >= RESERVATION_TTL_MS) this.dropReserved(table, "table.expired");
      else if (r.joined && now - r.lastActiveAt >= RESERVATION_IDLE_MS) this.dropReserved(table, "table.closed");
    }
  }

  // ——— Reservierte Tische (Integrationen) ———

  /** Legt einen privaten Tisch mit zwei festen Plätzen an; jeder Platz hat ein eigenes Token für den Link. */
  reserveTable(input: ReserveInput): ReservedTableInfo & { seats: [SeatTicket, SeatTicket] } {
    const names = input.players.map((p) => cleanName(p.name) ?? "Spieler") as [string, string];
    const tokens: [string, string] = [randomBytes(24).toString("base64url"), randomBytes(24).toString("base64url")];
    const table: Table = {
      id: randomBytes(6).toString("hex"),
      name: cleanName(input.name ?? "") ?? `${names[0]} gegen ${names[1]}`,
      code: this.newCode(),
      private: true,
      game: GAMES.shift!,
      hostName: names[0],
      seats: [null, null],
      status: "waiting",
      state: null,
      score: [0, 0],
      nextStart: 0,
      rematch: [false, false],
      endNote: null,
      reservation: {
        ref: input.ref ?? null,
        callbackUrl: input.callbackUrl ?? null,
        players: [
          { id: input.players[0].id, name: names[0] },
          { id: input.players[1].id, name: names[1] }
        ],
        tokens,
        createdAt: this.now(),
        lastActiveAt: this.now(),
        joined: false,
        winner: null,
        gamesPlayed: 0
      }
    };
    this.tables.set(table.id, table);
    this.seatTokens.set(tokens[0], { tableId: table.id, seat: 0 });
    this.seatTokens.set(tokens[1], { tableId: table.id, seat: 1 });
    return {
      ...this.reservedInfo(table),
      seats: [
        { playerId: input.players[0].id, seat: 0, token: tokens[0] },
        { playerId: input.players[1].id, seat: 1, token: tokens[1] }
      ]
    };
  }

  /** Stand eines reservierten Tisches; null, wenn es ihn nicht (mehr) gibt. */
  reservedTable(id: string): ReservedTableInfo | null {
    const table = this.tables.get(id);
    return table?.reservation ? this.reservedInfo(table) : null;
  }

  /** Schließt einen reservierten Tisch (z. B. abgesagte Herausforderung). */
  closeReserved(id: string): boolean {
    const table = this.tables.get(id);
    if (!table?.reservation) return false;
    for (const pid of table.seats) {
      const p = pid ? this.players.get(pid) : undefined;
      if (!p) continue;
      p.tableId = null;
      p.conn?.send({ t: "table", table: null });
      p.conn?.send({ t: "error", message: "Der Tisch wurde geschlossen" });
    }
    this.removeReserved(table);
    return true;
  }

  private claimSeat(player: Player, claim: { tableId: string; seat: Seat }) {
    const table = this.tables.get(claim.tableId);
    if (!table?.reservation) return player.conn?.send({ t: "error", message: "Der Tisch ist nicht mehr da" });
    if (player.tableId && player.tableId !== table.id) this.leaveTable(player, "hat den Tisch verlassen");
    const current = table.seats[claim.seat];
    if (current && current !== player.id) {
      // Derselbe Platz auf einem anderen Gerät: das neue Gerät übernimmt
      const old = this.players.get(current);
      if (old) {
        old.tableId = null;
        old.conn?.send({ t: "table", table: null });
        old.conn?.send({ t: "error", message: "Dein Platz wurde auf einem anderen Gerät übernommen" });
      }
    }
    table.seats[claim.seat] = player.id;
    player.tableId = table.id;
    table.reservation.joined = true;
    table.reservation.lastActiveAt = this.now();
    if (table.seats[0] && table.seats[1] && table.status === "waiting") this.startGame(table);
    this.broadcastTable(table);
    this.broadcastLobby();
  }

  private gameFinished(table: Table, winner: Seat, reason: "won" | "forfeit") {
    const r = table.reservation;
    if (!r) return;
    r.winner = r.players[winner].id;
    r.gamesPlayed++;
    r.lastActiveAt = this.now();
    this.emit(table, "game.finished", reason);
  }

  private dropReserved(table: Table, type: "table.expired" | "table.closed") {
    this.emit(table, type);
    this.removeReserved(table);
  }

  private removeReserved(table: Table) {
    for (const token of table.reservation?.tokens ?? []) this.seatTokens.delete(token);
    this.tables.delete(table.id);
    this.broadcastLobby();
  }

  private emit(table: Table, type: TableEvent["type"], reason?: TableEvent["reason"]) {
    const event: TableEvent = { type, at: new Date(this.now()).toISOString(), table: this.reservedInfo(table) };
    if (reason) event.reason = reason;
    try {
      this.onEvent(event, table.reservation?.callbackUrl ?? null);
    } catch (error) {
      console.error("[hub] Ereignis konnte nicht gemeldet werden", error);
    }
  }

  private reservedInfo(table: Table): ReservedTableInfo {
    const r = table.reservation!;
    return {
      id: table.id,
      code: table.code,
      ref: r.ref,
      status: table.status,
      players: r.players.map((p, i) => {
        const pid = table.seats[i];
        const live = pid ? this.players.get(pid) : undefined;
        return { id: p.id, name: p.name, seat: i as Seat, connected: Boolean(live?.conn), score: table.score[i]! };
      }),
      winner: r.winner,
      gamesPlayed: r.gamesPlayed
    };
  }

  // ——— Tische ———

  private createTable(player: Player, name: string, isPrivate: boolean) {
    if (player.tableId) this.leaveTable(player, "hat den Tisch verlassen");
    const table: Table = {
      id: randomBytes(6).toString("hex"),
      name: cleanName(name) ?? `Tisch von ${player.name}`,
      code: this.newCode(),
      private: isPrivate,
      game: GAMES.shift!,
      hostName: player.name,
      seats: [player.id, null],
      status: "waiting",
      state: null,
      score: [0, 0],
      nextStart: 0,
      rematch: [false, false],
      endNote: null,
      reservation: null
    };
    this.tables.set(table.id, table);
    player.tableId = table.id;
    this.broadcastTable(table);
    this.broadcastLobby();
  }

  private joinTable(player: Player, tableId?: string, code?: string) {
    const table = tableId
      ? this.tables.get(tableId)
      : code
        ? [...this.tables.values()].find((t) => t.code === code.trim().toUpperCase())
        : undefined;
    if (!table || (tableId && table.private)) return player.conn?.send({ t: "error", message: "Tisch nicht gefunden" });
    if (table.reservation && !table.seats.includes(player.id)) {
      return player.conn?.send({ t: "error", message: "Dieser Tisch ist reserviert" });
    }
    if (table.seats.includes(player.id)) return this.broadcastTable(table);
    const free = table.seats.indexOf(null);
    if (free < 0) return player.conn?.send({ t: "error", message: "Der Tisch ist schon voll" });
    if (player.tableId) this.leaveTable(player, "hat den Tisch verlassen");
    table.seats[free] = player.id;
    player.tableId = table.id;
    if (table.seats[0] && table.seats[1]) this.startGame(table);
    this.broadcastTable(table);
    this.broadcastLobby();
  }

  private leaveTable(player: Player, why: string) {
    const table = player.tableId ? this.tables.get(player.tableId) : undefined;
    player.tableId = null;
    player.conn?.send({ t: "table", table: null });
    if (!table) return;
    const index = table.seats.indexOf(player.id);
    if (index < 0) return;
    const seat = index as Seat;
    table.seats[seat] = null;
    if (table.status === "playing") {
      const winner = otherSeat(seat);
      table.score[winner]++;
      table.status = "finished";
      table.endNote = `${player.name} ${why}`;
      this.gameFinished(table, winner, "forfeit");
    } else if (table.status === "finished") {
      table.endNote = `${player.name} ${why}`;
    }
    if (table.reservation) {
      // Reservierte Tische behalten ihre Plätze und den Stand; man kommt über den Platz-Link zurück.
      table.reservation.lastActiveAt = this.now();
      table.rematch = [false, false];
      this.broadcastTable(table);
    } else if (!table.seats[0] && !table.seats[1]) {
      this.tables.delete(table.id);
    } else {
      // Wer bleibt, wartet auf einen neuen Gegner
      table.status = "waiting";
      table.rematch = [false, false];
      table.score = [0, 0];
      const remaining = table.seats[0] ?? table.seats[1];
      if (table.seats[0] === null && remaining) {
        table.seats = [remaining, null];
      }
      this.broadcastTable(table);
    }
    this.broadcastLobby();
  }

  private startGame(table: Table) {
    table.state = table.game.createInitialState({ seed: this.seed(), startingSeat: table.nextStart });
    table.nextStart = otherSeat(table.nextStart);
    table.status = "playing";
    table.rematch = [false, false];
    table.endNote = null;
  }

  private rematch(player: Player) {
    const table = player.tableId ? this.tables.get(player.tableId) : undefined;
    if (!table || table.status !== "finished") return;
    const index = table.seats.indexOf(player.id);
    if (index < 0) return;
    table.rematch[index as Seat] = true;
    if (table.rematch[0] && table.rematch[1] && table.seats[0] && table.seats[1]) this.startGame(table);
    this.broadcastTable(table);
    this.broadcastLobby();
  }

  // ——— Spielzüge ———

  private preview(player: Player, raw: unknown) {
    const ctx = this.playing(player);
    if (!ctx || ctx.table.game.currentSeat(ctx.table.state) !== ctx.seat) return;
    const move = raw === null ? null : ctx.table.game.parseMove(raw);
    if (raw !== null && move === null) return;
    const opponent = this.players.get(ctx.table.seats[otherSeat(ctx.seat)] ?? "");
    opponent?.conn?.send({ t: "preview", seat: ctx.seat, move });
  }

  private publicView(table: Table, state: unknown) {
    return state === null ? null : (table.game.publicView?.(state) ?? state);
  }

  private move(player: Player, raw: unknown) {
    const ctx = this.playing(player);
    if (!ctx) return player.conn?.send({ t: "error", message: "Gerade läuft keine Partie" });
    const { table, seat } = ctx;
    const move = table.game.parseMove(raw);
    if (move === null) return player.conn?.send({ t: "error", message: "Ungültiger Zug" });
    const check = table.game.checkMove(table.state, seat, move);
    if (!check.ok) return player.conn?.send({ t: "error", message: check.reason });
    const before = table.state;
    const { state, events } = table.game.applyMove(before, seat, move);
    table.state = state;
    const result = table.game.result(state);
    if (result.kind === "won") {
      table.score[result.winner]++;
      table.status = "finished";
      this.gameFinished(table, result.winner, "won");
    }
    for (const id of table.seats) {
      this.players.get(id ?? "")?.conn?.send({ t: "moved", seat, before: this.publicView(table, before), move, after: this.publicView(table, state), events });
    }
    this.broadcastTable(table);
    if (result.kind === "won") this.broadcastLobby();
  }

  private playing(player: Player) {
    const table = player.tableId ? this.tables.get(player.tableId) : undefined;
    if (!table || table.status !== "playing") return null;
    const seat = table.seats.indexOf(player.id);
    if (seat < 0) return null;
    return { table, seat: seat as Seat };
  }

  // ——— Chat ———

  private chat(player: Player, scope: "lobby" | "table", text: string) {
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!clean) return;
    const msg: ServerMessage = { t: "chat", scope, from: player.name, text: clean, at: this.now() };
    if (scope === "lobby") {
      for (const p of this.players.values()) p.conn?.send(msg);
      return;
    }
    const table = player.tableId ? this.tables.get(player.tableId) : undefined;
    if (!table) return;
    for (const id of table.seats) this.players.get(id ?? "")?.conn?.send(msg);
  }

  // ——— Sicht für die Clients ———

  private viewFor(table: Table, playerId: string): TableView {
    const seatInfo = (id: string | null) => {
      const p = id ? this.players.get(id) : undefined;
      return p ? { name: p.name, connected: p.conn !== null } : null;
    };
    const mySeat = table.seats.indexOf(playerId);
    return {
      id: table.id,
      name: table.name,
      game: table.game.id,
      code: table.code,
      private: table.private,
      seats: [seatInfo(table.seats[0]), seatInfo(table.seats[1])],
      status: table.status,
      mySeat: mySeat < 0 ? null : (mySeat as Seat),
      state: this.publicView(table, table.state),
      score: [table.score[0], table.score[1]],
      rematch: [table.rematch[0], table.rematch[1]],
      endNote: table.endNote,
      reserved: table.reservation !== null
    };
  }

  private broadcastTable(table: Table) {
    for (const id of table.seats) {
      const p = id ? this.players.get(id) : undefined;
      p?.conn?.send({ t: "table", table: this.viewFor(table, p.id) });
    }
  }

  lobbySnapshot(): { tables: TableSummary[]; online: OnlinePlayer[] } {
    const tables = [...this.tables.values()]
      .filter((t) => !t.private)
      .map((t) => ({
        id: t.id,
        name: t.name,
        game: t.game.id,
        host: t.hostName,
        players: t.seats.flatMap((id) => (id ? [this.players.get(id)?.name ?? "?"] : [])),
        status: t.status
      }));
    const online = [...this.players.values()]
      .filter((p) => p.conn)
      .map((p) => {
        const t = p.tableId ? this.tables.get(p.tableId) : undefined;
        const status: OnlinePlayer["status"] = !t ? "lobby" : t.status === "waiting" ? "waiting" : "playing";
        return { id: p.id, name: p.name, status };
      });
    return { tables, online };
  }

  private sendLobby(p: Player) {
    p.conn?.send({ t: "lobby", ...this.lobbySnapshot() });
  }

  private broadcastLobby() {
    const snap = this.lobbySnapshot();
    for (const p of this.players.values()) p.conn?.send({ t: "lobby", ...snap });
  }

  private newCode() {
    for (;;) {
      let code = "";
      for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (![...this.tables.values()].some((t) => t.code === code)) return code;
    }
  }
}
