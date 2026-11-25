import type { BotLevel } from "@dreierschub/shift";
import type { Seat } from "@dreierschub/core";
import type { TableView as TableInfo } from "@dreierschub/protocol";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import type { Snapshot, TableController } from "./controller";
import { HotseatGame } from "./hotseat";
import { NetClient, type ChatLine } from "./net";
import { OnlineTable } from "./online";
import { BOT_LEVELS, SoloGame } from "./solo";
import { Board } from "./Board";

/** Einbett-Modus (z. B. in Matchdesk): `?embed=1`, meist mit Platz-Link `?seat=…`. */
const params = new URL(location.href).searchParams;
const EMBED = params.get("embed") === "1";
/** Eingebettete Partie gegen den Computer: `?embed=1&solo=easy|medium|hard&name=…`, ohne Server. */
const EMBED_SOLO = EMBED ? soloLevel(params.get("solo")) : null;

function soloLevel(value: string | null): BotLevel | null {
  return BOT_LEVELS.some((level) => level.id === value) ? (value as BotLevel) : null;
}

export function App() {
  if (EMBED_SOLO) return <PracticeScreen playerName={params.get("name")?.trim().slice(0, 24) || "Spieler"} initialMode={EMBED_SOLO} embed />;
  return <OnlineApp />;
}

function OnlineApp() {
  const net = useMemo(() => new NetClient(), []);
  const ns = useSyncExternalStore(net.subscribe, net.getState);
  const [practice, setPractice] = useState(false);

  useEffect(() => {
    const url = new URL(location.href);
    const code = url.searchParams.get("t");
    const seat = url.searchParams.get("seat");
    if (code) {
      net.joinOnConnect(code);
      url.searchParams.delete("t");
    }
    if (seat) url.searchParams.delete("seat");
    if (code || seat) history.replaceState(null, "", url.pathname + url.search);
    if (seat) return net.connectSeat(seat);
    const saved = NetClient.savedName();
    if (saved) net.connect(saved);
  }, [net]);

  useEmbedMessages(ns.table, ns.status);

  if (EMBED && !ns.table) return <EmbedWaiting status={ns.status} error={ns.error} />;
  if (practice) return <PracticeScreen playerName={ns.me?.name ?? "Spieler"} onExit={() => setPractice(false)} />;
  if (ns.status === "idle") return <NameScreen onSubmit={(name) => net.connect(name)} onPractice={() => setPractice(true)} />;
  if (ns.table) return <TableScreen net={net} table={ns.table} />;
  return <LobbyScreen net={net} onPractice={() => setPractice(true)} />;
}

// ——— Einbettung ———

/**
 * Meldet dem einbettenden Fenster (z. B. Matchdesk) den Stand per `postMessage`:
 * `ready` beim ersten Tisch, `status` bei jeder Änderung, `matchEnded` beim Partieende.
 * Ziel ist nur die eigene Herkunft, weil das Spiel unter derselben Adresse eingebettet wird.
 * `source: "bandenduell"` ist die gemeinsame Kennung, auf die das Modul „arena“ für alle Spiele hört.
 */
function useEmbedMessages(table: TableInfo | null, status: string) {
  const last = useRef<{ id: string; status: string; games: number } | null>(null);
  useEffect(() => {
    if (!EMBED || window.parent === window) return;
    const post = (type: string, extra: Record<string, unknown> = {}) =>
      window.parent.postMessage({ source: "bandenduell", type, ...extra }, location.origin);
    if (!table) {
      if (last.current && status === "online") post("closed");
      last.current = null;
      return;
    }
    const games = table.score[0] + table.score[1];
    const payload = { status: table.status, score: table.score, mySeat: table.mySeat, seats: table.seats.map((s) => s?.name ?? null) };
    if (!last.current || last.current.id !== table.id) post("ready", payload);
    else post("status", payload);
    if (table.status === "finished" && (last.current?.status !== "finished" || last.current.games !== games)) post("matchEnded", payload);
    last.current = { id: table.id, status: table.status, games };
  }, [table, status]);
}

