import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** A side panel's width rules, in px. */
export interface PanelBounds {
  min: number;
  max: number;
  initial: number;
}

/** Which edge of its panel the handle sits on: the left panel grows rightwards, the right one leftwards. */
export type ResizeEdge = 'left' | 'right';

/** How far past `min` a drag has to go before it means "collapse" rather than "as narrow as it goes". */
export const COLLAPSE_SLOP = 72;
const KEY_STEP = 16;

/** One drag step: the clamped width, or `collapse` once the pointer has gone well past the minimum. */
export function resizeStep(startWidth: number, dx: number, edge: ResizeEdge, b: PanelBounds): number | 'collapse' {
  const raw = edge === 'right' ? startWidth + dx : startWidth - dx;
  if (raw < b.min - COLLAPSE_SLOP) return 'collapse';
  return Math.round(Math.min(b.max, Math.max(b.min, raw)));
}

function readWidth(key: string, b: PanelBounds): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n >= b.min && n <= b.max ? n : b.initial;
  } catch {
    return b.initial;
  }
}

/**
 * A panel width that survives reloads. `done` marks the end of a drag (or a key press), which is
 * when it is written, not on every pointer move.
 */
export function usePanelWidth(key: string, bounds: PanelBounds): [number, (w: number, done: boolean) => void] {
  const [width, setWidth] = useState(() => readWidth(key, bounds));
  const set = useCallback((w: number, done: boolean) => {
    setWidth(w);
    if (!done) return;
    try { localStorage.setItem(key, String(w)); } catch { /* private mode: the width just won't stick */ }
  }, [key]);
  return [width, set];
}

interface Props {
  edge: ResizeEdge;
  width: number;
  bounds: PanelBounds;
  /** `done` is true when the drag or key press has finished and the width should be kept. */
  onWidth: (width: number, done: boolean) => void;
  /** Dragged well past the minimum. */
  onCollapse?: () => void;
  label: string;
}

/**
 * The drag handle on a side panel's inner edge. Drag to resize, double-click for the default width,
 * drag far past the minimum to collapse; focused, the arrow keys resize it too.
 */
export function PanelResizer({ edge, width, bounds, onWidth, onCollapse, label }: Props) {
  const drag = useRef<{ x: number; width: number; last: number; collapse: boolean } | null>(null);
  const [active, setActive] = useState(false);

  const end = (el: HTMLElement, id: number) => {
    const d = drag.current;
    drag.current = null;
    setActive(false);
    document.body.classList.remove('is-panel-resizing');
    if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    if (!d) return;
    if (d.collapse && onCollapse) {
      // Reopening brings back the width it had before the drag, not the squeezed one.
      onWidth(d.width, true);
      onCollapse();
      return;
    }
    onWidth(d.last, true);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width, last: width, collapse: false };
    setActive(true);
    document.body.classList.add('is-panel-resizing');
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = resizeStep(d.width, e.clientX - d.x, edge, bounds);
    d.collapse = next === 'collapse';
    d.last = next === 'collapse' ? bounds.min : next;
    onWidth(d.last, false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = edge === 'right' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = edge === 'right' ? 'ArrowLeft' : 'ArrowRight';
    const next =
      e.key === grow ? width + KEY_STEP
      : e.key === shrink ? width - KEY_STEP
      : e.key === 'Home' ? bounds.min
      : e.key === 'End' ? bounds.max
      : null;
    if (next === null) return;
    e.preventDefault();
    onWidth(Math.min(bounds.max, Math.max(bounds.min, next)), true);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className={`panel-resizer${active ? ' is-active' : ''}`}
      data-edge={edge}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => end(e.currentTarget, e.pointerId)}
      onDoubleClick={() => onWidth(bounds.initial, true)}
      onKeyDown={onKeyDown}
    />
  );
}
