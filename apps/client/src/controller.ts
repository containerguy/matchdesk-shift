import { push, type Kind, type PublicShiftState, type ShiftEvent, type ShiftMove } from "@dreierschub/shift";
import type { Seat } from "@dreierschub/core";

/** Wie lange ein Schub und das Räumen einer Kette zu sehen sind. */
export const SLIDE_MS = 320;
export const CLEAR_MS = 420;

export type Phase = "choosing" | "animating" | "over";

export type Snapshot = {
  /** Was gerade gezeigt wird (während der Animation ein Zwischenstand). */
  board: Kind[];
  state: PublicShiftState;
  phase: Phase;
  /** Darf dieser Bildschirm gerade schieben? (online nur, wenn man selbst am Zug ist) */
  canAct: boolean;
  /** Angepeilter Schub: eigener Zeiger oder Vorschau des Gegners. */
  hover: ShiftMove | null;
  /** Laufende Animation: welche Linie gerade geschoben wurde bzw. welche Zellen verschwinden. */
  slide: { move: ShiftMove; key: number } | null;
  clearing: number[];
  /** Punkte der letzten Kette, kurz eingeblendet. */
  flash: { seat: Seat; points: number; chain: number; key: number } | null;
  log: string[];
  names: [string, string];
};

type Listener = () => void;

const SIDE_TEXT: Record<ShiftMove["side"], string> = { top: "von oben", bottom: "von unten", left: "von links", right: "von rechts" };

export function moveText(move: ShiftMove) {
  const line = move.side === "top" || move.side === "bottom" ? `Spalte ${"ABCDE"[move.index]}` : `Reihe ${move.index + 1}`;
  return `${line} ${SIDE_TEXT[move.side]}`;
}

/**
 * Gemeinsame Steuerung für lokale und Online-Partien: Schub anpeilen, absenden und abspielen.
 */
export abstract class TableController {
  protected snapshot: Snapshot;
  private listeners = new Set<Listener>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private animKey = 0;

  constructor(state: PublicShiftState, names: [string, string], log: string[]) {
    this.snapshot = {
      board: state.board,
      state,
      phase: state.winner === null ? "choosing" : "over",
      canAct: false,
      hover: null,
      slide: null,
      clearing: [],
      flash: null,
      log,
      names
    };
  }

  protected abstract mayAct(state: PublicShiftState): boolean;
  protected abstract submit(move: ShiftMove): void;
  /** Wird beim Anpeilen aufgerufen, z. B. um es dem Gegner zu zeigen. */
  protected onHover(_move: ShiftMove | null) {}

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;

  protected set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  protected log(lines: string[]) {
    if (lines.length) this.set({ log: [...this.snapshot.log, ...lines].slice(-40) });
  }

  isAnimating() {
    return this.snapshot.phase === "animating";
  }

  /** Eigener Zeiger über einem Pfeil am Rand. */
  hover(move: ShiftMove | null) {
    if (!this.snapshot.canAct) return;
    const same = move && this.snapshot.hover && move.side === this.snapshot.hover.side && move.index === this.snapshot.hover.index;
    if (same || (!move && !this.snapshot.hover)) return;
    this.set({ hover: move });
    this.onHover(move);
  }

  /** Vorschau des Gegners anzeigen. */
  protected showRemoteHover(move: ShiftMove | null) {
    if (this.snapshot.phase === "choosing" && !this.snapshot.canAct) this.set({ hover: move });
  }

  choose(move: ShiftMove) {
    if (!this.snapshot.canAct || this.snapshot.phase !== "choosing") return;
    this.set({ canAct: false, hover: null });
    this.submit(move);
  }

  /** Zustand übernehmen (ohne Animation). */
  protected adopt(state: PublicShiftState, extraLog: string[] = []) {
    this.clearTimers();
    this.set({
      board: state.board,
      state,
      phase: state.winner === null ? "choosing" : "over",
      canAct: state.winner === null && this.mayAct(state),
      hover: null,
      slide: null,
      clearing: []
    });
    this.log(extraLog);
  }

  /** Einen Zug abspielen: Schub, dann jede Kette, dann den neuen Zustand übernehmen. */
  protected play(before: PublicShiftState, seat: Seat, move: ShiftMove, events: ShiftEvent[], after: PublicShiftState, done?: () => void) {
    this.clearTimers();
    const pushedEvent = events.find((e) => e.type === "pushed");
    const kind = pushedEvent?.type === "pushed" ? pushedEvent.kind : before.next;
    let board = push(before.board, move, kind).board;
    const key = ++this.animKey;
    this.set({ phase: "animating", canAct: false, hover: null, board, state: { ...before, turn: seat }, slide: { move, key }, clearing: [] });
    this.log([`${this.snapshot.names[seat]}: ${moveText(move)}`]);

    let at = SLIDE_MS;
    const scores: [number, number] = [before.scores[0], before.scores[1]];
    for (const event of events) {
      if (event.type !== "cleared") continue;
      const shown = board;
      scores[event.seat] += event.points;
      const shownScores: [number, number] = [scores[0], scores[1]];
      this.schedule(at, () => {
        this.set({
          board: shown,
          state: { ...this.snapshot.state, scores: shownScores },
          slide: null,
          clearing: event.cells,
          flash: { seat: event.seat, points: event.points, chain: event.chain, key: ++this.animKey }
        });
        this.log([
          event.chain > 1
            ? `Kette ×${event.chain}: +${event.points} für ${this.snapshot.names[event.seat]}`
            : `+${event.points} für ${this.snapshot.names[event.seat]}`
        ]);
      });
      board = board.slice();
      for (const { cell, kind: k } of event.refill) board[cell] = k;
      at += CLEAR_MS;
    }
    const lines = events.flatMap((e) => (e.type === "won" ? [`${this.snapshot.names[e.seat]} gewinnt (${e.reason}).`] : []));
    this.schedule(at, () => {
      this.adopt(after, lines);
      done?.();
    });
  }

  private schedule(ms: number, task: () => void) {
    this.timers.push(setTimeout(task, ms));
  }

  protected clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  dispose() {
    this.clearTimers();
  }
}