function EmbedWaiting({ status, error }: { status: string; error: string | null }) {
  return (
    <div className="app embed">
      <main className="center-screen">
        <div className="card name-card">
          {error ? <p className="warn">{error}</p> : <p className="muted">{status === "online" ? "Kein Tisch geöffnet." : "Verbinde mit dem Tisch …"}</p>}
        </div>
      </main>
    </div>
  );
}

// ——— Rahmen ———

function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="brand">
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
          <rect x="2" y="2" width="11" height="11" rx="2.5" fill="#2BA6A0" />
          <rect x="15" y="2" width="11" height="11" rx="2.5" fill="#2BA6A0" />
          <rect x="2" y="15" width="11" height="11" rx="2.5" fill="#2BA6A0" />
          <rect x="15" y="15" width="11" height="11" rx="2.5" fill="#F0823C" />
        </svg>
        <span>Dreierschub</span>
      </div>
      <div className="topbar-right">{children}</div>
    </header>
  );
}

function ConnectionBadge({ status }: { status: string }) {
  if (status === "online") return null;
  return <span className="conn-badge">{status === "connecting" ? "Verbinde …" : "Verbindung getrennt, versuche es erneut …"}</span>;
}

function ErrorToast({ net, message }: { net: NetClient; message: string | null }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => net.clearError(), 4000);
    return () => clearTimeout(t);
  }, [net, message]);
  if (!message) return null;
  return (
    <div className="toast" role="alert">
      {message}
    </div>
  );
}

// ——— Name ———

function NameScreen({ onSubmit, onPractice }: { onSubmit: (name: string) => void; onPractice: () => void }) {
  const [name, setName] = useState("");
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <div className="app">
      <TopBar />
      <main className="center-screen">
        <form className="card name-card" onSubmit={submit}>
          <h1>Dreierschub für zwei</h1>
          <p className="muted">Gib dir einen Namen, dann siehst du die offenen Tische. Ein Konto brauchst du nicht.</p>
          <label htmlFor="player-name">Dein Name</label>
          <input id="player-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoFocus autoComplete="nickname" />
          <button type="submit" className="primary" disabled={!name.trim()}>
            Weiter zur Lobby
          </button>
          <button type="button" className="ghost" onClick={onPractice}>
            Allein gegen den Computer spielen
          </button>
        </form>
      </main>
    </div>
  );
}

// ——— Lobby ———

