import { findRuns, legalMoves, push, runPoints, type Kind, type ShiftMove, type ShiftState } from "./rules";

/**
 * Computergegner. Er sieht nur, was auch ein Mensch sieht: Feld, nächsten Stein und Vorschau.
 * Nachfüllsteine kennt er nicht; geräumte Zellen gelten in der Vorausschau als leer.
 */

export type BotLevel = "easy" | "medium" | "hard";
export const BOT_LEVELS: BotLevel[] = ["easy", "medium", "hard"];

/** -1 = leer (nach dem Räumen, Inhalt unbekannt). */
type Cell = Kind | -1;

function immediate(board: Cell[], move: ShiftMove, kind: Kind): { points: number; board: Cell[] } {
  const pushed = push(board as Kind[], move, kind).board as Cell[];
  const runs = findRuns(pushed as Kind[]).filter((run) => (run.kind as Cell) !== -1);
  if (runs.length === 0) return { points: 0, board: pushed };
  const after = pushed.slice();
  let points = 0;
  for (const run of runs) {
    points += runPoints(run);
    for (const cell of run.cells) after[cell] = -1;
  }
  return { points, board: after };
}

/** Wie gut ist das Feld für den, der als Nächstes `kind` einschiebt? (bester Sofortgewinn) */
function bestReply(board: Cell[], last: ShiftMove, kind: Kind): number {
  let best = 0;
  for (const move of legalMoves({ lastMove: last } as ShiftState)) {
    const { points } = immediate(board, move, kind);
    if (points > best) best = points;
  }
  return best;
}

export function chooseBotMove(state: ShiftState, level: BotLevel, random: () => number = Math.random): ShiftMove {
  const moves = legalMoves(state);
  const scored = moves.map((move) => {
    const mine = immediate(state.board, move, state.next);
    let value = mine.points;
    if (level === "hard") value -= 0.9 * bestReply(mine.board, move, state.after);
    return { move, value, points: mine.points };
  });

  if (level === "easy") {
    // Meist zufällig, manchmal nimmt er einen offensichtlichen Treffer mit
    const hits = scored.filter((s) => s.points > 0);
    if (hits.length > 0 && random() < 0.4) return hits[Math.floor(random() * hits.length)]!.move;
    return moves[Math.floor(random() * moves.length)]!;
  }

  const best = Math.max(...scored.map((s) => s.value));
  const top = scored.filter((s) => s.value >= best - 1e-9);
  return top[Math.floor(random() * top.length)]!.move;
}
