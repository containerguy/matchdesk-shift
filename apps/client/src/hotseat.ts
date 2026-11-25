import { applyShiftMove, checkShiftMove, createState, publicState, type ShiftMove, type ShiftState } from "@dreierschub/shift";
import type { Seat } from "@dreierschub/core";
import { TableController } from "./controller";

/** Partie an einem Gerät: beide Seiten schieben hier (Grundlage für die Partie gegen den Computer). */
export class HotseatGame extends TableController {
  protected full: ShiftState;

  constructor(names: [string, string] = ["Spieler 1", "Spieler 2"], startingSeat: Seat = 0) {
    const state = createState(Date.now() % 2 ** 31, startingSeat);
    super(publicState(state), names, [`${names[startingSeat]} beginnt.`]);
    this.full = state;
    this.adoptFull(state);
  }

  newGame() {
    const state = createState(Date.now() % 2 ** 31, 0);
    this.set({ log: [`Neue Partie. ${this.snapshot.names[0]} beginnt.`], flash: null });
    this.adoptFull(state);
  }

  protected adoptFull(state: ShiftState, extraLog: string[] = []) {
    this.full = state;
    this.adopt(publicState(state), extraLog);
  }

  protected mayAct(_state: unknown) {
    return true;
  }

  protected submit(move: ShiftMove) {
    const before = this.full;
    const check = checkShiftMove(before, before.turn, move);
    if (!check.ok) {
      this.log([check.reason]);
      this.adoptFull(before);
      return;
    }
    const { state, events } = applyShiftMove(before, before.turn, move);
    this.full = state;
    this.play(publicState(before), before.turn, move, events, publicState(state), () => this.afterMove(state));
  }

  /** Nach dem Abspielen eines Zuges (für den Computergegner). */
  protected afterMove(_state: ShiftState) {}
}
