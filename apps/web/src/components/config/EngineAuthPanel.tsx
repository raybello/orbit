import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BotEngineAuthRow } from '@orbit/contracts';
import { configApi } from '../../lib/configApi';
import { Icon } from '../Icon';
import '../../styles/engineauth.css';

type EngineAuthPatch = { provider?: string; model?: string };

/** Every provider any Bot already uses, plus the ones the primary Bot's agent knows about. */
function providerIds(rows: BotEngineAuthRow[], extra: string[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) if (row.provider) seen.add(row.provider);
  for (const id of extra) if (id) seen.add(id);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

const keyLabel = (n: number) => `${n} ${n === 1 ? 'key' : 'keys'}`;

/** Model field for a managed row: the value is a draft until it is committed on blur or Enter. */
function ModelField({ row, onSave }: { row: BotEngineAuthRow; onSave: (patch: EngineAuthPatch) => void }) {
  const [draft, setDraft] = useState(row.model ?? '');
  useEffect(() => { setDraft(row.model ?? ''); }, [row.model]);
  const commit = () => {
    const next = draft.trim();
    if (next === (row.model ?? '')) return;
    onSave({ model: next });
  };
  return (
    <input
      className="engine-auth__input"
      aria-label={`Model for ${row.name}`}
      value={draft}
      placeholder="Default"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

/**
 * App Settings → Engine Auth: one row per Bot showing which engine runs it, the provider and model,
 * and whether it has the shared credentials it needs. Managed rows save in place; the primary Bot
 * follows the computer's own agent and is read-only.
 */
export function EngineAuthPanel() {
  const [rows, setRows] = useState<BotEngineAuthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [knownProviders, setKnownProviders] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await configApi.engineAuth();
      setRows(r?.bots ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message || 'The server did not answer.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The primary Bot's agent reports every provider installed on the computer. Best effort: the
  // table still works with only the providers the Bots already use.
  const primary = rows?.find((r) => r.engine === 'primary') ?? null;
  const primaryId = primary?.botId ?? null;
  useEffect(() => {
    if (!primaryId) return;
    let alive = true;
    try {
      configApi.engine?.(primaryId)
        .then((r) => { if (alive) setKnownProviders((r?.engine?.providers ?? []).map((p) => p.id)); })
        .catch(() => { /* the dropdown falls back to the providers already in use */ });
    } catch { /* same */ }
    return () => { alive = false; };
  }, [primaryId]);

  const options = useMemo(() => providerIds(rows ?? [], knownProviders), [rows, knownProviders]);

  /** Optimistic: the row shows the change at once and goes back if the server refuses it. */
  const save = async (row: BotEngineAuthRow, patch: EngineAuthPatch) => {
    const before = rows;
    setRows((rs) => rs?.map((r) => (r.botId === row.botId ? { ...r, ...patch } : r)) ?? rs);
    setNote(null);
    try {
      const { bot } = await configApi.setEngineAuth(row.botId, patch);
      setRows((rs) => rs?.map((r) => (r.botId === row.botId ? { ...r, ...bot } : r)) ?? rs);
    } catch (e) {
      setRows(before);
      setNote(`Couldn’t save ${row.name}’s engine: ${(e as Error).message || 'the server did not answer'}`);
    }
  };

  const sync = async () => {
    if (syncing) return;
    setSyncing(true); setNote(null);
    try { await configApi.syncEngineAuth(); await load(); }
    catch (e) { setNote(`Couldn’t sync credentials: ${(e as Error).message || 'the server did not answer'}`); }
    finally { setSyncing(false); }
  };

  return (
    <section className="engine-auth" aria-label="Engine auth">
      <div className="engine-auth__bar">
        <div className="engine-auth__bar-text">
          <div className="engine-auth__bar-title">Models and credentials</div>
          <div className="engine-auth__bar-sub">Each Bot picks its own model; managed Bots share the primary Bot’s provider credentials.</div>
        </div>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={sync} disabled={syncing}>
          <Icon name="refresh" size={13} opacity={0.7} />
          {syncing ? 'Syncing…' : 'Sync all'}
        </button>
      </div>

      {error && (
        <div className="cfg-error engine-auth__error" role="alert">
          <span>Couldn’t load engines: {error}</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => { setError(null); setRows(null); void load(); }}>Retry</button>
        </div>
      )}
      {note && <div className="cfg-error engine-auth__error" role="alert">{note}</div>}

      {rows === null && !error ? (
        <div className="engine-auth__skeleton" role="status" aria-label="Loading engines">
          <span /><span /><span />
        </div>
      ) : rows && rows.length === 0 ? (
        <div className="cfg-empty">No Bots yet. Create one and its engine shows up here.</div>
      ) : rows ? (
        <div className="engine-auth__table-wrap">
          <table className="engine-auth__table">
            <thead>
              <tr>
                <th scope="col">Bot</th>
                <th scope="col">Engine</th>
                <th scope="col">Provider</th>
                <th scope="col">Model</th>
                <th scope="col">Credentials</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const managed = row.engine === 'managed';
                const keys = row.keysPresent ?? [];
                const saveRow = (patch: EngineAuthPatch) => { void save(row, patch); };
                return (
                  <tr key={row.botId} className={`engine-auth__row is-${row.engine}`} data-bot-id={row.botId}>
                    <td className="engine-auth__bot">{row.name}</td>
                    <td>
                      <span className={`cfg-chip${managed ? '' : ' cfg-chip--muted'}`}>{managed ? 'Managed' : 'Primary'}</span>
                      {!managed && <div className="engine-auth__note">Follows the computer’s own agent</div>}
                    </td>
                    <td>
                      {managed ? (
                        <select
                          className="engine-auth__select"
                          aria-label={`Provider for ${row.name}`}
                          value={row.provider ?? ''}
                          onChange={(e) => saveRow({ provider: e.target.value })}
                        >
                          <option value="">Default</option>
                          {options.map((id) => <option key={id} value={id}>{id}</option>)}
                        </select>
                      ) : (
                        <span className="engine-auth__value">{row.provider || 'Default'}</span>
                      )}
                    </td>
                    <td>
                      {managed ? (
                        <ModelField row={row} onSave={saveRow} />
                      ) : (
                        <span className="engine-auth__value">{row.model || 'Default'}</span>
                      )}
                    </td>
                    <td>
                      {keys.length > 0 ? (
                        <span className="cfg-chip engine-auth__keys" title={keys.join(', ')}>✓ {keyLabel(keys.length)}</span>
                      ) : (
                        <span className="engine-auth__warn" title="No shared credentials in this Bot’s .env">No credentials</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="cfg-field__hint">
        Sync all copies the primary Bot’s provider credentials to every managed Bot. Models are not copied.
      </div>
    </section>
  );
}
