import { useCallback, useEffect, useState } from 'react';
import { configApi, type HermesSettings, type HermesSettingsFile } from '../../lib/configApi';
import { ApiError } from '../../lib/api';
import { CodeEditor } from './CodeEditor';
import '../../styles/code-editor.css';

const FILES: { id: HermesSettingsFile; name: string; hint: string }[] = [
  { id: 'env', name: '.env', hint: 'API keys and other environment variables, one KEY=value per line.' },
  { id: 'config', name: 'config.yaml', hint: 'Hermes settings: providers, auxiliary models, MCP servers, search and more.' },
];

interface SaveProblem { file: HermesSettingsFile | null; line: number | null; message: string }

/**
 * Settings → API keys: the Hermes settings every Bot shares (the primary agent's own .env and
 * config.yaml, imported from this computer's Hermes), edited as text. Saving copies what changed to
 * every Bot and restarts the ones that are running.
 */
export function HermesSettingsPanel() {
  const [saved, setSaved] = useState<HermesSettings | null>(null);
  const [draft, setDraft] = useState<HermesSettings | null>(null);
  const [file, setFile] = useState<HermesSettingsFile>('env');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await configApi.hermesSettings();
      setSaved(s); setDraft(s); setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message || 'The server did not answer.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const dirty = (id: HermesSettingsFile) => !!saved && !!draft && saved[id] !== draft[id];
  const anyDirty = dirty('env') || dirty('config');

  const save = async () => {
    if (!draft || !saved || saving || !anyDirty) return;
    setSaving(true); setProblem(null); setNote(null);
    const patch: Partial<HermesSettings> = {};
    for (const f of FILES) if (dirty(f.id)) patch[f.id] = draft[f.id];
    try {
      const r = await configApi.saveHermesSettings(patch);
      setSaved(r.settings); setDraft(r.settings);
      const bots = r.updated.length;
      setNote(`Saved. ${bots ? `${bots} Bot${bots === 1 ? '' : 's'} updated` : 'No Bot needed a change'}${r.restarting ? `, ${r.restarting} restarting to pick it up` : ''}.`);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as Partial<SaveProblem> | undefined) : undefined;
      const at = body?.file ?? null;
      setProblem({ file: at, line: body?.line ?? null, message: (e as Error).message || 'The server did not answer.' });
      if (at) setFile(at);
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="cfg-error" role="alert">
        Couldn’t load the Hermes settings: {loadError}{' '}
        <button type="button" className="link-btn link-btn--small" onClick={() => { setLoadError(null); void load(); }}>Retry</button>
      </div>
    );
  }
  if (!draft) return <div className="engine-auth__skeleton" role="status" aria-label="Loading settings"><span /><span /></div>;

  const meta = FILES.find((f) => f.id === file)!;
  return (
    <section className="hermes-settings" aria-label="Hermes settings">
      <div className="hermes-settings__tabs" role="tablist">
        {FILES.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={file === f.id} className={`hermes-settings__tab${file === f.id ? ' is-on' : ''}`} onClick={() => setFile(f.id)}>
            {f.name}{dirty(f.id) && <span className="hermes-settings__dot" aria-label="unsaved changes" />}
          </button>
        ))}
      </div>
      <div className="cfg-field__hint">{meta.hint}</div>
      <CodeEditor
        key={file}
        label={meta.name}
        value={draft[file]}
        onChange={(v) => { setDraft({ ...draft, [file]: v }); setNote(null); if (problem?.file === file) setProblem(null); }}
        onSave={save}
        errorLine={problem?.file === file ? problem.line : null}
      />
      {problem && (
        <div className="cfg-error" role="alert">
          Not saved{problem.file ? ` (${FILES.find((f) => f.id === problem.file)?.name}${problem.line ? `, line ${problem.line}` : ''})` : ''}: {problem.message}
        </div>
      )}
      {note && <div className="hermes-settings__note" role="status">{note}</div>}
      <div className="hermes-settings__bar">
        <div className="cfg-field__hint">Saving copies what you changed to every Bot and restarts the ones that are running. A Bot keeps its own model choice.</div>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!anyDirty || saving} onClick={() => { setDraft(saved); setProblem(null); }}>Revert</button>
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!anyDirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </section>
  );
}
