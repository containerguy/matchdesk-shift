import { otherSeat, type GameDefinition, type GameResult, type MoveCheck, type Seat } from "@dreierschub/core";

/**
 * Dreierschub: Zwei Spieler schieben abwechselnd einen Stein von einer der vier Seiten in ein 5×5-Feld.
 * Am anderen Ende der Reihe oder Spalte fällt ein Stein heraus. Drei oder mehr gleiche Steine in einer
 * Linie verschwinden und bringen dem Schiebenden Punkte; Lücken werden neu befüllt, Ketten zählen mehrfach.
 *
 * Alles hier ist rein und deterministisch (Zufall über einen Seed im Zustand), damit Server, Client
 * und Computergegner dieselbe Logik nutzen.
 */

export const SIZE = 5;
export const CELLS = SIZE * SIZE;

/** Symbole, Wert = Index + 1. */
export const KINDS = ["lemon", "cherry", "grape", "melon", "bell", "gem"] as const;
export type Kind = 0 | 1 | 2 | 3 | 4 | 5;
export const KIND_COUNT = KINDS.length;

export function kindValue(kind: Kind) {
  return kind + 1;
}

export type Side = "top" | "bottom" | "left" | "right";
export const SIDES: Side[] = ["top", "bottom", "left", "right"];

export type ShiftMove = { side: Side; index: number };

export type ShiftOptions = {
  /** Punkte zum Sieg. */
  target: number;
  /** Nach so vielen Zügen insgesamt gewinnt, wer vorn liegt (bei Gleichstand: nächster Vorsprung). */
  moveLimit: number;
};

export const DEFAULT_OPTIONS: ShiftOptions = { target: 150, moveLimit: 60 };

export type ShiftState = {
  board: Kind[];
  scores: [number, number];
  turn: Seat;
  /** Stein, den der Spieler am Zug einschiebt. */
  next: Kind;
  /** Stein danach (Vorschau). */
  after: Kind;
  rng: number;
  lastMove: ShiftMove | null;
  moves: number;
  options: ShiftOptions;
  winner: Seat | null;
  winReason: string | null;
};

export type ShiftEvent =
  | { type: "pushed"; seat: Seat; move: ShiftMove; kind: Kind; out: Kind }
  | { type: "cleared"; seat: Seat; chain: number; cells: number[]; points: number; refill: Array<{ cell: number; kind: Kind }> }
  | { type: "won"; seat: Seat; reason: string };

// --- Zufall ---------------------------------------------------------------

/** mulberry32: kleiner, reproduzierbarer Zufall; Zustand ist eine 32-Bit-Zahl. */
function nextRandom(seed: number): [number, number] {
  let t = (seed + 0x6d2b79f5) >>> 0;
  const state = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, state];
}

function randomKind(seed: number): [Kind, number] {
  const [r, s] = nextRandom(seed);
  return [Math.floor(r * KIND_COUNT) as Kind, s];
}

// --- Feld -------------------------------------------------------------------

export function cellOf(row: number, col: number) {
  return row * SIZE + col;
}

/** Zellen einer Linie in Schubrichtung: Eintritt zuerst, Austritt zuletzt. */
export function lineCells(move: ShiftMove): number[] {
  const cells: number[] = [];
  for (let i = 0; i < SIZE; i++) {
    switch (move.side) {
      case "top":
        cells.push(cellOf(i, move.index));
        break;
      case "bottom":
        cells.push(cellOf(SIZE - 1 - i, move.index));
        break;
      case "left":
        cells.push(cellOf(move.index, i));
        break;
      case "right":
        cells.push(cellOf(move.index, SIZE - 1 - i));
        break;
    }
  }
  return cells;
}

export function oppositeSide(side: Side): Side {
  return side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left";
}

/** Schiebt `kind` ein; liefert neues Feld und den herausgefallenen Stein. */
export function push(board: Kind[], move: ShiftMove, kind: Kind): { board: Kind[]; out: Kind } {
  const cells = lineCells(move);
  const next = board.slice();
  const out = board[cells[SIZE - 1]!]!;
  for (let i = SIZE - 1; i > 0; i--) next[cells[i]!] = board[cells[i - 1]!]!;
  next[cells[0]!] = kind;
  return { board: next, out };
}

export type Run = { cells: number[]; kind: Kind };

/** Alle waagrechten und senkrechten Folgen von mindestens drei gleichen Steinen. */
export function findRuns(board: Kind[]): Run[] {
  const runs: Run[] = [];
  for (const horizontal of [true, false]) {
    for (let a = 0; a < SIZE; a++) {
      let start = 0;
      for (let b = 1; b <= SIZE; b++) {
        const at = (i: number) => (horizontal ? cellOf(a, i) : cellOf(i, a));
        if (b < SIZE && board[at(b)] === board[at(start)]) continue;
        if (b - start >= 3) {
          const cells: number[] = [];
          for (let i = start; i < b; i++) cells.push(at(i));
          runs.push({ cells, kind: board[at(start)]! });
        }
        start = b;
      }
    }
  }
  return runs;
}

/** Punkte für eine Folge: 3 gleiche = Wert × 3, 4 = Wert × 5, 5 = Wert × 8. */
export function runPoints(run: Run) {
  const factor = run.cells.length >= 5 ? 8 : run.cells.length === 4 ? 5 : 3;
  return kindValue(run.kind) * factor;
}

