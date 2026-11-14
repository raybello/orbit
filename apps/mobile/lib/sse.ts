import EventSource from 'react-native-sse';
import type { ServerEvent } from '@orbit/contracts';

export type SseStatus = 'connecting' | 'open' | 'retrying' | 'closed';

/**
 * The hub's event cursor, kept across reconnects and for the life of the app.
 *
 * It is not a row seq. The server numbers every event it emits per user and replays from that
 * number, and `hello.seq` is the only authoritative value for it — so that is the only thing
 * written here. A reconnect then resumes from the last position the server confirmed, and the
 * store's row dedupe absorbs anything replayed twice. Sending a row seq instead would put the
 * client ahead of the buffer, where nothing can be replayed at all.
 */
let hubCursor: number | null = null;

/** Forget the cursor when the session ends: another user must not resume from this number. */
export function resetSseCursor(): void {
  hubCursor = null;
}

export interface SseOptions {
  apiBase: string;
  token: string;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: SseStatus) => void;
}

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * The live feed. React Native has no EventSource, and the browser one cannot send an Authorization
 * header anyway, so this uses the react-native-sse polyfill and reconnects on its own schedule:
 * 1s, 2s, 4s … 30s, resuming from the hub cursor so everything the server's buffer still holds
 * survives a tunnel or a flaky connection.
 */
export function connectSSE({ apiBase, token, onEvent, onStatus }: SseOptions): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const emit = (status: SseStatus) => onStatus?.(status);

  const teardown = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    source?.removeAllEventListeners();
    source?.close();
    source = null;
  };

  const handle = (raw: string | null) => {
    if (!raw) return;
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    // Row seqs stay the store's business: they dedupe frames, they are not a hub cursor.
    // A server without the seq field leaves us with no cursor at all, which means no `?since`;
    // inventing one from row seqs is what put the client ahead of the buffer in the first place.
    if (event.type === 'hello') hubCursor = typeof event.seq === 'number' ? event.seq : null;
    onEvent(event);
  };

  const open = () => {
    if (closed) return;
    teardown();
    emit(attempt === 0 ? 'connecting' : 'retrying');

    const query = hubCursor !== null && hubCursor > 0 ? `?since=${hubCursor}` : '';
    const url = `${apiBase}/api/events${query}`;
    const es = new EventSource(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      // The library's own retry would fight ours, and SSE connections are meant to stay open.
      pollingInterval: 0,
      timeoutBeforeConnection: 0,
    });
    source = es;

    es.addEventListener('open', () => {
      attempt = 0;
      emit('open');
    });
    es.addEventListener('message', (event) => {
      if ('data' in event) handle(event.data);
    });
    es.addEventListener('error', (event) => {
      if (closed) return;
      const status = 'xhrStatus' in event ? event.xhrStatus : undefined;
      // 401 means the token is gone; retrying forever would just hammer the server.
      if (status === 401 || status === 403) {
        teardown();
        emit('closed');
        return;
      }
      scheduleRetry();
    });
    es.addEventListener('close', () => {
      if (!closed) scheduleRetry();
    });
  };

  const scheduleRetry = () => {
    teardown();
    if (closed) return;
    emit('retrying');
    const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(open, delay);
  };

  open();

  return () => {
    closed = true;
    teardown();
    emit('closed');
  };
}
