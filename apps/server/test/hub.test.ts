import type { PublicShiftState } from "@dreierschub/shift";
import type { ServerMessage, TableView } from "@dreierschub/protocol";
import { describe, expect, it } from "vitest";
import { Hub, RECONNECT_GRACE_MS, type Connection } from "../src/hub";

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
  const hub = new Hub(() => now, () => 42);
  const a = new FakeConn();
  const b = new FakeConn();
  const pa = hub.hello(a, "René")!;
  const pb = hub.hello(b, "Mia")!;
  return { hub, a, b, pa, pb, tick: (ms: number) => (now += ms) };
}

const move = { side: "top", index: 2 };

describe("Lobby und Tische", () => {
  it("startet die Partie, sobald zwei Spieler sitzen", () => {
    const { hub, a, b, pa, pb } = setup();
    hub.handle(pa, { t: "createTable", name: "Feierabend", private: false });
    expect(a.table()?.status).toBe("waiting");
    const listed = b.last("lobby")!.tables;
    expect(listed.map((t) => t.name)).toEqual(["Feierabend"]);
    hub.handle(pb, { t: "joinTable", tableId: listed[0]!.id });
    expect(a.table()?.status).toBe("playing");
    expect(b.table()?.mySeat).toBe(1);
    expect(a.table()?.seats.map((s) => s?.name)).toEqual(["René", "Mia"]);
  });

  it("zeigt private Tische nicht in der Lobby, Beitritt per Code klappt", () => {
    const { hub, a, b, pa, pb } = setup();
    hub.handle(pa, { t: "createTable", name: "Geheim", private: true });
    expect(b.last("lobby")!.tables).toHaveLength(0);
    const code = a.table()!.code;
    hub.handle(pb, { t: "joinTable", code: code.toLowerCase() });
    expect(b.table()?.status).toBe("playing");
  });

  it("lässt nur den Spieler am Zug schieben und schickt beiden das Ergebnis", () => {
    const { hub, a, b, pa, pb } = setup();
    hub.handle(pa, { t: "createTable", name: "T", private: false });
    hub.handle(pb, { t: "joinTable", code: a.table()!.code });
    hub.handle(pb, { t: "move", move });
    expect(b.last("error")?.message).toBe("Du bist nicht am Zug.");
    hub.handle(pa, { t: "move", move });
    expect(a.last("moved")).toBeDefined();
    expect(b.last("moved")?.seat).toBe(0);
    const state = a.table()!.state as PublicShiftState;
    expect(state.moves).toBe(1);
    expect(state.turn).toBe(1);
    // Zufallszustand bleibt auf dem Server
    expect("rng" in state).toBe(false);
    expect("rng" in (b.last("moved")!.after as object)).toBe(false);
  });

  it("lehnt kaputte Züge ab", () => {
    const { hub, a, pa, pb } = setup();
    hub.handle(pa, { t: "createTable", name: "T", private: false });
    hub.handle(pb, { t: "joinTable", code: a.table()!.code });
    hub.handle(pa, { t: "move", move: { side: "diagonal", index: 1 } });
    expect(a.last("error")?.message).toBe("Ungültiger Zug");
  });

  it("leitet die Vorschau an den Gegner weiter", () => {
    const { hub, a, b, pa, pb } = setup();
    hub.handle(pa, { t: "createTable", name: "T", private: false });
    hub.handle(pb, { t: "joinTable", code: a.table()!.code });
    hub.handle(pa, { t: "preview", move: { side: "left", index: 3 } });
    expect(b.last("preview")).toMatchObject({ seat: 0, move: { side: "left", index: 3 } });
    hub.handle(pb, { t: "preview", move: { side: "left", index: 1 } });
    expect(a.last("preview")).toBeUndefined();
  });

  it("hält den Platz beim Wiederverbinden und wertet Fernbleiben als Aufgabe", () => {
    const { hub, a, b, pa, pb, tick } = setup();
    hub.handle(pa, { t: "createTable", name: "T", private: false });
    hub.handle(pb, { t: "joinTable", code: a.table()!.code });
    hub.disconnect(pb, b);
    expect(a.table()?.seats[1]?.connected).toBe(false);
    const b2 = new FakeConn();
    hub.hello(b2, "Mia", pb.token);
    expect(b2.table()?.mySeat).toBe(1);
    expect(a.table()?.seats[1]?.connected).toBe(true);

    hub.disconnect(pb, b2);
    tick(RECONNECT_GRACE_MS + 1);
    hub.sweep();
    expect(a.table()?.status).toBe("waiting");
    expect(a.table()?.endNote).toBe("Mia ist nicht zurückgekommen");
  });

  it("startet nach Spielende eine Revanche, wenn beide wollen", () => {
    const { hub, a, b, pa, pb } = setup();
    hub.handle(pa, { t: "createTable", name: "T", private: false });
    hub.handle(pb, { t: "joinTable", code: a.table()!.code });
    // Partie künstlich beenden: Spieler 2 gibt auf, kommt dann wieder an den Tisch
    hub.handle(pb, { t: "leaveTable" });
    expect(a.table()?.status).toBe("waiting");
    hub.handle(pb, { t: "joinTable", code: a.table()!.code });
    expect(a.table()?.status).toBe("playing");
    expect(b.table()?.mySeat).toBe(1);
  });

  it("verteilt Lobby-Chat an alle und Tisch-Chat nur an den Tisch", () => {
    const { hub, a, b, pa, pb } = setup();
    const c = new FakeConn();
    hub.hello(c, "Jonas");
    hub.handle(pa, { t: "chat", scope: "lobby", text: "Hallo" });
    expect(c.last("chat")?.text).toBe("Hallo");
    hub.handle(pa, { t: "createTable", name: "T", private: false });
    hub.handle(pb, { t: "joinTable", code: a.table()!.code });
    hub.handle(pb, { t: "chat", scope: "table", text: "Viel Glück" });
    expect(a.last("chat")?.text).toBe("Viel Glück");
    expect(c.last("chat")?.text).toBe("Hallo");
    expect(b.last("chat")?.from).toBe("Mia");
  });
});