function freshBoard(seed: number): { board: Kind[]; rng: number } {
  const board: Kind[] = [];
  let rng = seed >>> 0;
  for (let cell = 0; cell < CELLS; cell++) {
    const row = Math.floor(cell / SIZE);
    const col = cell % SIZE;
    for (;;) {
      let kind: Kind;
      [kind, rng] = randomKind(rng);
      const left = col >= 2 && board[cell - 1] === kind && board[cell - 2] === kind;
      const up = row >= 2 && board[cell - SIZE] === kind && board[cell - 2 * SIZE] === kind;
      if (!left && !up) {
        board.push(kind);
        break;
      }
    }
  }
  return { board, rng };
}

export function createState(seed: number, startingSeat: Seat, options: Partial<ShiftOptions> = {}): ShiftState {
  const { board, rng: r0 } = freshBoard(seed);
  const [next, r1] = randomKind(r0);
  const [after, r2] = randomKind(r1);
  return {
    board,
    scores: [0, 0],
    turn: startingSeat,
    next,
    after,
    rng: r2,
    lastMove: null,
    moves: 0,
    options: { ...DEFAULT_OPTIONS, ...options },
    winner: null,
    winReason: null
  };
}

export function isReverseOf(move: ShiftMove, previous: ShiftMove | null) {
  return previous !== null && previous.index === move.index && previous.side === oppositeSide(move.side);
}

export function checkShiftMove(state: ShiftState, seat: Seat, move: ShiftMove): MoveCheck {
  if (state.winner !== null) return { ok: false, reason: "Die Partie ist vorbei." };
  if (seat !== state.turn) return { ok: false, reason: "Du bist nicht am Zug." };
  if (isReverseOf(move, state.lastMove)) {
    return { ok: false, reason: "Den letzten Schub direkt zurückzuschieben ist nicht erlaubt." };
  }
  return { ok: true };
}

export function legalMoves(state: ShiftState): ShiftMove[] {
  const moves: ShiftMove[] = [];
  for (const side of SIDES) {
    for (let index = 0; index < SIZE; index++) {
      const move = { side, index };
      if (!isReverseOf(move, state.lastMove)) moves.push(move);
    }
  }
  return moves;
}

/** Höchstens so viele Kettenglieder; danach bleibt das Feld, wie es ist (praktisch nie erreicht). */
const MAX_CHAIN = 20;

export function applyShiftMove(state: ShiftState, seat: Seat, move: ShiftMove): { state: ShiftState; events: ShiftEvent[] } {
  const events: ShiftEvent[] = [];
  const pushed = push(state.board, move, state.next);
  events.push({ type: "pushed", seat, move, kind: state.next, out: pushed.out });
  let board = pushed.board;
  let rng = state.rng;
  const scores: [number, number] = [state.scores[0], state.scores[1]];

  for (let chain = 1; chain <= MAX_CHAIN; chain++) {
    const runs = findRuns(board);
    if (runs.length === 0) break;
    const cleared = new Set<number>();
    let points = 0;
    for (const run of runs) {
      points += runPoints(run);
      for (const cell of run.cells) cleared.add(cell);
    }
    points *= chain;
    scores[seat] += points;
    const cells = [...cleared].sort((a, b) => a - b);
    const refill: Array<{ cell: number; kind: Kind }> = [];
    board = board.slice();
    for (const cell of cells) {
      let kind: Kind;
      [kind, rng] = randomKind(rng);
      board[cell] = kind;
      refill.push({ cell, kind });
    }
    events.push({ type: "cleared", seat, chain, cells, points, refill });
  }

  const [after, rngAfter] = randomKind(rng);
  const moves = state.moves + 1;
  let winner: Seat | null = null;
  let winReason: string | null = null;
  if (scores[seat] >= state.options.target) {
    winner = seat;
    winReason = `${state.options.target} Punkte erreicht`;
  } else if (moves >= state.options.moveLimit && scores[0] !== scores[1]) {
    winner = scores[0] > scores[1] ? 0 : 1;
    winReason = "Zuglimit erreicht, mehr Punkte";
  }
  if (winner !== null) events.push({ type: "won", seat: winner, reason: winReason! });

  return {
    state: {
      ...state,
      board,
      scores,
      turn: otherSeat(seat),
      next: state.after,
      after,
      rng: rngAfter,
      lastMove: move,
      moves,
      winner,
      winReason
    },
    events
  };
}

export function parseShiftMove(raw: unknown): ShiftMove | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { side, index } = raw as Record<string, unknown>;
  if (typeof side !== "string" || !(SIDES as string[]).includes(side)) return null;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= SIZE) return null;
  return { side: side as Side, index };
}

export const shift: GameDefinition<ShiftState, ShiftMove, ShiftEvent> = {
  id: "shift",
  name: "Dreierschub",
  players: 2,
  createInitialState: ({ seed, startingSeat }) => createState(seed, startingSeat),
  currentSeat: (state) => state.turn,
  parseMove: parseShiftMove,
  checkMove: checkShiftMove,
  applyMove: applyShiftMove,
  result(state): GameResult {
    return state.winner === null ? { kind: "running" } : { kind: "won", winner: state.winner, reason: state.winReason ?? "" };
  },
  publicView: (state) => publicState(state)
};

/** Für Clients: ohne Zufallszustand, damit niemand die Nachfüllsteine vorhersehen kann. */
export type PublicShiftState = Omit<ShiftState, "rng">;

export function publicState(state: ShiftState): PublicShiftState {
  const { rng: _rng, ...rest } = state;
  return rest;
}
