import type { ServerEvent } from '../types.js';

type Listener = (ev: ServerEvent) => void;

interface Buffered {
  seq: number;
  at: number;
  event: ServerEvent;
}

/** How far back a reconnecting client can be handed the events it missed. */
const BUFFER_MS = 5 * 60_000;
/** Ceiling per user, so a busy bot cannot grow the buffer without bound. */
const BUFFER_MAX = 500;

/**
 * Per-user fan-out of server events to connected SSE clients, plus a short replay buffer.
 *
 * Every event emitted for a user gets the next sequence number, whether or not anyone is listening:
 * that makes the number a cursor a client can resume from (`GET /api/events?since=<seq>`), and it
 * keeps the numbering monotonic across reconnects.
 */
class Hub {
  private listeners = new Map<string, Set<Listener>>();
  private buffer = new Map<string, Buffered[]>();
  private seqs = new Map<string, number>();

  subscribe(userId: string, fn: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(userId);
    };
  }

  emit(userId: string, ev: ServerEvent) {
    const seq = (this.seqs.get(userId) ?? 0) + 1;
    this.seqs.set(userId, seq);
    this.remember(userId, { seq, at: Date.now(), event: ev });
    const set = this.listeners.get(userId);
    if (!set) return;
    for (const fn of set) {
      try { fn(ev); } catch { /* ignore broken listener */ }
    }
  }

  /** Active SSE subscribers for this user; zero means a push notification is the only way to reach them. */
  connections(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }

  isOnline(userId: string) {
    return this.connections(userId) > 0;
  }

  /** The sequence number of the last event emitted for this user. */
  seq(userId: string): number {
    return this.seqs.get(userId) ?? 0;
  }

  /** Buffered events emitted after `seq`, oldest first. Prunes as it reads. */
  since(userId: string, seq: number): { seq: number; events: ServerEvent[] } {
    const all = this.prune(userId);
    const missed = all.filter((b) => b.seq > seq);
    return { seq: this.seq(userId), events: missed.map((b) => b.event) };
  }

  private remember(userId: string, entry: Buffered) {
    const all = this.prune(userId);
    all.push(entry);
    if (all.length > BUFFER_MAX) all.splice(0, all.length - BUFFER_MAX);
    this.buffer.set(userId, all);
  }

  /** Drop entries older than the window, and forget users with nothing left. */
  private prune(userId: string): Buffered[] {
    const all = this.buffer.get(userId);
    if (!all) return [];
    const cutoff = Date.now() - BUFFER_MS;
    const kept = all.filter((b) => b.at >= cutoff);
    if (kept.length) this.buffer.set(userId, kept);
    else this.buffer.delete(userId);
    return kept;
  }
}

export const hub = new Hub();
