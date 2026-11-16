import { useEffect, useState } from 'react';
import { api, type TeamTemplateSummary } from '../lib/api';
import { useStore } from '../store';
import { Modal } from './modals/Modal';

type Step = 'pick' | 'configure' | 'done';

/** Three-step wizard: pick a preset → configure name + schedule → create. */
export function TeamWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>('pick');
  const [templates, setTemplates] = useState<TeamTemplateSummary[]>([]);
  const [selected, setSelected] = useState<TeamTemplateSummary | null>(null);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.teamTemplates().then((r) => setTemplates(r.templates)).catch((e) => setError((e as Error).message));
  }, []);

  const pickTemplate = (t: TeamTemplateSummary) => {
    setSelected(t);
    setName(t.name);
    setSchedule(t.schedule);
    setStep('configure');
  };

  const create = async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const result = await api.createTeam({
        slug: selected.slug,
        name: name.trim() || undefined,
        schedule: schedule.trim() || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const { bots: all } = await api.bots();
      const st = useStore.getState();
      st.set({ bots: all });
      st.selectBot(result.roomId);
      setStep('done');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Create a team" className="team-wizard">
      <div className="team-wizard__header">
        <span className="team-wizard__title">
          {step === 'pick' ? 'Choose a team preset' : step === 'configure' ? `Set up ${selected?.name}` : 'Team created'}
        </span>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      {step === 'pick' && (
        <div className="team-wizard__gallery">
          {templates.length === 0 && !error && <p className="team-wizard__loading">Loading…</p>}
          {templates.map((t) => (
            <button key={t.slug} type="button" className="team-card" onClick={() => pickTemplate(t)}>
              <span className="team-card__name">{t.name}</span>
              <span className="team-card__tagline">{t.tagline}</span>
              <span className="team-card__desc">{t.description}</span>
              <span className="team-card__meta">{t.memberCount} bots · {t.schedule}</span>
            </button>
          ))}
        </div>
      )}

      {step === 'configure' && selected && (
        <div className="team-wizard__form">
          <label className="team-wizard__label">
            Team name
            <input
              className="text-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="team-wizard__label">
            Schedule (cron)
            <input
              className="text-input"
              type="text"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder={selected.schedule}
            />
            <span className="team-wizard__hint">Leave blank to use the preset default.</span>
          </label>
          {error && <p className="team-wizard__error">{error}</p>}
          <div className="team-wizard__actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setStep('pick'); setError(null); }}>Back</button>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create team'}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="team-wizard__done">
          <p>Your team is ready. Its group chat is now open.</p>
          <div className="team-wizard__actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={onClose}>Done</button>
          </div>
        </div>
      )}

      {step !== 'configure' && error && <p className="team-wizard__error">{error}</p>}
    </Modal>
  );
}