function LobbyScreen({ net, onPractice }: { net: NetClient; onPractice: () => void }) {
  const ns = useSyncExternalStore(net.subscribe, net.getState);
  const [tableName, setTableName] = useState("");
  const [code, setCode] = useState("");
  const create = (priv: boolean) => net.send({ t: "createTable", name: tableName.trim() || `Tisch von ${ns.me?.name ?? ""}`, private: priv });
  const join = (ev: FormEvent) => {
    ev.preventDefault();
    if (code.trim()) net.send({ t: "joinTable", code: code.trim() });
  };
  return (
    <div className="app">
      <TopBar>
        <ConnectionBadge status={ns.status} />
        <span className="me">{ns.me?.name}</span>
      </TopBar>
      <ErrorToast net={net} message={ns.error} />
      <div className="lobby">
        <main className="lobby-main">
          <div className="lobby-head">
            <div>
              <h1>Offene Tische</h1>
              <p className="muted">Setz dich an einen freien Platz oder eröffne einen eigenen Tisch.</p>
            </div>
          </div>
          <div className="card create-card">
            <label htmlFor="table-name">Tischname</label>
            <div className="row wrap">
              <input id="table-name" value={tableName} onChange={(e) => setTableName(e.target.value)} maxLength={40} placeholder={`Tisch von ${ns.me?.name ?? ""}`} />
              <button type="button" className="primary" onClick={() => create(false)}>
                Tisch eröffnen
              </button>
              <button type="button" className="ghost" onClick={() => create(true)}>
                Privat mit Einladungslink
              </button>
            </div>
          </div>
          <div className="table-list" role="list" aria-label="Offene Tische">
            {ns.tables.length === 0 && <p className="muted empty">Gerade ist kein Tisch offen. Eröffne einen und schick den Link an jemanden.</p>}
            {ns.tables.map((t) => {
              const open = t.status === "waiting" && t.players.length < 2;
              return (
                <div key={t.id} className="table-row" role="listitem">
                  <div className="table-row-main">
                    <strong>{t.name}</strong>
                    <span className="muted">{t.players.join(" gegen ") || t.host}</span>
                  </div>
                  <span className="chip">Dreierschub</span>
                  <span className={`status-dot ${open ? "open" : "busy"}`}>{open ? "wartet" : t.status === "playing" ? "läuft" : "beendet"}</span>
                  {open ? (
                    <button type="button" className="primary" onClick={() => net.send({ t: "joinTable", tableId: t.id })}>
                      Beitreten
                    </button>
                  ) : (
                    <span className="muted small">voll</span>
                  )}
                </div>
              );
            })}
          </div>
        </main>
        <aside className="lobby-side">
          <form className="card" onSubmit={join}>
            <h2>Mit Code beitreten</h2>
            <label htmlFor="join-code">Code eines Freundes</label>
            <div className="row">
              <input id="join-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} placeholder="z. B. K7QMX" autoCapitalize="characters" />
              <button type="submit" className="ghost">
                Beitreten
              </button>
            </div>
          </form>
          <div className="card">
            <h2>Online ({ns.online.length})</h2>
            <ul className="online-list">
              {ns.online.map((p) => (
                <li key={p.id}>
                  <span>{p.name}</span>
                  <span className="muted small">{p.status === "lobby" ? "in der Lobby" : p.status === "waiting" ? "wartet am Tisch" : "spielt"}</span>
                </li>
              ))}
            </ul>
          </div>
          <Chat lines={ns.lobbyChat} title="Lobby-Chat" onSend={(text) => net.send({ t: "chat", scope: "lobby", text })} />
          <button type="button" className="ghost wide" onClick={onPractice}>
            Allein gegen den Computer spielen
          </button>
        </aside>
      </div>
    </div>
  );
}

function Chat({ lines, title, onSend }: { lines: ChatLine[]; title: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [lines.length]);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  const id = `chat-${title.replace(/\W/g, "")}`;
  return (
    <section className="card chat">
      <h2>{title}</h2>
      <ol ref={list} className="chat-lines" aria-live="polite">
        {lines.length === 0 && <li className="muted small">Noch keine Nachrichten.</li>}
        {lines.map((l, i) => (
          <li key={i}>
            <strong>{l.from}</strong> {l.text}
          </li>
        ))}
      </ol>
      <form className="row" onSubmit={submit}>
        <label htmlFor={id} className="sr-only">
          Nachricht
        </label>
        <input id={id} value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Nachricht schreiben" />
        <button type="submit" className="primary">
          Senden
        </button>
      </form>
    </section>
  );
}

// ——— Online-Tisch ———

