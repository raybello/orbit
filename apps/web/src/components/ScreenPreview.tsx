import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot } from '@orbit/contracts';
import { BotAvatarFor } from '../avatar/BotAvatar';

/**
 * How often a preview asks for a fresh still. A still is a whole screenshot, so it is not cheap; but
 * a picture that lags behind the bot reads as a stale screen, so it is refreshed every 2.5 seconds.
 */
export const PREVIEW_INTERVAL_MS = 2_500;

/** Attach to the element a still is drawn in: polling follows whether that element is on screen. */
export type FrameRef = (el: HTMLElement | null) => void;

export interface ScreenPreview {
  /** The two buffers, in slot order. `layers[active]` is the frame on screen. */
  layers: [string | null, string | null];
  /** The buffer on top: the frame the eye is on. The other one is beneath it, at full opacity. */
  active: 0 | 1;
  /** `layers[active]`: the newest decoded frame, or null before the first one is ready. */
  src: string | null;
  /** When `src` was published. */
  at: number | null;
  /** Put this on the frame element. A still is only fetched while that element is in view. */
  ref: FrameRef;
}

/** The published pair of buffers, and which of them is on top. */
interface Shown {
  layers: [string | null, string | null];
  active: 0 | 1;
  at: number | null;
}

/** Nothing published yet. `active` starts far-side so the first frame lands in slot 0. */
const NOTHING: Shown = { layers: [null, null], active: 1, at: null };

/**
 * Wait until the browser can paint `url` in one go. `decode()` is the reliable answer where it
 * exists; elsewhere `onload`/`onerror` are, which is also how jsdom behaves (it has neither decode
 * nor a loader, so a test that needs a frame settles it by hand). False means the picture will not
 * decode at all and is not worth showing.
 */
function preload(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const img = new Image();
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    img.onload = () => settle(true);
    img.onerror = () => settle(false);
    img.src = url;
    if (typeof img.decode === 'function') {
      img.decode().then(() => settle(true), () => settle(false));
    }
  });
}

/** One animation frame: the outgoing frame stays on screen until the browser is about to paint. */
function afterPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else window.setTimeout(resolve, 0);
  });
}

/**
 * A still of a bot's screen, re-fetched on a timer, ready to be swapped without a flicker.
 *
 * The computers grid and the details panel both show a bot's screen without opening a noVNC
 * stream: a stream per card would hold one of the computer's scarce screens for every bot on screen
 * just by being looked at. `GET /api/bots/:id/screenshot` answers 204 when there is nothing to show
 * (asleep, no container, no screen), so the last good frame is kept and a sleeping computer still
 * shows what it last looked like instead of going blank.
 *
 * A new frame is fetched, decoded off-DOM and only then published, so the frame on screen is never
 * an undecoded image. Polling stops while the tab is hidden, while `enabled` is false (the live view
 * is already painting this screen), and while the frame element is outside the viewport — a grid of
 * cards asking for screenshots nobody can see is pure load on a scarce resource.
 *
 * `ref` must go on the frame element; without it the hook cannot tell whether it is on screen.
 */
