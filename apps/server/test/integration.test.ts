import type { ServerMessage, TableView } from "@dreierschub/protocol";
import express from "express";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Hub, RESERVATION_IDLE_MS, RESERVATION_TTL_MS, type Connection, type TableEvent } from "../src/hub";
import { createEventSender, integrationRouter, signPayload } from "../src/integration";

class FakeConn implements Connection {
  messages: ServerMessage[] = [];
  send(m: ServerMessage) {
    this.messages.push(m);
  }
  last<T extends ServerMessage["t"]>(t: T) {
    return [...this.messages].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
  table(): TableView | null {
    return this.last("table")?.table ?? null;
  }
}

function setup() {
  let now = 1_000;
  const events: Array<{ event: TableEvent; url: string | null }> = [];
  const hub = new Hub(() => now, () => 42, (event, url) => events.push({ event, url }));
  const reserved = hub.reserveTable({
    players: [
      { id: "u-anna", name: "Anna" },
      { id: "u-bob", name: "Bob" }
    ],
    ref: "match-1",
    callbackUrl: "http://matchdesk/api/m/arena/webhook"
  });
  return { hub, events, reserved, tick: (ms: number) => (now += ms) };
}

describe("Reservierte Tische", () => {
  it("setzt Spieler per Platz-Token mit Namen aus der Reservierung und startet die Partie", () => {
    const { hub, reserved } = setup();
    const a = new FakeConn();
    const b = new FakeConn();
    hub.hello(a, "", undefined, reserved.seats[0].token);
    expect(a.last("welcome")?.name).toBe("Anna");
    expect(a.table()).toMatchObject({ status: "waiting", reserved: true, mySeat: 0 });
    hub.hello(b, "egal", undefined, reserved.seats[1].token);
    expect(b.last("welcome")?.name).toBe("Bob");
    expect(a.table()?.status).toBe("playing");
    expect(hub.reservedTable(reserved.id)?.players.map((p) => p.connected)).toEqual([true, true]);
  });

  it("lehnt unbekannte Platz-Token und fremde Beitritte per Code ab", () => {
    const { hub, reserved } = setup();
    const x = new FakeConn();
    expect(hub.hello(x, "Mallory", undefined, "falsch")).toBeNull();
    expect(x.last("error")?.message).toMatch(/ungültig/);
    const p = hub.hello(x, "Mallory")!;
    hub.handle(p, { t: "joinTable", code: reserved.code });
    expect(x.last("error")?.message).toBe("Dieser Tisch ist reserviert");
  });

  it("meldet Aufgabe als Ergebnis mit externer Sieger-ID und behält den leeren Tisch", () => {
    const { hub, reserved, events } = setup();
    const a = new FakeConn();
    const b = new FakeConn();
    const pa = hub.hello(a, "", undefined, reserved.seats[0].token)!;
    hub.hello(b, "", undefined, reserved.seats[1].token);
    hub.handle(pa, { t: "leaveTable" });
    expect(events).toHaveLength(1);
    expect(events[0]!.url).toBe("http://matchdesk/api/m/arena/webhook");
    expect(events[0]!.event).toMatchObject({ type: "game.finished", reason: "forfeit", table: { ref: "match-1", winner: "u-bob", gamesPlayed: 1 } });
    expect(events[0]!.event.table.players.map((p) => p.score)).toEqual([0, 1]);
    expect(hub.reservedTable(reserved.id)?.status).toBe("finished");
    // Anna kommt über ihren Link zurück, Bob kann Revanche fordern
    hub.hello(a, "", undefined, reserved.seats[0].token);
    expect(a.table()?.mySeat).toBe(0);
  });

  it("übernimmt den Platz auf einem zweiten Gerät", () => {
    const { hub, reserved } = setup();
    const a1 = new FakeConn();
    const a2 = new FakeConn();
    hub.hello(a1, "", undefined, reserved.seats[0].token);
    hub.hello(a2, "", undefined, reserved.seats[0].token);
    expect(a2.table()?.mySeat).toBe(0);
    expect(a1.table()).toBeNull();
    expect(a1.last("error")?.message).toMatch(/anderen Gerät/);
  });

  it("lässt unbenutzte Tische verfallen und schließt verlassene nach Leerlauf", () => {
    const { hub, reserved, events, tick } = setup();
    tick(RESERVATION_TTL_MS + 1);
    hub.sweep();
    expect(hub.reservedTable(reserved.id)).toBeNull();
    expect(events.at(-1)?.event.type).toBe("table.expired");

    const second = hub.reserveTable({ players: [{ id: "1", name: "A" }, { id: "2", name: "B" }] });
    const a = new FakeConn();
    const pa = hub.hello(a, "", undefined, second.seats[0].token)!;
    hub.handle(pa, { t: "leaveTable" });
    tick(RESERVATION_IDLE_MS + 1);
    hub.sweep();
    expect(hub.reservedTable(second.id)).toBeNull();
    expect(events.at(-1)?.event.type).toBe("table.closed");
  });

  it("schließt einen Tisch auf Wunsch der Integration", () => {
    const { hub, reserved } = setup();
    const a = new FakeConn();
    hub.hello(a, "", undefined, reserved.seats[0].token);
    expect(hub.closeReserved(reserved.id)).toBe(true);
    expect(a.table()).toBeNull();
    expect(hub.reservedTable(reserved.id)).toBeNull();
  });
});

describe("HTTP-Schnittstelle /api/integrations/v1", () => {
  let close: (() => void) | null = null;
  afterEach(() => close?.());

  async function serve(apiKey: string | undefined) {
    const hub = new Hub();
    const app = express();
    app.use("/api/integrations/v1", integrationRouter(hub, apiKey));
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/integrations/v1`;
    return { hub, base };
  }

  const body = { ref: "m1", players: [{ id: "a", name: "Anna" }, { id: "b", name: "Bob" }] };

  it("verlangt den API-Schlüssel und ist ohne Schlüssel aus", async () => {
    const off = await serve(undefined);
    expect((await fetch(`${off.base}/tables`, { method: "POST" })).status).toBe(503);
    close?.();
    const { base } = await serve("geheim");
    const res = await fetch(`${base}/tables`, { method: "POST", headers: { authorization: "Bearer falsch" } });
    expect(res.status).toBe(401);
  });

  it("legt einen Tisch an, zeigt den Stand und schließt ihn", async () => {
    const { base } = await serve("geheim");
    const auth = { authorization: "Bearer geheim", "content-type": "application/json" };
    const created = await fetch(`${base}/tables`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const table = (await created.json()) as { id: string; seats: Array<{ playerId: string; token: string }>; status: string };
    expect(table.status).toBe("waiting");
    expect(table.seats.map((s) => s.playerId)).toEqual(["a", "b"]);
    const info = await fetch(`${base}/tables/${table.id}`, { headers: auth });
    expect(await info.json()).toMatchObject({ ref: "m1", players: [{ name: "Anna" }, { name: "Bob" }] });
    expect((await fetch(`${base}/tables/${table.id}`, { method: "DELETE", headers: auth })).status).toBe(204);
    expect((await fetch(`${base}/tables/${table.id}`, { headers: auth })).status).toBe(404);
  });

  it("weist ungültige Anfragen ab", async () => {
    const { base } = await serve("geheim");
    const res = await fetch(`${base}/tables`, {
      method: "POST",
      headers: { authorization: "Bearer geheim", "content-type": "application/json" },
      body: JSON.stringify({ players: [{ id: "a", name: "Anna" }] })
    });
    expect(res.status).toBe(400);
  });
});

describe("Ereignis-Versand", () => {
  it("signiert den Body mit HMAC-SHA256 über Zeitstempel und Body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const send = createEventSender("s3cret", fakeFetch);
    const event: TableEvent = {
      type: "game.finished",
      at: "2026-11-22T12:00:00.000Z",
      table: { id: "t", code: "ABCDE", ref: "m1", status: "finished", players: [], winner: "a", gamesPlayed: 1 }
    };
    send(event, "http://example.test/hook");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    const ts = headers["x-bandenduell-timestamp"]!;
    const expected = "sha256=" + createHmac("sha256", "s3cret").update(`${ts}.${calls[0]!.init.body}`).digest("hex");
    expect(headers["x-bandenduell-signature"]).toBe(expected);
    expect(signPayload("s3cret", ts, String(calls[0]!.init.body))).toBe(expected);
  });
});
