import WebSocket from 'ws';

/**
 * A small Chrome DevTools Protocol client for the Chrome running on a Bot's screen.
 *
 * The Bot already has a browser; driving it over CDP is the reliable path to tabs, page text and
 * clicks. Using the provider's CDP address (computer-provider.ts) means this works whether the
 * server runs on the host (published loopback ports) or inside the stack (the bot's container
 * address on a shared Docker network).
 *
 * One session is one page's WebSocket and stays open for a whole tool run, so a search does not pay
 * a handshake per step. Nothing here is specific to search; the research tools are its first caller.
 */

export interface CdpTab {
  id: string;
  type: string;
  title: string;
  url: string;
  wsUrl: string;
}

interface TabJson {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

const asTab = (t: TabJson): CdpTab => ({
  id: String(t.id ?? ''),
  type: String(t.type ?? ''),
  title: String(t.title ?? ''),
  url: String(t.url ?? ''),
  wsUrl: String(t.webSocketDebuggerUrl ?? ''),
});

const base = (cdpUrl: string) => cdpUrl.replace(/\/+$/, '');

/** Every page tab on that browser, in the order Chrome lists them (most recently used first). */
export async function listTabs(cdpUrl: string, timeoutMs = 4000): Promise<CdpTab[]> {
  const res = await fetch(`${base(cdpUrl)}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`DevTools list answered ${res.status}`);
  const tabs = (await res.json()) as TabJson[];
  return tabs.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).map(asTab).filter((t) => t.id);
}

/** Open a tab at `url` and return it. Chrome requires PUT for /json/new (a GET creates a blank one). */
export async function openTab(cdpUrl: string, url: string, timeoutMs = 8000): Promise<CdpTab> {
  const res = await fetch(`${base(cdpUrl)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Could not open a tab (DevTools answered ${res.status})`);
  const tab = asTab((await res.json()) as TabJson);
  if (!tab.id || !tab.wsUrl) throw new Error('Chrome did not return a usable tab');
  return tab;
}

export async function closeTab(cdpUrl: string, tabId: string, timeoutMs = 4000): Promise<void> {
  await fetch(`${base(cdpUrl)}/json/close/${encodeURIComponent(tabId)}`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => {});
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** One page's session. Call `close()` in a finally block. */
export class CdpSession {
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id !== 'number') return; // an event, not an answer
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'DevTools error'));
      else p.resolve(msg.result);
    });
    ws.on('close', () => this.failAll(new Error('The browser closed the DevTools connection')));
    ws.on('error', (e) => this.failAll(e instanceof Error ? e : new Error(String(e))));
  }

  static open(wsUrl: string, timeoutMs = 8000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error('Timed out connecting to the browser')), timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws));
      });
      ws.once('error', (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The DevTools session is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), (e) => {
        if (!e) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  /** Run an expression in the page and return its value (promises are awaited for you). */
  async evaluate<T>(expression: string, timeoutMs = 20_000): Promise<T> {
    const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs,
    );
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'The page script threw');
    return r?.result?.value as T;
  }

  /**
   * Poll an expression until it is truthy, then return its value.
   *
   * Navigation is asynchronous and a results page paints after `readyState` says complete, so both
   * are expressed as one wait: the caller passes the condition it actually needs.
   */
  async waitFor<T>(expression: string, { timeoutMs = 15_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T | null> {
    const until = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < until) {
      try {
        last = await this.evaluate<T | null>(expression, Math.min(10_000, timeoutMs));
        if (last) return last as T;
      } catch (e) {
        // A script that does not parse will never start parsing on a retry: surface the bug instead
        // of turning it into a 30-second wait that reports "the page did not load".
        if (/SyntaxError|ReferenceError/.test(String((e as { message?: unknown } | null)?.message ?? e))) throw e;
        /* the document may still be swapping; try again until the deadline */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return (last ?? null) as T | null;
  }

  async bringToFront(): Promise<void> {
    await this.send('Page.bringToFront', {}, 5000).catch(() => {});
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('The DevTools session was closed'));
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}

/** Is this a DevTools endpoint that answers? Used to tell "browser asleep" from "browser broken". */
export async function cdpAlive(cdpUrl: string, timeoutMs = 2500): Promise<boolean> {
  return fetch(`${base(cdpUrl)}/json/version`, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.ok, () => false);
}