function TableScreen({ net, table }: { net: NetClient; table: TableInfo }) {
  const ns = useSyncExternalStore(net.subscribe, net.getState);
  const [game, setGame] = useState<OnlineTable | null>(null);
  const tableId = table.id;
  const hasState = table.state !== null;

  useEffect(() => {
    if (!hasState) return;
    const g = new OnlineTable(net, net.getState().table!);
    setGame(g);
    return () => g.dispose();
  }, [net, tableId, hasState]);

  useEffect(() => {
    if (game && table.state) game.update(table);
  }, [game, table]);

  useEffect(() => {
    if (ns.error) game?.resync();
  }, [ns.error, game]);

  const invite = `${new URL(".", location.href).href}?t=${table.code}`;
  const opponentSeat: Seat | null = table.mySeat === null ? null : table.mySeat === 0 ? 1 : 0;
  const opponent = opponentSeat === null ? null : table.seats[opponentSeat];

  const side = (
    <>
      <section className="card">
        <h2>{table.name}</h2>
        {table.status === "waiting" && table.reserved && (
          <p className="muted">Warte auf deinen Gegner. Die Einladung ist schon unterwegs.</p>
        )}
        {table.status === "waiting" && !table.reserved && (
          <>
            <p className="muted">Warte auf einen Gegner. Schick diesen Link oder den Code:</p>
            <InviteBox link={invite} code={table.code} />
          </>
        )}
        {table.status === "playing" && opponent && !opponent.connected && <p className="warn">{opponent.name} ist getrennt. Der Platz bleibt eine Minute frei.</p>}
        {table.status === "finished" && (
          <>
            <p>
              Stand {table.score[0]} : {table.score[1]}
            </p>
            {table.mySeat !== null && (
              <button type="button" className="primary wide" disabled={table.rematch[table.mySeat]} onClick={() => net.send({ t: "rematch" })}>
                {table.rematch[table.mySeat] ? "Warte auf Gegner …" : opponentSeat !== null && table.rematch[opponentSeat] ? "Revanche annehmen" : "Revanche"}
              </button>
            )}
          </>
        )}
        {table.endNote && <p className="muted small">{table.endNote}.</p>}
        <button type="button" className="ghost wide" onClick={() => net.send({ t: "leaveTable" })}>
          {table.status === "playing" ? "Aufgeben und Tisch verlassen" : "Tisch verlassen"}
        </button>
      </section>
      <Chat lines={ns.tableChat} title="Chat am Tisch" onSend={(text) => net.send({ t: "chat", scope: "table", text })} />
      {game && <GameLog game={game} />}
    </>
  );

  return (
    <div className={EMBED ? "app embed" : "app"}>
      {EMBED ? (
        <ConnectionBadge status={ns.status} />
      ) : (
        <TopBar>
          <ConnectionBadge status={ns.status} />
          <span className="me">{ns.me?.name}</span>
        </TopBar>
      )}
      <ErrorToast net={net} message={ns.error} />
      <div className="body">
        <main className="play">
          {game ? (
            <PlayArea game={game} seats={table.seats} score={table.score} mySeat={table.mySeat} />
          ) : (
            <div className="waiting-table">
              <div className="waiting-board">
                <p>Der Tisch ist bereit. Sobald jemand beitritt, geht es los.</p>
              </div>
            </div>
          )}
        </main>
        <aside className="side">{side}</aside>
      </div>
    </div>
  );
}

function InviteBox({ link, code }: { link: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: "Dreierschub", text: "Spiel eine Runde Dreierschub mit mir", url: link });
        return;
      }
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Abgebrochen oder nicht erlaubt: Link steht ja im Feld
    }
  };
  return (
    <div className="invite">
      <label htmlFor="invite-link" className="sr-only">
        Einladungslink
      </label>
      <div className="row">
        <input id="invite-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="ghost" onClick={copy}>
          {copied ? "Kopiert" : "Teilen"}
        </button>
      </div>
      <p className="code">
        Code <strong>{code}</strong>
      </p>
    </div>
  );
}

