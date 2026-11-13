import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  url: string;
  name: string;
  onClose: () => void;
}

const MIN = 0.2;
const MAX = 8;

/**
 * Full-screen image viewer with zoom.
 *
 * Wheel zooms towards the pointer, drag pans while zoomed, double-click toggles fit/actual size.
 * Esc or a click on the backdrop closes it; the download link is always available.
 */
export function ImageViewer({ url, name, onClose }: Props) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [moved, setMoved] = useState(false);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(MAX, z * 1.25));
      else if (e.key === '-') setZoom((z) => Math.max(MIN, z / 1.25));
      else if (e.key === '0') { setZoom(1); setOffset({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  /** Zoom towards the pointer: the point under the cursor stays put. */
  const zoomAt = useCallback((factor: number, clientX: number, clientY: number) => {
    const box = stage.current?.getBoundingClientRect();
    setZoom((z) => {
      const next = Math.min(MAX, Math.max(MIN, z * factor));
      if (!box) return next;
      const cx = box.left + box.width / 2 + offset.x;
      const cy = box.top + box.height / 2 + offset.y;
      const ratio = next / z;
      setOffset((o) => ({
        x: o.x - (clientX - cx) * (ratio - 1),
        y: o.y - (clientY - cy) * (ratio - 1),
      }));
      return next;
    });
  }, [offset.x, offset.y]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  };

  const reset = () => { setZoom(1); setOffset({ x: 0, y: 0 }); };

  const step = (factor: number) => {
    const box = stage.current?.getBoundingClientRect();
    zoomAt(factor, box ? box.left + box.width / 2 : window.innerWidth / 2, box ? box.top + box.height / 2 : window.innerHeight / 2);
  };

  return (
    <div
      className={`imgviewer${drag ? ' is-dragging' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={() => { if (!moved) onClose(); }}
      onWheel={onWheel}
    >
      <div className="imgviewer__bar" onClick={(e) => e.stopPropagation()}>
        <span className="imgviewer__name" title={name}>{name}</span>
        <div className="imgviewer__tools">
          <button type="button" className="imgviewer__btn" onClick={() => step(1 / 1.25)} aria-label="Zoom out" title="Zoom out">
            <Icon name="shrink" size={14} />
          </button>
          <button type="button" className="imgviewer__zoom" onClick={reset} title="Reset zoom">{Math.round(zoom * 100)}%</button>
          <button type="button" className="imgviewer__btn" onClick={() => step(1.25)} aria-label="Zoom in" title="Zoom in">
            <Icon name="expand" size={14} />
          </button>
          <a href={url} download={name} className="imgviewer__btn imgviewer__btn--wide" onClick={(e) => e.stopPropagation()} title={`Download ${name}`}>
            <Icon name="arrow_down" size={13} /> Download
          </a>
          <button type="button" className="imgviewer__btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="imgviewer__stage" ref={stage}>
        <img
          src={url}
          alt={name}
          className="imgviewer__img"
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, cursor: zoom > 1 ? (drag ? 'grabbing' : 'grab') : 'zoom-in' }}
          onDoubleClick={(e) => { e.stopPropagation(); zoom > 1 ? reset() : zoomAt(2, e.clientX, e.clientY); }}
          onPointerDown={(e) => {
            if (zoom <= 1) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setMoved(false);
            setDrag({ x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) setMoved(true);
            setOffset({ x: drag.ox + dx, y: drag.oy + dy });
          }}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
        />
      </div>
    </div>
  );
}
