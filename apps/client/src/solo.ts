import { chooseBotMove, type BotLevel, type ShiftMove, type ShiftState } from "@dreierschub/shift";
import { HotseatGame } from "./hotseat";

export const BOT_LEVELS: ReadonlyArray<{ id: BotLevel; label: string }> = [
  { id: "easy", label: "Leicht" },
  { id: "medium", label: "Mittel" },
  { id: "hard", label: "Schwer" }
];

const BOT_SEAT = 1;
const THINK_MS = 650;
const SHOW_MS = 550;

/** Partie gegen den Computer: der Mensch sitzt auf Platz 1, der Computer auf Platz 2. */
export class SoloGame extends HotseatGame {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(playerName: string, private level: BotLevel) {
    super([playerName, `Computer (${BOT_LEVELS.find((l) => l.id === level)!.label})`]);
  }

  newGame() {
    this.cancel();
    super.newGame();
  }

  dispose() {
    this.cancel();
    super.dispose();
  }

  protected mayAct(state: { turn: number }) {
    return state.turn !== BOT_SEAT;
  }

  protected adoptFull(state: ShiftState, extraLog: string[] = []) {
    super.adoptFull(state, extraLog);
    if (state.turn === BOT_SEAT && state.winner === null) this.botTurn(state);
  }

  protected afterMove(state: ShiftState) {
    if (state.turn === BOT_SEAT && state.winner === null) this.botTurn(state);
  }

  private cancel() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private later(ms: number, task: () => void) {
    const generation = this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation === this.generation) task();
    }, ms);
  }

  private botTurn(state: ShiftState) {
    this.later(THINK_MS, () => {
      const move: ShiftMove = chooseBotMove(state, this.level);
      this.set({ hover: move });
      this.later(SHOW_MS, () => this.submit(move));
    });
  }
}
