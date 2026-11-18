import { useEffect, useState } from 'react';
import type { CardBody, DocEdits, DocReview, SheetEdits, SheetReview, WorkspaceFile } from '@orbit/contracts';
import { api } from '../../lib/api';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';

/**
 * Google Sheets and Google Docs in the chat:
 *  - SheetReviewCard: a write to an existing sheet, cell by cell (before → after), each "after" editable;
 *  - DocReviewCard: a change to an existing doc, as the text it adds, what it replaces, or a line diff;
 *  - FileNotice: a sheet or doc a bot created or changed, with a link and a short preview.
 */

type ApprovalCardBody = Extract<CardBody, { card: 'approval' }>;
const LOGO = { googlesheets: 'https://logos.composio.dev/api/googlesheets', googledocs: 'https://logos.composio.dev/api/googledocs' };
const EDIT_PING_MS = 5 * 60_000;

function useDecision(body: ApprovalCardBody, editing: boolean) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing || body.status !== 'pending') return;
    const touch = () => { void api.approvalEditing(body.approvalId).catch(() => {}); };
    touch();
    const t = setInterval(touch, EDIT_PING_MS);
    return () => clearInterval(t);
  }, [editing, body.status, body.approvalId]);
  const decide = async (d: 'allow' | 'always' | 'deny', edits?: unknown) => {
    setBusy(d); setError(null);
    try { await api.approve(body.approvalId, d, d === 'deny' ? undefined : edits); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(null); }
  };
  return { busy, error, decide };
}

const OUTCOME: Record<string, string> = { allowed: 'Done', always: 'Done, and always allowed', denied: 'Not done', expired: 'Expired' };

function Footer({ body, busy, edited, onDecide, error }: { body: ApprovalCardBody; busy: string | null; edited: boolean; onDecide: (d: 'allow' | 'always' | 'deny') => void; error: string | null }) {
  const showAlways = !body.rule && (body.alwaysFor || body.offerAlways !== false);
  return (
    <>
      {body.rule && <div className="card__rule">Asked because of your rule “{body.rule.description}”</div>}
      {body.status === 'pending' ? (
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => onDecide('deny')}>Don't allow</button>
          {showAlways && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => onDecide('always')}>{body.alwaysFor ? `Always allow for ${body.alwaysFor.botName}` : 'Always allow'}</button>}
          <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => onDecide('allow')}>{edited ? 'Allow with changes' : 'Allow'}</button>
        </div>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'denied' || body.status === 'expired' ? 'close' : 'check'} size={12} opacity={0.7} />
          {body.edited && body.status === 'allowed' ? 'Done, with your changes' : OUTCOME[body.status] ?? body.status}
        </div>
      )}
      {error && <div className="card__error" role="alert">{error}</div>}
    </>
  );
}

const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
const docUrl = (id: string) => `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`;

