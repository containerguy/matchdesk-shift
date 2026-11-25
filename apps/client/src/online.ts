import type { PublicShiftState, ShiftEvent, ShiftMove } from "@dreierschub/shift";
import type { TableView } from "@dreierschub/protocol";
import { TableController } from "./controller";
import type { NetClient } from "./net";

/** Online-Partie: Züge gehen an den Server, die Züge beider Spieler werden hier abgespielt. */
export class OnlineTable extends TableController {
  private view: TableView;
  private pendingView: TableView | null = null;

  constructor(private net: NetClient, view: TableView) {
    super(view.state as PublicShiftState, namesOf(view), []);
    this.view = view;
    this.adopt(view.state as PublicShiftState);
    net.onGame((msg) => {
      if (msg.t === "preview") {
        if (msg.seat !== this.view.mySeat) this.showRemoteHover(msg.move as ShiftMove | null);
        return;
      }
      this.play(msg.before as PublicShiftState, msg.seat, msg.move as ShiftMove, msg.events as ShiftEvent[], msg.after as PublicShiftState, () => {
        if (this.pendingView) {
          const next = this.pendingView;
          this.pendingView = null;
          this.update(next);
        }
      });
    });
  }

  /** Nach einer Ablehnung durch den Server wieder den Stand des Servers zeigen. */
  resync() {
    if (!this.isAnimating() && this.view.state) this.adopt(this.view.state as PublicShiftState);
  }

  dispose() {
    this.net.onGame(null);
    super.dispose();
  }

  /** Neue Tischansicht vom Server. */
  update(view: TableView) {
    if (this.isAnimating()) {
      this.pendingView = view;
      return;
    }
    const prev = this.view;
    this.view = view;
    this.set({ names: namesOf(view) });
    const state = view.state as PublicShiftState | null;
    if (!state) return;
    const prevState = prev.state as PublicShiftState | null;
    const changed = !prevState || prevState.moves !== state.moves || prev.status !== view.status || prevState.turn !== state.turn;
    if (changed) this.adopt(state);
    else this.set({ canAct: this.mayAct(state) && this.snapshot.phase === "choosing" });
  }

  protected mayAct(state: PublicShiftState) {
    return this.view.status === "playing" && this.view.mySeat !== null && state.turn === this.view.mySeat && state.winner === null;
  }

  protected submit(move: ShiftMove) {
    this.net.send({ t: "move", move });
  }

  protected onHover(move: ShiftMove | null) {
    this.net.send({ t: "preview", move });
  }
}

function namesOf(view: TableView): [string, string] {
  return [view.seats[0]?.name ?? "frei", view.seats[1]?.name ?? "frei"];
}
