import type { ServerEvent } from '@orbit/contracts';
import { useStore } from '../store';

/**
 * The hub's event cursor, kept for the life of the page load.
 *
 * Only `hello.seq` is authoritative — it is the server's view of how far it has emitted.
 * A reconnect resumes from that position so the server can replay anything buffered since
 * the disconnect. The store's row dedupe absorbs any frame that arrives twice.
 */
let hubCursor: number | null = null;

/** Forget the cursor when the session ends so another user does not resume from this position. */
export function resetSseCursor(): void {
  hubCursor = null;
}

/** Build the SSE endpoint URL, appending `?since=<cursor>` when a position is known. */
export function eventsUrl(cursor: number | null): string {
  return cursor !== null && cursor > 0 ? `/api/events?since=${cursor}` : '/api/events';
}

/** Extract the hub cursor from a server event (only `hello` carries one). */
export function hubCursorOf(ev: ServerEvent): number | null {
  return ev.type === 'hello' && typeof ev.seq === 'number' ? ev.seq : null;
}

export function startEvents(): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (stopped) return;
    es = new EventSource(eventsUrl(hubCursor), { withCredentials: true });
    es.onopen = () => {
      retry = 1000;
      useStore.getState().set({ sseConnected: true });
    };
    es.onmessage = (m) => {
      let ev: ServerEvent;
      try { ev = JSON.parse(m.data) as ServerEvent; } catch (e) { console.warn('bad event', e); return; }
      const cursor = hubCursorOf(ev);
      if (cursor !== null) hubCursor = cursor;
      useStore.getState().handleEvent(ev);
    };
    es.onerror = () => {
      useStore.getState().set({ sseConnected: false });
      if (es?.readyState === EventSource.CLOSED) {
        es = null;
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 15_000);
      }
    };
  };
  open();
  return () => { stopped = true; clearTimeout(timer); es?.close(); };
}
