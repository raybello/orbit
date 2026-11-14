import { useEffect, useRef, useState } from 'react';
import type { Bot } from '@orbit/contracts';
import { BotAvatarFor } from '../avatar/BotAvatar';

/** How often a preview asks for a fresh still. A still is a whole screenshot, so it is not fast. */
export const PREVIEW_INTERVAL_MS = 8_000;

/**
 * A still of a bot's screen, re-fetched on a timer.
 *
 * The computers grid and the details panel both show a bot's screen without opening a noVNC
 * stream: a stream per card would hold one of the computer's scarce screens for every bot on screen
 * just by being looked at. `GET /api/bots/:id/screenshot` answers 204 when there is nothing to show
 * (asleep, no container, no screen), so the last good frame is kept and a sleeping computer still
 * shows what it last looked like instead of going blank.
 *
 * Polling stops while the tab is hidden and while `enabled` is false (the live view is already
 * painting this screen).
 */
export function useScreenPreview(botId: string, { enabled = true }: { enabled?: boolean } = {}): {
  /** A blob URL for the newest frame, or null before the first one arrived. */
  src: string | null;
  /** When that frame was taken, for a caption. */
  at: number | null;
} {
  const [src, setSrc] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !botId) return;
    let alive = true;
    let busy = false;

    const tick = async () => {
      // A hidden tab has no use for a still, and a slow screenshot must not stack up behind itself.
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/screenshot`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!alive || !res.ok) return; // 204: nothing to show yet — keep the frame we have
        const blob = await res.blob();
        if (!alive) return;
        const next = URL.createObjectURL(blob);
        const previous = urlRef.current;
        urlRef.current = next;
        setSrc(next);
        setAt(Date.now());
        if (previous) URL.revokeObjectURL(previous);
      } catch {
        /* a dropped refresh keeps the last frame; the next tick tries again */
      } finally {
        busy = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), PREVIEW_INTERVAL_MS);
    const onVisibility = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [botId, enabled]);

  // The last frame's blob URL must not outlive the component showing it.
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  return { src, at };
}

/**
 * The frame itself: the newest still, or the bot's avatar while there is nothing to show.
 * Layout-neutral — the parent gives it its size.
 */
export function ScreenFrame({ src, bot, size = 30 }: { src: string | null; bot: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'>; size?: number }) {
  if (!src) {
    return (
      <span className="screen-shot is-empty" aria-hidden>
        <BotAvatarFor bot={bot} size={size} />
      </span>
    );
  }
  return <img className="screen-shot" src={src} alt="" draggable={false} />;
}
