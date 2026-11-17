import { useEffect, useRef, useState } from 'react';
import { api, type TeamTemplateSummary } from '../lib/api';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Modal } from './modals/Modal';

type Step = 'pick' | 'configure' | 'done';

type Freq = 'daily' | 'weekdays' | 'weekly' | 'monthly';

const FREQ_LABELS: Record<Freq, string> = {
  daily: 'Every day',
  weekdays: 'Weekdays (Mon–Fri)',
  weekly: 'Once a week',
  monthly: 'Once a month',
};

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
function hourLabel(h: number) {
  if (h === 12) return '12:00 PM';
  if (h < 12) return `${h}:00 AM`;
  return `${h - 12}:00 PM`;
}

interface ScheduleConfig {
  freq: Freq;
  hour: number;
  weekday: number; // 1=Mon for weekly
  monthDay: number; // 1-28 for monthly
}

function parseCron(cron: string): ScheduleConfig {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { freq: 'weekdays', hour: 9, weekday: 1, monthDay: 1 };
  const [, hourStr, domStr, , dowStr] = parts;
  const hour = parseInt(hourStr, 10);
  const h = isNaN(hour) ? 9 : hour;
  if (domStr !== '*') return { freq: 'monthly', hour: h, weekday: 1, monthDay: Math.max(1, parseInt(domStr, 10) || 1) };
  if (dowStr === '*') return { freq: 'daily', hour: h, weekday: 1, monthDay: 1 };
  if (dowStr === '1-5') return { freq: 'weekdays', hour: h, weekday: 1, monthDay: 1 };
  return { freq: 'weekly', hour: h, weekday: Math.max(0, parseInt(dowStr, 10) || 1), monthDay: 1 };
}

function configToCron(c: ScheduleConfig): string {
  const h = c.hour;
  switch (c.freq) {
    case 'daily': return `0 ${h} * * *`;
    case 'weekdays': return `0 ${h} * * 1-5`;
    case 'weekly': return `0 ${h} * * ${c.weekday}`;
    case 'monthly': return `0 ${h} ${c.monthDay} * *`;
  }
}