export function SheetReviewCard({ body }: { body: ApprovalCardBody }) {
  const review = body.review as SheetReview;
  const pending = body.status === 'pending';
  const [cells, setCells] = useState<Record<string, string>>({});
  const editing = Object.keys(cells).length > 0;
  const { busy, error, decide } = useDecision(body, editing);
  const changed = Object.fromEntries(Object.entries(cells).filter(([k, v]) => review.changes.find((c) => c.cell === k)?.after !== v));
  const edits: SheetEdits | undefined = Object.keys(changed).length ? { cells: changed } : undefined;

  return (
    <div className={`card ws-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name="Google Sheets" logo={LOGO.googlesheets} size={44} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">{review.title ?? 'Google Sheet'}{review.sheet ? ` · ${review.sheet}` : ''} · <a href={sheetUrl(review.spreadsheetId)} target="_blank" rel="noreferrer">Open</a></div>
        </div>
      </div>
      {review.steps.length > 0 && <ul className="ws-card__steps">{review.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>}
      {review.changes.length > 0 && (
        <div className="ws-card__grid-wrap">
          <table className="ws-card__grid">
            <thead><tr><th scope="col">Cell</th><th scope="col">Now</th><th scope="col">After</th></tr></thead>
            <tbody>
              {review.changes.map((c) => {
                const value = cells[c.cell] ?? c.after;
                return (
                  <tr key={c.cell} className={c.before === value ? 'is-same' : ''}>
                    <th scope="row">{c.cell}</th>
                    <td className="ws-card__before">{c.before || <span className="ws-card__empty">empty</span>}</td>
                    <td>
                      {pending && review.editable
                        ? <input className="ws-card__cell" aria-label={`New value for ${c.cell}`} value={value} onChange={(e) => setCells((m) => ({ ...m, [c.cell]: e.target.value }))} />
                        : value || <span className="ws-card__empty">empty</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {review.more > 0 && <div className="ws-card__more">and {review.more} more cell{review.more === 1 ? '' : 's'}</div>}
        </div>
      )}
      <Footer body={body} busy={busy} edited={!!edits} onDecide={(d) => void decide(d, edits)} error={error} />
    </div>
  );
}

export function DocReviewCard({ body }: { body: ApprovalCardBody }) {
  const review = body.review as DocReview;
  const pending = body.status === 'pending';
  const [insert, setInsert] = useState(review.insert);
  const [replaceWith, setReplaceWith] = useState(review.replace?.with);
  const [markdown, setMarkdown] = useState(review.markdown);
  const [editing, setEditing] = useState(false);
  const { busy, error, decide } = useDecision(body, editing);
  const edits: DocEdits = {};
  if (insert !== review.insert && insert !== undefined) edits.insert = insert;
  if (replaceWith !== review.replace?.with && replaceWith !== undefined) edits.replaceWith = replaceWith;
  if (markdown !== review.markdown && markdown !== undefined) edits.markdown = markdown;
  const hasEdits = Object.keys(edits).length > 0;
  const canEdit = pending && review.editable;

  return (
    <div className={`card ws-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name="Google Docs" logo={LOGO.googledocs} size={44} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">{review.title ?? 'Google Doc'} · <a href={docUrl(review.documentId)} target="_blank" rel="noreferrer">Open</a></div>
        </div>
        {canEdit && !editing && <button type="button" className="email-card__edit" onClick={() => setEditing(true)} aria-label="Edit change"><Icon name="edit" size={14} opacity={0.7} /> Edit</button>}
      </div>
      {review.steps.length > 0 && <ul className="ws-card__steps">{review.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>}
      {review.insert !== undefined && (
        editing && canEdit
          ? <textarea className="text-input ws-card__text" aria-label="Text to insert" rows={5} value={insert ?? ''} onChange={(e) => setInsert(e.target.value)} />
          : <pre className="ws-card__insert">{insert}</pre>
      )}
      {review.replace && (
        <div className="ws-card__replace">
          <div><span className="ws-card__label">Find</span> <mark className="ws-card__del">{review.replace.find}</mark>{review.replace.matchCase ? ' (exact case)' : ''}</div>
          <div><span className="ws-card__label">With</span> {editing && canEdit
            ? <input className="text-input" aria-label="Replace with" value={replaceWith ?? ''} onChange={(e) => setReplaceWith(e.target.value)} />
            : <mark className="ws-card__add">{replaceWith}</mark>}</div>
        </div>
      )}
      {review.markdown !== undefined && editing && canEdit && <textarea className="text-input ws-card__text" aria-label="New document text" rows={10} value={markdown ?? ''} onChange={(e) => setMarkdown(e.target.value)} />}
      {review.diff && !(editing && canEdit) && (
        <pre className="ws-card__diff">{review.diff.map((l, i) => <span key={i} className={l.startsWith('+ ') ? 'is-add' : l.startsWith('- ') ? 'is-del' : ''}>{l}{'\n'}</span>)}</pre>
      )}
      <Footer body={body} busy={busy} edited={hasEdits} onDecide={(d) => void decide(d, hasEdits ? edits : undefined)} error={error} />
    </div>
  );
}

/** A sheet or doc a bot created or changed. */
export function FileNotice({ file }: { file: WorkspaceFile }) {
  const sheet = file.app === 'googlesheets';
  return (
    <div className="card ws-file">
      <div className="card__head">
        <ToolkitLogo name={sheet ? 'Google Sheets' : 'Google Docs'} logo={LOGO[file.app]} size={36} />
        <div className="card__titles">
          <div className="card__title">{file.title}</div>
          <div className="card__sub">{file.action === 'created' ? 'Created' : 'Updated'} · {sheet ? 'Google Sheet' : 'Google Doc'}</div>
        </div>
        <a className="btn btn--secondary ws-file__open" href={file.url} target="_blank" rel="noreferrer">Open</a>
      </div>
      {file.preview.length > 0 && (sheet
        ? <div className="ws-card__grid-wrap"><table className="ws-card__grid ws-file__grid"><tbody>{file.preview.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
        : <div className="ws-file__lines">{file.preview.map((l, i) => <div key={i}>{l[0]}</div>)}</div>)}
      {file.preview.length === 0 && <div className="card__body ws-card__empty">Empty for now.</div>}
      <div className="ws-file__pad" />
    </div>
  );
}
