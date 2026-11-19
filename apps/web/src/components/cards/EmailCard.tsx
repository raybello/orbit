import { useEffect, useRef, useState } from 'react';
import type { CardBody, EmailReview, Row } from '@orbit/contracts';
import { emailFieldsOf, emailEditsOf, splitAddresses, joinAddresses, type EmailFields } from '@orbit/domain';
import { api } from '../../lib/api';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';

type DraftCardBody = Extract<CardBody, { card: 'draft' }>;
type ApprovalCardBody = Extract<CardBody, { card: 'approval' }>;

const GMAIL_LOGO = 'https://logos.composio.dev/api/gmail';
type Fields = EmailFields;

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); return true; } catch (e) { setError((e as Error).message || 'Something went wrong'); return false; } finally { setBusy(null); }
  };
  return { busy, error, run };
}

/** The email itself: read-only, or as fields while editing. */
function EmailBody({ email, fields, editing, onChange, idBase }: { email: EmailReview; fields: Fields; editing: boolean; onChange: (f: Fields) => void; idBase: string }) {
  const put = (k: keyof Fields) => (v: string) => onChange({ ...fields, [k]: v });
  if (!editing) {
    return (
      <div className="email-card__content">
        <div className="email-card__row"><span className="email-card__label">To</span><span className="email-card__value">{fields.to || <em>No recipient</em>}</span></div>
        {fields.cc && <div className="email-card__row"><span className="email-card__label">Cc</span><span className="email-card__value">{fields.cc}</span></div>}
        {fields.bcc && <div className="email-card__row"><span className="email-card__label">Bcc</span><span className="email-card__value">{fields.bcc}</span></div>}
        {fields.subject && <div className="email-card__subject">{fields.subject}</div>}
        <div className="email-card__text">{fields.body}</div>
      </div>
    );
  }
  const input = (k: 'to' | 'cc' | 'bcc' | 'subject', label: string, disabled = false) => (
    <label className="email-card__field" htmlFor={`${idBase}-${k}`}>
      <span className="email-card__label">{label}</span>
      <input id={`${idBase}-${k}`} className="text-input email-card__input" value={fields[k]} disabled={disabled} onChange={(e) => put(k)(e.target.value)} placeholder={k === 'subject' ? 'Subject' : 'name@example.com, …'} />
    </label>
  );
  return (
    <div className="email-card__content is-editing">
      {input('to', 'To')}
      {input('cc', 'Cc')}
      {input('bcc', 'Bcc')}
      {input('subject', 'Subject', email.action === 'reply')}
      <label className="email-card__field email-card__field--body" htmlFor={`${idBase}-body`}>
        <span className="sr-only">Message</span>
        <textarea id={`${idBase}-body`} className="text-input email-card__textarea" rows={8} value={fields.body} onChange={(e) => put('body')(e.target.value)} />
      </label>
      {email.isHtml && <div className="email-card__hint">This email is sent as HTML.</div>}
    </div>
  );
}

function Head({ title, sub, onEdit, editing, canEdit }: { title: string; sub: string; onEdit: () => void; editing: boolean; canEdit: boolean }) {
  return (
    <div className="card__head">
      <ToolkitLogo name="Gmail" logo={GMAIL_LOGO} size={44} />
      <div className="card__titles">
        <div className="card__title">{title}</div>
        <div className="card__sub">{sub}</div>
      </div>
      {canEdit && !editing && (
        <button type="button" className="email-card__edit" onClick={onEdit} aria-label="Edit email">
          <Icon name="edit" size={14} opacity={0.7} /> Edit
        </button>
      )}
    </div>
  );
}