function humanSchedule(c: ScheduleConfig): string {
  const time = hourLabel(c.hour);
  switch (c.freq) {
    case 'daily': return `Daily at ${time}`;
    case 'weekdays': return `Weekdays at ${time}`;
    case 'weekly': return `${WEEKDAY_LABELS[c.weekday]}s at ${time}`;
    case 'monthly': return `${ordinal(c.monthDay)} of each month at ${time}`;
  }
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function PipelineViz({ names, primaryName }: { names: string[]; primaryName?: string }) {
  const all = primaryName ? [primaryName, ...names] : names;
  return (
    <div className="team-pipeline">
      {all.map((name, i) => (
        <span key={i} className="team-pipeline__step">
          <span className="team-pipeline__node">{name}</span>
          {i < all.length - 1 && (
            <span className="team-pipeline__arrow" aria-hidden>
              <Icon name="chev_right" size={12} />
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

export function TeamWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>('pick');
  const [templates, setTemplates] = useState<TeamTemplateSummary[]>([]);
  const [selected, setSelected] = useState<TeamTemplateSummary | null>(null);
  const [name, setName] = useState('');
  const [schedCfg, setSchedCfg] = useState<ScheduleConfig>({ freq: 'weekdays', hour: 9, weekday: 1, monthDay: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdBots, setCreatedBots] = useState<string[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.teamTemplates().then((r) => setTemplates(r.templates)).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (step === 'configure') setTimeout(() => nameRef.current?.focus(), 50);
  }, [step]);

  const pickTemplate = (t: TeamTemplateSummary) => {
    setSelected(t);
    setName(t.name);
    setSchedCfg(parseCron(t.schedule));
    setStep('configure');
  };

  const create = async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const result = await api.createTeam({
        slug: selected.slug,
        name: name.trim() || undefined,
        schedule: configToCron(schedCfg),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const { bots: all } = await api.bots();
      const st = useStore.getState();
      st.set({ bots: all });
      st.selectBot(result.roomId);
      setCreatedBots(selected.memberNames);
      setStep('done');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const goBack = () => { setStep('pick'); setError(null); };

  const title =
    step === 'pick' ? 'Create a Team' :
    step === 'configure' ? `Set up ${selected?.name}` :
    'Team created';

  return (
    <Modal onClose={onClose} label={title} className="team-wizard">
      <div className="modal__header">
        {step === 'configure' && (
          <button type="button" className="team-wizard__back icon-btn" aria-label="Back" onClick={goBack}>
            <Icon name="chev_left" size={16} />
          </button>
        )}
        <span className="modal__title">{title}</span>
        <button type="button" className="modal__close icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>

      {step === 'pick' && (
        <div className="team-wizard__gallery">
          {templates.length === 0 && !error && (
            <div className="team-wizard__loading">Loading presets…</div>
          )}
          {templates.map((t) => (
            <button key={t.slug} type="button" className="team-card" onClick={() => pickTemplate(t)}>
              <div className="team-card__header">
                <span className="team-card__name">{t.name}</span>
                <span className="team-card__badge">{t.memberCount} bots</span>
              </div>
              <span className="team-card__tagline">{t.tagline}</span>
              <span className="team-card__desc">{t.description}</span>
              <PipelineViz names={t.memberNames} />
            </button>
          ))}
          {error && <p className="team-wizard__error">{error}</p>}
        </div>
      )}

      {step === 'configure' && selected && (
        <div className="team-wizard__form">
          <div className="team-wizard__section">
            <label className="team-wizard__label" htmlFor="tw-name">Team name</label>
            <input
              id="tw-name"
              ref={nameRef}
              className="text-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="team-wizard__section">
            <div className="team-wizard__label">Workflow</div>
            <PipelineViz names={selected.memberNames} />
            <p className="team-wizard__hint">Your primary bot orchestrates the sequence above on the schedule you choose.</p>
          </div>

          <div className="team-wizard__section">
            <div className="team-wizard__label">Schedule</div>
            <div className="team-wizard__sched-row">
              <select
                className="text-input team-wizard__select"
                value={schedCfg.freq}
                onChange={(e) => setSchedCfg((c) => ({ ...c, freq: e.target.value as Freq }))}
              >
                {(Object.entries(FREQ_LABELS) as [Freq, string][]).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
              {schedCfg.freq === 'weekly' && (
                <select
                  className="text-input team-wizard__select"
                  value={schedCfg.weekday}
                  onChange={(e) => setSchedCfg((c) => ({ ...c, weekday: +e.target.value }))}
                >
                  {[1, 2, 3, 4, 5].map((d) => (
                    <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>
                  ))}
                </select>
              )}
              {schedCfg.freq === 'monthly' && (
                <select
                  className="text-input team-wizard__select"
                  value={schedCfg.monthDay}
                  onChange={(e) => setSchedCfg((c) => ({ ...c, monthDay: +e.target.value }))}
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{ordinal(d)}</option>
                  ))}
                </select>
              )}
              <select
                className="text-input team-wizard__select"
                value={schedCfg.hour}
                onChange={(e) => setSchedCfg((c) => ({ ...c, hour: +e.target.value }))}
              >
                {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
            <span className="team-wizard__sched-preview">{humanSchedule(schedCfg)}</span>
          </div>

          {error && <p className="team-wizard__error">{error}</p>}

          <div className="team-wizard__footer">
            <button type="button" className="btn btn--secondary btn--sm" onClick={goBack}>Back</button>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create team'}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && selected && (
        <div className="team-wizard__done">
          <div className="team-wizard__done-icon" aria-hidden>✓</div>
          <h3 className="team-wizard__done-title">{name} is ready</h3>
          <p className="team-wizard__done-sub">
            {createdBots.length} bots were created and added to the team chat.
          </p>
          <div className="team-wizard__done-bots">
            {createdBots.map((n) => (
              <span key={n} className="team-wizard__done-bot">{n}</span>
            ))}
          </div>
          <p className="team-wizard__done-sched">
            Runs {humanSchedule(schedCfg)} · starts disabled
          </p>
          <div className="team-wizard__footer">
            <button type="button" className="btn btn--primary btn--sm" onClick={onClose}>Open team chat</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
