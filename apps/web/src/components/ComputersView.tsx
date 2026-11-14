import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotComputerStatus } from '@orbit/contracts';
import { api } from '../lib/api';
import { useStore } from '../store';
import { ComputerCard } from './ComputerCard';
import { Icon } from './Icon';
import '../styles/computers.css';

/** How often the grid re-reads /api/computers while it is on screen. */
export const POLL_MS = 15_000;

/**
 * Every bot's computer in one grid. Bots without a computer are counted in a footer line rather than
 * given an empty card, so the grid only ever holds something you can look at.
 */
export function ComputersView() {
  const selectBot = useStore((s) => s.selectBot);
  const set = useStore((s) => s.set);

  const [computers, setComputers] = useState<BotComputerStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  /** Read the list. `manual` shows the spinner; polling stays silent so the grid does not flicker. */
  const load = useCallback(async (manual = false) => {
    if (manual) setLoading(true);
    try {
      const { computers: next } = await api.computers();
      if (!alive.current) return;
      setComputers(next);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      // Keep whatever was already on screen; the error line sits above it.
      setError((e as Error).message || 'Could not read the computers.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const open = useCallback((botId: string) => {
    selectBot(botId);
    set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null });
  }, [selectBot, set]);

  const withComputer = (computers ?? []).filter((c) => c.kind !== 'none');
  const without = (computers ?? []).length - withComputer.length;
  const count = withComputer.length;

  return (
    <div className="computers">
      <div className="computers__bar">
        <span className="computers__count">
          {count} {count === 1 ? 'computer' : 'computers'}
        </span>
        <button
          type="button"
          className="computers__refresh"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label="Refresh computers"
        >
          <Icon name="refresh" size={14} />
          <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </div>

      {error && (
        <div className="computers__error" role="alert">
          <span className="computers__error-text">{error}</span>
          <button type="button" className="computers__retry" onClick={() => void load(true)}>
            Retry
          </button>
        </div>
      )}

      {computers === null && !error && (
        <div className="computers__state" role="status">Loading computers…</div>
      )}

      {computers !== null && count === 0 && (
        <div className="computers__state">No Bots have a computer yet.</div>
      )}

      {count > 0 && (
        <div className="computers__grid">
          {withComputer.map((bot) => (
            <ComputerCard key={bot.botId} bot={bot} onOpen={open} />
          ))}
        </div>
      )}

      {without > 0 && (
        <p className="computers__muted">
          {without} {without === 1 ? 'Bot has' : 'Bots have'} no computer
        </p>
      )}
    </div>
  );
}
