import { isReverseOf, KINDS, kindValue, lineCells, SIZE, type Kind, type ShiftMove, type Side } from "@dreierschub/shift";
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { moveText, type TableController } from "./controller";

/** Farben der Steine; eigene Palette im Matchdesk-Stil, gut unterscheidbar auch ohne Farbe (Form + Zahl). */
export const KIND_COLORS: Record<Kind, string> = {
  0: "#2BA6A0",
  1: "#F0823C",
  2: "#E0614A",
  3: "#8A63D2",
  4: "#3E9B5B",
  5: "#D8B32A"
};

const KIND_LABEL: Record<Kind, string> = {
  0: "Kreis",
  1: "Dreieck",
  2: "Quadrat",
  3: "Raute",
  4: "Sechseck",
  5: "Stern"
};

function shapePath(kind: Kind): ReactNode {
  switch (KINDS[kind]) {
    case "circle":
      return <circle cx="20" cy="20" r="12.5" />;
    case "triangle":
      return <path d="M20 6 34 31H6Z" />;
    case "square":
      return <rect x="8.5" y="8.5" width="23" height="23" rx="3" />;
    case "diamond":
      return <path d="M20 5 35 20 20 35 5 20Z" />;
    case "hexagon":
      return <path d="M20 6 32.1 13v14L20 34 7.9 27V13Z" />;
    case "star":
      return <path d="m20 5 4.4 9.3 10.1 1.3-7.4 7 1.9 10L20 27.8l-9 4.8 1.9-10-7.4-7 10.1-1.3Z" />;
  }
}

export function Tile({ kind, size = "md" }: { kind: Kind; size?: "sm" | "md" }) {
  return (
    <span className={`tile tile-${size}`} style={{ ["--tile" as string]: KIND_COLORS[kind] }} aria-label={`${KIND_LABEL[kind]}, ${kindValue(kind)} Punkte`} role="img">
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <g fill="currentColor">{shapePath(kind)}</g>
      </svg>
      <span className="tile-value">{kindValue(kind)}</span>
    </span>
  );
}

const ARROW: Record<Side, string> = { top: "↓", bottom: "↑", left: "→", right: "←" };

function sameMove(a: ShiftMove | null, b: ShiftMove) {
  return a !== null && a.side === b.side && a.index === b.index;
}

/** Spielfeld mit Pfeilen an allen vier Seiten. Maus: zeigen = Vorschau, klicken = schieben. Touch: erst antippen, dann bestätigen. */
export function Board({ game }: { game: TableController }) {
  const snap = useSyncExternalStore(game.subscribe, game.getSnapshot);
  const pointer = useRef<string>("mouse");
  const { board, state, hover, slide, clearing, canAct, flash } = snap;
  const hoverCells = hover ? new Set(lineCells(hover)) : null;
  const slideCells = slide ? new Set(lineCells(slide.move)) : null;
  const clearingSet = new Set(clearing);

  const arrow = (side: Side, index: number) => {
    const move = { side, index };
    const blocked = isReverseOf(move, state.lastMove);
    const active = sameMove(hover, move);
    return (
      <button
        key={`${side}${index}`}
        type="button"
        className={`arrow arrow-${side} ${active ? "active" : ""}`}
        style={side === "top" || side === "bottom" ? { gridColumn: index + 2 } : { gridRow: index + 2 }}
        disabled={!canAct || blocked}
        data-move={`${side}-${index}`}
        title={blocked ? "Direktes Zurückschieben ist nicht erlaubt" : moveText(move)}
        aria-label={blocked ? `${moveText(move)} (gesperrt)` : `Schieben: ${moveText(move)}`}
        onPointerDown={(e) => (pointer.current = e.pointerType)}
        onPointerEnter={(e) => e.pointerType === "mouse" && game.hover(move)}
        onPointerLeave={(e) => e.pointerType === "mouse" && game.hover(null)}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && game.hover(move)}
        onClick={() => {
          if (pointer.current !== "mouse" && !active) return game.hover(move);
          game.choose(move);
        }}
      >
        {ARROW[side]}
      </button>
    );
  };

  return (
    <div className="board-wrap">
      <div className={`board ${canAct ? "can-act" : ""}`} data-moves={state.moves} data-phase={snap.phase} data-turn={state.turn}>
        {[0, 1, 2, 3, 4].map((i) => arrow("top", i))}
        {[0, 1, 2, 3, 4].map((i) => arrow("left", i))}
        <div className="grid" role="grid" aria-label="Spielfeld">
          {board.map((kind, cell) => {
            const inSlide = slideCells?.has(cell);
            return (
              <div
                key={inSlide ? `${cell}-${slide!.key}` : cell}
                className={[
                  "cell",
                  hoverCells?.has(cell) ? "hover" : "",
                  inSlide ? `slide-${slide!.move.side}` : "",
                  clearingSet.has(cell) ? "clearing" : ""
                ].join(" ")}
                role="gridcell"
                data-kind={kind}
              >
                <Tile kind={kind} />
              </div>
            );
          })}
          {flash && (
            <div key={flash.key} className={`flash seat-${flash.seat}`}>
              +{flash.points}
              {flash.chain > 1 && <small> Kette ×{flash.chain}</small>}
            </div>
          )}
        </div>
        {[0, 1, 2, 3, 4].map((i) => arrow("right", i))}
        {[0, 1, 2, 3, 4].map((i) => arrow("bottom", i))}
      </div>
      {hover && canAct && pointer.current !== "mouse" && (
        <button type="button" className="primary confirm" onClick={() => game.choose(hover)}>
          {moveText(hover)} schieben
        </button>
      )}
    </div>
  );
}

export { SIZE };
