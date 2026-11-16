import { useEffect, useMemo, useState } from 'react';
import type { BotTemplate, BotTemplateSummary, TemplatesResponse } from '@orbit/contracts';
import { BotAvatar } from '../avatar/BotAvatar';
import { ApiError } from '../lib/api';
import { templatesApi } from '../lib/templatesApi';
import { openNewBot, useTemplatesUI } from '../templatesStore';
import { Icon } from './Icon';
import { Modal } from './modals/Modal';
import '../styles/templates.css';

const ALL = 'All';

/** Whether a card belongs on screen for this search and category. */
export function matchesTemplate(t: BotTemplateSummary, query: string, category: string): boolean {
  if (category !== ALL && t.category !== category) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [t.title, t.label, t.description, t.category, ...t.suggestedApps].some((s) => s.toLowerCase().includes(q));
}

export function TemplateGallery() {
  const open = useTemplatesUI((s) => s.open);
  const close = useTemplatesUI((s) => s.close);
  const [data, setData] = useState<TemplatesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL);

  useEffect(() => {
    templatesApi.gallery().then(setData).catch((e: Error) => setError(e.message));
  }, []);

  const shown = useMemo(() => (data?.templates ?? []).filter((t) => matchesTemplate(t, query, category)), [data, query, category]);

  return (
    <Modal onClose={close} className="templates-modal" label="Templates">
      <div className="modal__header">
        <div className="modal__title">Templates</div>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      <div className="templates__toolbar">
        <div className="templates__search">
          <Icon name="search" size={12} opacity={0.5} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            aria-label="Search templates"
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="templates__chips" role="radiogroup" aria-label="Category">
          {[ALL, ...(data?.categories ?? [])].map((c) => (
            <button key={c} type="button" role="radio" aria-checked={category === c} className={`templates__chip${category === c ? ' is-active' : ''}`} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="templates__body">
        {error && <div className="templates__note">{error}</div>}
        {!error && !data && <div className="templates__note">Loading templates…</div>}
        {data && shown.length === 0 && <div className="templates__note">No templates match “{query.trim() || category}”.</div>}
        <ul className="templates__grid">
          {shown.map((t) => (
            <li key={t.id}>
              <button type="button" className="template-card" onClick={() => open({ kind: 'detail', templateId: t.id, from: 'gallery' })}>
                <BotAvatar shape={t.avatarShape} color={t.avatarColor} size={36} />
                <span className="template-card__text">
                  <span className="template-card__title">{t.title}</span>
                  <span className="template-card__label">{t.label}</span>
                  <span className="template-card__desc">{t.description}</span>
                  <span className="template-card__cadence"><Icon name="clock" size={11} opacity={0.6} />{t.cadence}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

export function TemplateDetail({ templateId, from }: { templateId: string; from: 'gallery' | 'link' }) {
  const open = useTemplatesUI((s) => s.open);
  const close = useTemplatesUI((s) => s.close);
  const [template, setTemplate] = useState<BotTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    templatesApi.get(templateId)
      .then((r) => setTemplate(r.template))
      .catch((e: Error) => setError(e instanceof ApiError && e.status === 404 ? 'This template is no longer shared.' : e.message));
  }, [templateId]);

  const install = async () => {
    setBusy(true); setError(null);
    try {
      const { bot } = await templatesApi.install(templateId);
      close();
      openNewBot(bot);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} className="templates-modal template-detail" label={template?.title ?? 'Template'}>
      <div className="modal__header">
        {from === 'gallery' && (
          <button type="button" className="link-btn link-btn--small template-detail__back" onClick={() => open({ kind: 'gallery' })}>All templates</button>
        )}
        <div className="modal__title">{template?.title ?? 'Template'}</div>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      <div className="templates__body template-detail__body">
        {!template && !error && <div className="templates__note">Loading…</div>}
        {template && (
          <>
            <div className="template-detail__hero">
              <BotAvatar shape={template.avatarShape} color={template.avatarColor} size={64} />
              <div>
                <div className="template-detail__title">{template.title}</div>
                <div className="template-detail__meta">
                  {template.label}
                  {template.origin === 'starter' ? ' · Starter' : template.ownerName ? ` · Shared by ${template.ownerName}` : ''}
                </div>
              </div>
            </div>
            {template.description && <p className="template-detail__desc">{template.description}</p>}
            <dl className="template-detail__facts">
              <dt>When it works</dt>
              <dd>{template.cadence}</dd>
              {template.suggestedApps.length > 0 && (
                <>
                  <dt>Works best with</dt>
                  <dd>{template.suggestedApps.join(', ')}</dd>
                </>
              )}
              {template.skills.length > 0 && (
                <>
                  <dt>Skills</dt>
                  <dd>{template.skills.map((s) => s.name).join(', ')}</dd>
                </>
              )}
            </dl>
            {template.instructions && (
              <section className="template-detail__section">
                <h3>Instructions</h3>
                <p className="template-detail__instructions">{template.instructions}</p>
              </section>
            )}
            {template.routines.length > 0 && (
              <section className="template-detail__section">
                <h3>Routines</h3>
                <ul className="template-detail__routines">
                  {template.routines.map((r, i) => <li key={i}><strong>{r.name}</strong>: {r.prompt}</li>)}
                </ul>
                <p className="template-detail__hint">Routines start paused. Turn them on from the Bot&apos;s settings once its apps are connected.</p>
              </section>
            )}
          </>
        )}
        {error && <div className="card__error">{error}</div>}
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--secondary btn--sm" onClick={close}>Cancel</button>
        <button type="button" className="btn btn--primary btn--sm" disabled={!template || busy} onClick={install}>{busy ? 'Installing…' : 'Install'}</button>
      </div>
    </Modal>
  );
}
