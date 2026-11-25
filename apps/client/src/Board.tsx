import { isReverseOf, KINDS, kindValue, lineCells, SIZE, type Kind, type ShiftMove, type Side } from "@dreierschub/shift";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { moveText, type TableController } from "./controller";

/** Umriss aller Symbole: dunkles Braun, wie Tusche im Comic. */
const INK = "#3B2414";

const KIND_LABEL: Record<Kind, string> = {
  0: "Zitrone",
  1: "Kirschen",
  2: "Trauben",
  3: "Melone",
  4: "Glocke",
  5: "Edelstein"
};

/** Eigene, selbst gezeichnete Symbole (Obst und Automat), 48 × 48. */
function symbol(kind: Kind): ReactNode {
  const line = { stroke: INK, strokeWidth: 2.2, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  switch (KINDS[kind]) {
    case "lemon":
      return (
        <>
          <path d="M8 26c0-9 8-15 16-15s16 6 16 15-8 13-16 13S8 35 8 26Z" fill="#FFD43B" {...line} />
          <path d="M6 26c1-1.5 2-2 3-2M42 26c-1-1.5-2-2-3-2" {...line} fill="none" />
          <path d="M15 21c2-3 5-4 8-4" stroke="#FFF3B0" strokeWidth="3" strokeLinecap="round" fill="none" />
          <path d="M24 11c0-3 2-5 5-5-1 3-3 4-5 5Z" fill="#5DBB46" {...line} />
        </>
      );
    case "cherry":
      return (
        <>
          <path d="M17 30c2-10 6-18 15-23M31 30c-1-9 0-16 1-23" fill="none" {...line} />
          <path d="M32 7c4-2 9-1 11 2-4 2-8 1-11-2Z" fill="#5DBB46" {...line} />
          <circle cx="16" cy="34" r="8.5" fill="#E8333F" {...line} />
          <circle cx="32" cy="34" r="8.5" fill="#E8333F" {...line} />
          <path d="M12 31c1-2 2-3 4-3M28 31c1-2 2-3 4-3" stroke="#FF9AA0" strokeWidth="2.6" strokeLinecap="round" fill="none" />
        </>
      );
    case "grape":
      return (
        <>
          <path d="M24 10c0-3 1-5 3-6M24 10c4-4 10-4 13-1-4 3-9 3-13 1Z" fill="#5DBB46" {...line} />
          {[
            [17, 16], [24, 15], [31, 16], [20, 23], [28, 23], [24, 30], [16, 29], [32, 29], [24, 37]
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="5.2" fill="#8E4FD8" {...line} />
          ))}
          <path d="M14 14c1-1 2-1.5 3-1.5" stroke="#D2B0FF" strokeWidth="2" strokeLinecap="round" fill="none" />
        </>
      );
    case "melon":
      return (
        <>
          <path d="M5 17h38c0 12-8 22-19 22S5 29 5 17Z" fill="#3FA34D" {...line} />
          <path d="M9 17h30c0 9-6 17-15 17S9 26 9 17Z" fill="#FF5D6C" />
          <path d="M9 17h30" {...line} fill="none" />
          {[[16, 22], [22, 27], [28, 22], [24, 21], [19, 29], [30, 28]].map(([x, y], i) => (
            <ellipse key={i} cx={x} cy={y} rx="1.2" ry="2" fill={INK} />
          ))}
        </>
      );
    case "bell":
      return (
        <>
          <path d="M24 7c-8 0-12 7-12 15v8l-4 5h32l-4-5v-8c0-8-4-15-12-15Z" fill="#FFB81C" {...line} />
          <circle cx="24" cy="39" r="4" fill="#FFB81C" {...line} />
          <path d="M18 14c1.5-2 3-3 5-3" stroke="#FFE7A3" strokeWidth="3" strokeLinecap="round" fill="none" />
          <circle cx="24" cy="6" r="2" fill="#FFB81C" {...line} />
        </>
      );
    case "gem":
      return (
        <>
          <path d="M14 9h20l8 11-18 21L6 20Z" fill="#29B6F6" {...line} />
          <path d="M6 20h36M14 9l5 11 5-11 5 11 5-11M19 20l5 21 5-21" fill="none" {...line} strokeWidth="1.6" />
          <path d="M15 12l-4 6" stroke="#C9F0FF" strokeWidth="2.6" strokeLinecap="round" />
        </>
      );
  }
}