export function useScreenPreview(botId: string, { enabled = true }: { enabled?: boolean } = {}): ScreenPreview {
  const [frame, setFrame] = useState<Shown>(NOTHING);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  // No IntersectionObserver (jsdom, an older engine): poll as before rather than never.
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');

  /** Mirrors the published state, so a tick can hand over buffers without reading stale state. */
  const shown = useRef<Shown>(NOTHING);
  /** Blob URLs no longer painted, released once the render that dropped them has committed. */
  const dropped = useRef<string[]>([]);
  const element = useRef<HTMLElement | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);

  // A different bot's last frame must not outlive the switch: it is the wrong picture, and its blob
  // URL may already be revoked (which renders as the browser's broken-image glyph).
  useEffect(() => {
    const stale = [...shown.current.layers, ...dropped.current];
    shown.current = NOTHING;
    dropped.current = [];
    setFrame(NOTHING);
    for (const url of stale) if (url) URL.revokeObjectURL(url);
  }, [botId]);

  // A blob URL is released only once the render that dropped it has committed: revoking one that is
  // still painted makes the browser draw a broken image in its place. The frames on screen (and the
  // one under it) are never in this list.
  useEffect(() => {
    if (dropped.current.length === 0) return;
    const keep = new Set<string>();
    for (const url of frame.layers) if (url) keep.add(url);
    const released = dropped.current.filter((url) => !keep.has(url));
    dropped.current = dropped.current.filter((url) => keep.has(url));
    for (const url of released) URL.revokeObjectURL(url);
  }, [frame]);

  // The last frame's blob URL must not outlive the component showing it.
  useEffect(() => () => {
    const stale = [...shown.current.layers, ...dropped.current];
    dropped.current = [];
    for (const url of stale) if (url) URL.revokeObjectURL(url);
  }, []);

  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // Follow the frame element in and out of the viewport. 0.01 rather than 0: a card that is a
  // sliver into view is still worth a still, and a threshold of 0 never reports it.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    }, { threshold: 0.01 });
    observer.current = io;
    if (element.current) io.observe(element.current);
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, []);

  const ref = useCallback<FrameRef>((el) => {
    if (element.current === el) return;
    const previous = element.current;
    const io = observer.current;
    element.current = el;
    if (!io) return;
    if (previous) io.unobserve(previous);
    if (el) io.observe(el);
  }, []);

  useEffect(() => {
    if (!botId || !enabled || !inView || !visible) return;
    let alive = true;
    let busy = false;

    const publish = (url: string) => {
      const last = shown.current;
      // Alternate buffers: the frame is written into the one underneath, which is never the frame
      // the eye is on. Its old URL leaves the screen in the same commit, so it is released after it.
      const next = (last.active === 0 ? 1 : 0) as 0 | 1;
      const layers: [string | null, string | null] = [last.layers[0], last.layers[1]];
      if (layers[next]) dropped.current.push(layers[next]);
      layers[next] = url;
      const published: Shown = { layers, active: next, at: Date.now() };
      shown.current = published;
      setFrame(published);
    };

    const tick = async () => {
      // A hidden tab has no use for a still, and a slow screenshot must not stack up behind itself.
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/screenshot`, {
          credentials: 'include',
          cache: 'no-store',
        });
        // 204: nothing to show yet — keep the frame we have. Errors do the same.
        if (!alive || !res.ok || res.status === 204) return;
        const blob = await res.blob();
        if (!alive || blob.size === 0) return;
        const url = URL.createObjectURL(blob);
        // Decode off-DOM first: an image that is still decoding paints as nothing, and publishing it
        // now would leave a hole where the frame we already have was.
        const decodable = await preload(url);
        if (!alive || !decodable) {
          URL.revokeObjectURL(url);
          return;
        }
        // One paint with the old frame still up, then the swap: the new picture is decoded, so it
        // appears in the same paint the old one leaves.
        await afterPaint();
        if (!alive) {
          URL.revokeObjectURL(url);
          return;
        }
        publish(url);
      } catch {
        /* a dropped refresh keeps the last frame; the next tick tries again */
      } finally {
        busy = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), PREVIEW_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [botId, enabled, inView, visible]);

  return { ...frame, src: frame.layers[frame.active], ref };
}

/**
 * The two buffers, stacked in one box: whichever `active` names is on top, the other one stays
 * underneath at full opacity. Neither fades and neither ever changes the src of the frame you can
 * see, so a refresh is a single paint — an empty or half-decoded frame can never appear, and
 * neither layer paints a colour of its own.
 */
export function ScreenLayers({ layers, active, frameRef }: { layers: [string | null, string | null]; active: 0 | 1; frameRef?: FrameRef }) {
  return (
    <span className="screen-shot is-image" ref={frameRef} aria-hidden>
      {layers.map((url, slot) => (
        <img
          key={slot}
          className={`screen-shot__layer${active === slot ? ' is-current' : ''}`}
          src={url ?? undefined}
          alt=""
          draggable={false}
        />
      ))}
    </span>
  );
}

/** The newest still, or the bot's avatar while there is nothing to show. The parent sizes it. */
export function ScreenFrame({ preview, bot, size = 30 }: { preview: ScreenPreview; bot: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'>; size?: number }) {
  if (!preview.src) {
    return (
      <span className="screen-shot is-empty" ref={preview.ref} aria-hidden>
        <BotAvatarFor bot={bot} size={size} />
      </span>
    );
  }
  return <ScreenLayers layers={preview.layers} active={preview.active} frameRef={preview.ref} />;
}
