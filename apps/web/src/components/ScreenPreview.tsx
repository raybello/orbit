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
  src: string | null;
  at: number | null;
} {
  const [src, setSrc] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const urlRef = useRef<string | null>(null);

  // A different bot's last frame must not outlive the switch: it is the wrong picture, and its
  // blob URL may already be revoked (which renders as the browser's broken-image glyph).
  useEffect(() => {
    setSrc(null);
    setAt(null);
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, [botId]);

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
        // Revoking while the old URL is still painted makes the browser draw a broken image for a
        // frame, so the previous blob is released once the new one has had time to paint.
        if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 1000);
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

/** The newest still, or the bot's avatar while there is nothing to show. The parent sizes it. */
export function ScreenFrame({ src, bot, size = 30 }: { src: string | null; bot: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'>; size?: number }) {
  if (!src) {
    return (
      <span className="screen-shot is-empty" aria-hidden>
        <BotAvatarFor bot={bot} size={size} />
      </span>
    );
  }
  // A background image cannot show the browser's broken-image glyph, so a frame that fails to
  // decode reads as an empty frame instead of a torn icon.
  return <span className="screen-shot is-image" style={{ backgroundImage: `url("${src}")` }} aria-hidden />;
}