export function Tile({ kind, size = "md" }: { kind: Kind; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`tile tile-${size}`} aria-label={`${KIND_LABEL[kind]}, ${kindValue(kind)} Punkte`} role="img">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        {symbol(kind)}
      </svg>
      <span className="tile-value">{kindValue(kind)}</span>
    </span>
  );
}

/** Beschriftung der Einschubstellen: Spalten A–E oben und unten, Reihen 1–5 links und rechts. */
function slotLabel(side: Side, index: number) {
  return side === "top" || side === "bottom" ? "ABCDE"[index]! : String(index + 1);
}

function sameMove(a: ShiftMove | null, b: ShiftMove | null) {
  return a !== null && b !== null && a.side === b.side && a.index === b.index;
}

/** Nächste Einschubstelle zu einem Punkt: die nächstgelegene Seite, Reihe bzw. Spalte unter dem Zeiger. */
function slotAt(grid: DOMRect, x: number, y: number): ShiftMove {
  const clamp = (v: number) => Math.max(0, Math.min(SIZE - 1, v));
  const col = clamp(Math.floor(((x - grid.left) / grid.width) * SIZE));
  const row = clamp(Math.floor(((y - grid.top) / grid.height) * SIZE));
  const distances: Array<[Side, number]> = [
    ["top", y - grid.top],
    ["bottom", grid.bottom - y],
    ["left", x - grid.left],
    ["right", grid.right - x]
  ];
  const [side] = distances.reduce((best, d) => (d[1] < best[1] ? d : best));
  return { side, index: side === "top" || side === "bottom" ? col : row };
}

type Drag = { pointerId: number; startedOn: ShiftMove | null; moved: boolean };

/**
 * Spielfeld mit Einschubstellen an allen vier Seiten. Der nächste Stein hängt am Zeiger und rastet an der
 * nächsten Einschubstelle ein. Maus: bewegen und klicken. Touch: Stein mit dem Finger an den Rand ziehen,
 * loslassen zeigt die Vorschau; erneut antippen oder „… schieben“ schiebt. Tastatur: Tab und Enter.
 */
