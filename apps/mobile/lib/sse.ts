import EventSource from 'react-native-sse';
import type { ServerEvent } from '@orbit/contracts';

export type SseStatus = 'connecting' | 'open' | 'retrying' | 'closed';

export interface SseOptions {
  apiBase: string;
  token: string;
  /** Highest row seq the app already has; the server replays the last five minutes from here. */
  since?: number;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: SseStatus) => void;
}

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * The live feed. React Native has no EventSource, and the browser one cannot send an Authorization
 * header anyway, so this uses the react-native-sse polyfill and reconnects on its own schedule:
 * 1s, 2s, 4s … 30s, resuming from the last row it saw so nothing is lost across a tunnel or a
 * flaky connection.
 */
export function connectSSE({ apiBase, token, since = 0, onEvent, onStatus }: SseOptions): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let lastSeq = since;

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
    if (event.type === 'rows') {
      for (const row of event.rows) if (row.seq > lastSeq) lastSeq = row.seq;
    }
    onEvent(event);
  };

  const open = () => {
    if (closed) return;
    teardown();
    emit(attempt === 0 ? 'connecting' : 'retrying');

    const query = lastSeq > 0 ? `?since=${lastSeq}` : '';
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
