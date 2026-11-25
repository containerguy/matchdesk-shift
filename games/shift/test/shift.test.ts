import { describe, expect, it } from "vitest";
import {
  applyShiftMove,
  checkShiftMove,
  chooseBotMove,
  createState,
  findRuns,
  legalMoves,
  parseShiftMove,
  push,
  shift,
  type Kind,
  type ShiftState
} from "../src";

const board = (rows: string[]) => rows.join("").split("").map((c) => Number(c) as Kind);

describe("Dreierschub-Regeln", () => {
  it("startet ohne fertige Dreierreihen und mit 0:0", () => {
    for (let seed = 1; seed < 50; seed++) {
      const state = createState(seed, 0);
      expect(findRuns(state.board)).toEqual([]);
      expect(state.scores).toEqual([0, 0]);
    }
  });

  it("schiebt von allen vier Seiten und wirft am anderen Ende einen Stein raus", () => {
    const b = board(["01234", "12340", "23401", "34012", "40123"]);
    expect(push(b, { side: "top", index: 0 }, 4)).toMatchObject({ out: 4 });
    expect(push(b, { side: "top", index: 0 }, 4).board.filter((_, i) => i % 5 === 0)).toEqual([4, 0, 1, 2, 3]);
    expect(push(b, { side: "bottom", index: 0 }, 4).board.filter((_, i) => i % 5 === 0)).toEqual([1, 2, 3, 4, 4]);
    expect(push(b, { side: "left", index: 1 }, 0).board.slice(5, 10)).toEqual([0, 1, 2, 3, 4]);
    expect(push(b, { side: "right", index: 1 }, 0).board.slice(5, 10)).toEqual([2, 3, 4, 0, 0]);
  });

  it("räumt drei gleiche, zählt Punkte für den Schiebenden und füllt nach", () => {
    const state: ShiftState = {
      ...createState(7, 0),
      board: board(["44012", "01230", "12301", "23012", "30123"]),
      next: 4
    };
    // Von rechts eingeschoben: 4 0 1 2 4, kein Treffer
    const right = applyShiftMove(state, 0, { side: "right", index: 0 });
    expect(right.events.map((e) => e.type)).toEqual(["pushed"]);
    expect(right.state.turn).toBe(1);
    // Von links eingeschoben: 4 4 4 0 1, drei Sterne
    const left = applyShiftMove(state, 0, { side: "left", index: 0 });
    expect(left.events.some((e) => e.type === "cleared")).toBe(true);
    expect(left.state.scores[0]).toBeGreaterThanOrEqual(15); // 3 Sterne = 5 × 3
    expect(findRuns(left.state.board).length).toBe(0);
  });

  it("verbietet direktes Zurückschieben und Züge außer der Reihe", () => {
    let state = createState(3, 0);
    state = applyShiftMove(state, 0, { side: "left", index: 2 }).state;
    expect(checkShiftMove(state, 1, { side: "right", index: 2 }).ok).toBe(false);
    expect(checkShiftMove(state, 0, { side: "top", index: 2 }).ok).toBe(false);
    expect(checkShiftMove(state, 1, { side: "right", index: 3 }).ok).toBe(true);
    expect(legalMoves(state)).toHaveLength(19);
  });

  it("liest nur gültige Züge", () => {
    expect(parseShiftMove({ side: "top", index: 4 })).toEqual({ side: "top", index: 4 });
    expect(parseShiftMove({ side: "up", index: 1 })).toBeNull();
    expect(parseShiftMove({ side: "top", index: 5 })).toBeNull();
    expect(parseShiftMove({ side: "top", index: 1.5 })).toBeNull();
  });

  it("ist deterministisch und endet immer mit einem Sieger", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const run = () => {
        let state = shift.createInitialState({ seed, startingSeat: 0 });
        let rand = seed;
        const random = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i < 500 && shift.result(state).kind === "running"; i++) {
          const seat = shift.currentSeat(state);
          const move = chooseBotMove(state, i % 2 ? "hard" : "medium", random);
          expect(shift.checkMove(state, seat, move).ok).toBe(true);
          state = shift.applyMove(state, seat, move).state;
        }
        return state;
      };
      const a = run();
      expect(a).toEqual(run());
      expect(shift.result(a).kind).toBe("won");
    }
  });

  it("der stärkere Computer gewinnt meistens gegen den schwachen", () => {
    let hardWins = 0;
    for (let seed = 1; seed <= 40; seed++) {
      let state = createState(seed, (seed % 2) as 0 | 1);
      for (let i = 0; i < 500 && state.winner === null; i++) {
        const move = chooseBotMove(state, state.turn === 0 ? "hard" : "easy");
        state = applyShiftMove(state, state.turn, move).state;
      }
      if (state.winner === 0) hardWins++;
    }
    expect(hardWins).toBeGreaterThanOrEqual(28);
  });
});