function GameLog({ game }: { game: TableController }) {
  const snap = useSyncExternalStore(game.subscribe, game.getSnapshot);
  if (snap.log.length === 0) return null;
  return (
    <section className="card">
      <h2>Spielverlauf</h2>
      <ol className="log" aria-live="polite">
        {snap.log.slice(-12).map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>
    </section>
  );
}

// ——— Solo: gegen den Computer oder frei üben ———

type SoloMode = BotLevel | "free";

function PracticeScreen({
  playerName,
  onExit,
  initialMode = "medium",
  embed = false
}: {
  playerName: string;
  onExit?: () => void;
  initialMode?: SoloMode;
  embed?: boolean;
}) {
  const [mode, setMode] = useState<SoloMode>(initialMode);
  const game = useMemo(() => (mode === "free" ? new HotseatGame(["Spieler 1", "Spieler 2"]) : new SoloGame(playerName, mode)), [mode, playerName]);
  useEffect(() => () => (game instanceof SoloGame ? game.dispose() : undefined), [game]);
  const names = game.getSnapshot().names;
  const newGame = (
    <button type="button" className={embed ? "ghost wide" : "ghost"} onClick={() => game.newGame()}>
      Neue Partie
    </button>
  );
  return (
    <div className={embed ? "app embed" : "app"}>
      {!embed && (
        <TopBar>
          {newGame}
          {onExit && (
            <button type="button" className="ghost" onClick={onExit}>
              Zurück
            </button>
          )}
        </TopBar>
      )}
      <div className="body">
        <main className="play">
          <PlayArea
            game={game}
            seats={[{ name: names[0], connected: true }, { name: names[1], connected: true }]}
            score={null}
            mySeat={mode === "free" ? null : 0}
          />
        </main>
        <aside className="side">
          <section className="card">
            <h2>Gegner</h2>
            <div className="segmented opponent" role="group" aria-label="Gegner wählen">
              {BOT_LEVELS.map((l) => (
                <button key={l.id} type="button" aria-pressed={mode === l.id} onClick={() => setMode(l.id)}>
                  {l.label}
                </button>
              ))}
              <button type="button" aria-pressed={mode === "free"} onClick={() => setMode("free")}>
                Zu zweit
              </button>
            </div>
            <p className="muted small">
              {mode === "free" ? "Zu zweit an einem Gerät: ihr schiebt abwechselnd." : "Du beginnst. Ein Wechsel der Stufe beginnt eine neue Partie."}
            </p>
            {embed && newGame}
          </section>
          <GameLog game={game} />
        </aside>
      </div>
    </div>
  );
}

// ——— Spielfläche ———

type SeatInfo = { name: string; connected: boolean } | null;

function PlayArea({ game, seats, score, mySeat }: { game: TableController; seats: [SeatInfo, SeatInfo]; score: [number, number] | null; mySeat: Seat | null }) {
  const snap = useSyncExternalStore(game.subscribe, game.getSnapshot);
  const { state } = snap;
  const myTurn = snap.canAct;
  const hint =
    snap.phase === "over"
      ? "Partie vorbei."
      : snap.phase === "animating"
        ? ""
        : myTurn
          ? "Du bist dran: Stein an den Rand führen und klicken. Am Handy an den Rand ziehen, dann bestätigen."
          : mySeat !== null
            ? `${snap.names[state.turn]} ist am Zug.`
            : "";
  return (
    <>
      <div className="players">
        <PlayerCard snap={snap} seat={0} info={seats[0]} me={mySeat === 0} />
        <div className="score">
          {score ? (
            <span className="small muted" title="Gewonnene Partien">
              Partien {score[0]} : {score[1]}
            </span>
          ) : (
            <span className="small muted">Solo</span>
          )}
        </div>
        <PlayerCard snap={snap} seat={1} info={seats[1]} me={mySeat === 1} />
      </div>
      <Board game={game} />
      <p className="hint" aria-live="polite">
        {hint}
      </p>
    </>
  );
}

function PlayerCard({ snap, seat, info, me }: { snap: Snapshot; seat: Seat; info: SeatInfo; me: boolean }) {
  const { state, phase } = snap;
  const active = state.turn === seat && phase !== "over";
  const won = state.winner === seat;
  const status = won ? "Gewonnen" : info && !info.connected ? "getrennt" : state.winner !== null ? "Verloren" : active ? "Am Zug" : "wartet";
  const name = info?.name ?? "frei";
  const points = state.scores[seat];
  return (
    <div className={`player ${seat === 1 ? "right" : ""} ${active || won ? "active" : ""}`} data-seat={seat}>
      <div className="avatar" style={{ background: seat === 0 ? "#FF8A1F" : "#2D9CDB", color: "#FFFFFF" }}>
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className="player-body">
        <div className="player-row">
          <span className="name">
            {name}
            {me && <span className="you"> (du)</span>}
          </span>
          <span className={`badge ${active || won ? "on" : ""}`}>{status}</span>
        </div>
        <div className="player-row">
          <strong className="points" data-testid={`points-${seat}`}>
            {points}
          </strong>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (points / state.options.target) * 100)}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