export function Board({ game }: { game: TableController }) {
  const snap = useSyncExternalStore(game.subscribe, game.getSnapshot);
  const pointer = useRef<string>("mouse");
  const drag = useRef<Drag | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const carrierRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState(0);
  const { board, state, hover, slide, clearing, canAct, flash } = snap;
  const hoverCells = hover ? new Set(lineCells(hover)) : null;
  const slideCells = slide ? new Set(lineCells(slide.move)) : null;
  const clearingSet = new Set(clearing);
  const hoverBlocked = hover !== null && isReverseOf(hover, state.lastMove);

  useEffect(() => {
    const el = boardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLayout((n) => n + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Der Stein am Zeiger sitzt mittig über der angepeilten Einschubstelle.
  useLayoutEffect(() => {
    const carrier = carrierRef.current;
    const el = boardRef.current;
    const grid = gridRef.current;
    if (!carrier || !el || !grid || !hover) return;
    const slot = el.querySelector<HTMLElement>(`[data-move="${hover.side}-${hover.index}"]`);
    if (!slot) return;
    const b = el.getBoundingClientRect();
    const r = slot.getBoundingClientRect();
    const size = grid.getBoundingClientRect().width / SIZE;
    carrier.style.width = `${size}px`;
    carrier.style.transform = `translate(${r.left + r.width / 2 - b.left - size / 2}px, ${r.top + r.height / 2 - b.top - size / 2}px)`;
  }, [hover, layout]);

  const aim = (x: number, y: number) => {
    const grid = gridRef.current;
    if (!grid) return null;
    const move = slotAt(grid.getBoundingClientRect(), x, y);
    game.hover(move);
    return move;
  };

  const push = (move: ShiftMove | null) => {
    if (move && !isReverseOf(move, state.lastMove)) game.choose(move);
  };

  const slot = (side: Side, index: number) => {
    const move = { side, index };
    const blocked = isReverseOf(move, state.lastMove);
    const active = sameMove(hover, move);
    return (
      <button
        key={`${side}${index}`}
        type="button"
        className={`arrow arrow-${side} ${active ? "active" : ""}`}
        style={side === "top" || side === "bottom" ? { gridColumn: index + 2 } : { gridRow: index + 2 }}
        disabled={!canAct}
        aria-disabled={blocked || undefined}
        data-move={`${side}-${index}`}
        title={blocked ? "Direktes Zurückschieben ist nicht erlaubt" : moveText(move)}
        aria-label={blocked ? `${moveText(move)} (gesperrt)` : `Schieben: ${moveText(move)}`}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && game.hover(move)}
        // Nur Tastatur (Enter/Leertaste); Maus und Finger laufen über das ganze Feld.
        onClick={(e) => e.detail === 0 && push(move)}
      >
        <span className="slot-label">{slotLabel(side, index)}</span>
      </button>
    );
  };

  return (
    <div className="board-wrap">
      <div
        ref={boardRef}
        className={`board ${canAct ? "can-act" : ""}`}
        data-moves={state.moves}
        data-phase={snap.phase}
        data-turn={state.turn}
        onPointerDown={(e) => {
          pointer.current = e.pointerType;
          if (e.pointerType === "mouse" || !canAct) return;
          const before = snap.hover;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const move = aim(e.clientX, e.clientY);
          drag.current = { pointerId: e.pointerId, startedOn: sameMove(before, move) ? before : null, moved: false };
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "mouse") {
            aim(e.clientX, e.clientY);
            return;
          }
          const d = drag.current;
          if (!d || d.pointerId !== e.pointerId) return;
          const move = aim(e.clientX, e.clientY);
          if (!sameMove(move, d.startedOn)) d.moved = true;
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          if (!d || d.pointerId !== e.pointerId) return;
          drag.current = null;
          // Erneutes Antippen derselben Stelle schiebt; Ziehen und Loslassen zeigt nur die Vorschau.
          if (d.startedOn && !d.moved) push(d.startedOn);
        }}
        onPointerCancel={() => (drag.current = null)}
        onPointerLeave={(e) => e.pointerType === "mouse" && game.hover(null)}
        onClick={() => pointer.current === "mouse" && push(snap.hover)}
      >
        {[0, 1, 2, 3, 4].map((i) => slot("top", i))}
        {[0, 1, 2, 3, 4].map((i) => slot("left", i))}
        <div className="grid" role="grid" aria-label="Spielfeld" ref={gridRef}>
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
        {[0, 1, 2, 3, 4].map((i) => slot("right", i))}
        {[0, 1, 2, 3, 4].map((i) => slot("bottom", i))}
        <div
          ref={carrierRef}
          className={`carrier ${hover && snap.phase === "choosing" ? "on" : ""} ${hover ? `from-${hover.side}` : ""} ${hoverBlocked ? "blocked" : ""} ${canAct ? "mine" : "theirs"}`}
          data-testid="carrier"
          aria-hidden="true"
        >
          <Tile kind={state.next} />
        </div>
      </div>
      <div className="display" data-testid="next">
        <div className="display-slot">
          <span className="display-caption">Nächster</span>
          <Tile kind={state.next} size="lg" />
        </div>
        <div className="display-score" aria-label={`Punkte ${state.scores[0]} zu ${state.scores[1]}, Ziel ${state.options.target}`}>
          <span className={`led seat-0 ${state.turn === 0 && snap.phase !== "over" ? "on" : ""}`}>
            <span className="turn" aria-hidden="true">◀</span>
            {String(state.scores[0]).padStart(3, "0")}
          </span>
          <span className="display-target">Ziel {state.options.target}</span>
          <span className={`led seat-1 ${state.turn === 1 && snap.phase !== "over" ? "on" : ""}`}>
            {String(state.scores[1]).padStart(3, "0")}
            <span className="turn" aria-hidden="true">▶</span>
          </span>
        </div>
        <div className="display-slot">
          <span className="display-caption">danach</span>
          <Tile kind={state.after} size="sm" />
        </div>
      </div>
      {hover && canAct && !hoverBlocked && pointer.current !== "mouse" && (
        <button type="button" className="primary confirm" onClick={() => game.choose(hover)}>
          {moveText(hover)} schieben
        </button>
      )}
    </div>
  );
}

export { SIZE };