/** A Gmail draft the bot wrote. */
export function DraftEmailCard({ row, body }: { row: Row; body: DraftCardBody }) {
  const email = body.email!;
  const pending = body.status === 'pending';
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<Fields>(() => emailFieldsOf(email));
  const { busy, error, run } = useBusy();
  useEffect(() => { if (!editing) setFields(emailFieldsOf(email)); }, [email, editing]);

  const act = (action: 'save' | 'send' | 'discard') => run(action, async () => {
    await api.draftAction(row.botId, row.seq, action, action === 'discard' ? undefined : emailEditsOf(email, fields));
    setEditing(false);
  });

  return (
    <div className={`card email-card${pending ? '' : ' is-resolved'}`}>
      <Head title={body.status === 'sent' ? 'Email sent' : 'Email draft'} sub={email.subject || 'No subject'} editing={editing} canEdit={pending && email.editable} onEdit={() => setEditing(true)} />
      <EmailBody email={email} fields={fields} editing={editing && pending} onChange={setFields} idBase={`draft-${row.seq}`} />
      {pending ? (
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => void act('discard')}>{busy === 'discard' ? 'Discarding…' : 'Discard'}</button>
          {editing && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => void act('save')}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>}
          <button type="button" className="btn btn--primary" disabled={!!busy || !splitAddresses(fields.to).length} onClick={() => void act('send')}>{busy === 'send' ? 'Sending…' : 'Send'}</button>
        </div>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'sent' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'sent' ? `Sent to ${joinAddresses(email.to)}` : 'Discarded'}
        </div>
      )}
      {error && <div className="card__error" role="alert">{error}</div>}
    </div>
  );
}

const EDIT_PING_MS = 5 * 60_000;

/** An email the bot asked to send, waiting for the person. */
export function ApprovalEmailCard({ body }: { body: ApprovalCardBody }) {
  const email = body.review as EmailReview;
  const pending = body.status === 'pending';
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<Fields>(() => emailFieldsOf(email));
  const { busy, error, run } = useBusy();
  const ping = useRef<ReturnType<typeof setInterval> | null>(null);

  // While the person edits, the bot's call keeps waiting for them.
  useEffect(() => {
    if (!editing || !pending) return;
    const touch = () => { void api.approvalEditing(body.approvalId).catch(() => {}); };
    touch();
    ping.current = setInterval(touch, EDIT_PING_MS);
    return () => { if (ping.current) clearInterval(ping.current); };
  }, [editing, pending, body.approvalId]);

  const decide = (d: 'allow' | 'always' | 'deny') => run(d, () => api.approve(body.approvalId, d, d === 'deny' ? undefined : emailEditsOf(email, fields)));
  const verb = email.action === 'reply' ? 'reply' : email.action === 'forward' ? 'forward this' : 'send this email';
  const showAlways = !body.rule && (body.alwaysFor || body.offerAlways !== false);
  const outcome: Record<string, string> = { allowed: body.edited ? 'Sent with your changes' : 'Sent', always: 'Sent, and always allowed', denied: 'Not sent', expired: 'Expired' };

  return (
    <div className={`card email-card${pending ? '' : ' is-resolved'}`}>
      <Head title={body.title} sub={email.action === 'send_draft' ? 'Gmail draft' : 'Gmail'} editing={editing} canEdit={pending && email.editable} onEdit={() => setEditing(true)} />
      <EmailBody email={email} fields={pending ? fields : emailFieldsOf(email)} editing={editing && pending} onChange={setFields} idBase={`apr-${body.approvalId}`} />
      {body.rule && <div className="card__rule">Asked because of your rule “{body.rule.description}”</div>}
      {pending ? (
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => void decide('deny')}>Don't {verb.split(' ')[0]}</button>
          {showAlways && (
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => void decide('always')}>
              {body.alwaysFor ? `Always allow for ${body.alwaysFor.botName}` : 'Always allow'}
            </button>
          )}
          <button type="button" className="btn btn--primary" disabled={!!busy || !splitAddresses(fields.to).length} onClick={() => void decide('allow')}>
            {emailEditsOf(email, fields) ? 'Send with changes' : 'Send'}
          </button>
        </div>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'denied' || body.status === 'expired' ? 'close' : 'check'} size={12} opacity={0.7} />
          {outcome[body.status] ?? body.status}
        </div>
      )}
      {error && <div className="card__error" role="alert">{error}</div>}
    </div>
  );
}
