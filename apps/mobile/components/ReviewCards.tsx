import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { CardBody, DocReview, EmailReview, EventFields, EventReview, SheetReview, WorkspaceFile } from '@orbit/contracts';
import { docEditsOf, emailEditsOf, emailFieldsOf, eventEditsOf, joinAddresses as join, OUTCOME, SCOPES, sheetEditsOf, splitAddresses as split, whenOf, type EmailFields } from '@orbit/domain';
import type { MobileTokens } from '../lib/native';
import { touchApproval, useApproval, useDraftAction } from '../lib/queries';

/**
 * The phone's versions of the review cards (the web's EmailCard, EventCard and WorkspaceCards):
 * a Gmail draft to send or discard, a send, a calendar change, a sheet or doc change, each shown in
 * full and editable before it runs, and a created or changed file with a link.
 */

type Approval = Extract<CardBody, { card: 'approval' }>;
type Draft = Extract<CardBody, { card: 'draft' }>;
const EDIT_PING_MS = 5 * 60_000;

function box(tokens: MobileTokens) {
  return {
    marginHorizontal: tokens.space.xl, marginVertical: tokens.space.xs, padding: tokens.space.lg, gap: tokens.space.sm,
    borderRadius: tokens.radii.card, borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.colors.border, backgroundColor: tokens.colors.bgElevated,
  } as const;
}

function Kicker({ tokens, children }: { tokens: MobileTokens; children: ReactNode }) {
  return <Text style={{ color: tokens.colors.fgTertiary, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>{children}</Text>;
}

function Line({ tokens, label, value, was }: { tokens: MobileTokens; label: string; value: string; was?: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: tokens.space.sm }}>
      <Text style={{ width: 64, color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.sm }}>{label}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>{value || '—'}</Text>
        {was !== undefined && was !== value ? <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption, textDecorationLine: 'line-through' }}>was {was || 'empty'}</Text> : null}
      </View>
    </View>
  );
}

function Input({ tokens, label, value, onChange, multiline, editable = true }: { tokens: MobileTokens; label: string; value: string; onChange: (v: string) => void; multiline?: boolean; editable?: boolean }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={editable}
        multiline={multiline}
        autoCapitalize="none"
        style={{
          color: tokens.colors.fg, fontSize: tokens.fontSizes.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.colors.border,
          borderRadius: tokens.radii.md, paddingHorizontal: tokens.space.md, paddingVertical: tokens.space.sm, minHeight: multiline ? 110 : undefined,
          textAlignVertical: multiline ? 'top' : 'center', opacity: editable ? 1 : 0.6,
        }}
      />
    </View>
  );
}

function Button({ tokens, label, onPress, kind = 'plain', busy }: { tokens: MobileTokens; label: string; onPress: () => void; kind?: 'primary' | 'plain' | 'danger'; busy?: boolean }) {
  const bg = kind === 'primary' ? tokens.colors.accent : kind === 'danger' ? tokens.colors.destructiveBg : tokens.colors.bgSubtle;
  const fg = kind === 'primary' ? tokens.colors.onAccent : kind === 'danger' ? tokens.colors.destructive : tokens.colors.fg;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={busy} style={{ flexGrow: 1, paddingVertical: tokens.space.md, paddingHorizontal: tokens.space.md, borderRadius: tokens.radii.md, backgroundColor: bg, opacity: busy ? 0.6 : 1, alignItems: 'center' }}>
      <Text style={{ color: fg, fontSize: tokens.fontSizes.sm, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

function Outcome({ tokens, text }: { tokens: MobileTokens; text: string }) {
  return <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{text}</Text>;
}

/** Keep the bot's call waiting while the person edits. */
function useEditPing(approvalId: string, editing: boolean, pending: boolean) {
  useEffect(() => {
    if (!editing || !pending) return;
    void touchApproval(approvalId).catch(() => {});
    const t = setInterval(() => { void touchApproval(approvalId).catch(() => {}); }, EDIT_PING_MS);
    return () => clearInterval(t);
  }, [approvalId, editing, pending]);
}

function ApprovalButtons({ tokens, body, botId, edits, allowLabel, danger }: { tokens: MobileTokens; body: Approval; botId: string; edits: unknown; allowLabel: string; danger?: boolean }) {
  const approval = useApproval(botId);
  const decide = (decision: 'allow' | 'always' | 'deny') => approval.mutate({ approvalId: body.approvalId, decision, ...(decision !== 'deny' && edits ? { edits } : {}) });
  const showAlways = !body.rule && (body.alwaysFor || body.offerAlways !== false);
  return (
    <>
      {body.rule ? <Outcome tokens={tokens} text={`Asked because of your rule “${body.rule.description}”`} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: tokens.space.sm }}>
        <Button tokens={tokens} label="Don't allow" onPress={() => decide('deny')} busy={approval.isPending} />
        {showAlways ? <Button tokens={tokens} label={body.alwaysFor ? `Always for ${body.alwaysFor.botName}` : 'Always'} onPress={() => decide('always')} busy={approval.isPending} /> : null}
        <Button tokens={tokens} label={allowLabel} kind={danger ? 'danger' : 'primary'} onPress={() => decide('allow')} busy={approval.isPending} />
      </View>
      {approval.error ? <Text style={{ color: tokens.colors.destructive, fontSize: tokens.fontSizes.caption }}>{(approval.error as Error).message}</Text> : null}
    </>
  );
}

// ---------------------------------------------------------------- email

function EmailView({ tokens, email, form, editing, setForm }: { tokens: MobileTokens; email: EmailReview; form: EmailFields; editing: boolean; setForm: (f: EmailFields) => void }) {
  if (!editing) {
    return (
      <View style={{ gap: tokens.space.xs }}>
        <Line tokens={tokens} label="To" value={form.to} />
        {form.cc ? <Line tokens={tokens} label="Cc" value={form.cc} /> : null}
        {form.bcc ? <Line tokens={tokens} label="Bcc" value={form.bcc} /> : null}
        {form.subject ? <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm, fontWeight: '600' }}>{form.subject}</Text> : null}
        <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm, lineHeight: 19 }}>{form.body}</Text>
      </View>
    );
  }
  const put = (k: keyof EmailFields) => (v: string) => setForm({ ...form, [k]: v });
  return (
    <View style={{ gap: tokens.space.sm }}>
      <Input tokens={tokens} label="To" value={form.to} onChange={put('to')} />
      <Input tokens={tokens} label="Cc" value={form.cc} onChange={put('cc')} />
      <Input tokens={tokens} label="Bcc" value={form.bcc} onChange={put('bcc')} />
      <Input tokens={tokens} label="Subject" value={form.subject} onChange={put('subject')} editable={email.action !== 'reply'} />
      <Input tokens={tokens} label="Message" value={form.body} onChange={put('body')} multiline />
    </View>
  );
}

export function MobileEmailApproval({ body, botId, tokens }: { body: Approval; botId: string; tokens: MobileTokens }) {
  const email = body.review as EmailReview;
  const pending = body.status === 'pending';
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => emailFieldsOf(email));
  useEditPing(body.approvalId, editing, pending);
  const edits = emailEditsOf(email, form);
  return (
    <View style={box(tokens)}>
      <Kicker tokens={tokens}>Gmail · {email.action === 'reply' ? 'reply' : 'send'}</Kicker>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '600' }}>{body.title}</Text>
      <EmailView tokens={tokens} email={email} form={pending ? form : emailFieldsOf(email)} editing={editing && pending} setForm={setForm} />
      {pending ? (
        <>
          {!editing && email.editable ? <Button tokens={tokens} label="Edit" onPress={() => setEditing(true)} /> : null}
          <ApprovalButtons tokens={tokens} body={body} botId={botId} edits={edits} allowLabel={edits ? 'Send with changes' : 'Send'} />
        </>
      ) : <Outcome tokens={tokens} text={body.edited && body.status === 'allowed' ? 'Sent with your changes' : OUTCOME[body.status] ?? body.status} />}
    </View>
  );
}

export function MobileDraftEmail({ body, seq, botId, tokens }: { body: Draft; seq: number; botId: string; tokens: MobileTokens }) {
  const email = body.email!;
  const pending = body.status === 'pending';
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => emailFieldsOf(email));
  const act = useDraftAction(botId);
  useEffect(() => { if (!editing) setForm(emailFieldsOf(email)); }, [email, editing]);
  const run = (action: 'save' | 'send' | 'discard') => act.mutate({ seq, action, ...(action !== 'discard' ? { edits: emailEditsOf(email, form) } : {}) }, { onSuccess: () => setEditing(false) });
  return (
    <View style={box(tokens)}>
      <Kicker tokens={tokens}>Gmail draft</Kicker>
      <EmailView tokens={tokens} email={email} form={form} editing={editing && pending} setForm={setForm} />
      {pending ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: tokens.space.sm }}>
          <Button tokens={tokens} label="Discard" onPress={() => run('discard')} busy={act.isPending} />
          {editing ? <Button tokens={tokens} label="Save draft" onPress={() => run('save')} busy={act.isPending} /> : <Button tokens={tokens} label="Edit" onPress={() => setEditing(true)} />}
          <Button tokens={tokens} label="Send" kind="primary" onPress={() => run('send')} busy={act.isPending || !split(form.to).length} />
        </View>
      ) : <Outcome tokens={tokens} text={body.status === 'sent' ? `Sent to ${join(email.to)}` : 'Discarded'} />}
      {act.error ? <Text style={{ color: tokens.colors.destructive, fontSize: tokens.fontSizes.caption }}>{(act.error as Error).message}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------- calendar event

export function MobileEventApproval({ body, botId, tokens }: { body: Approval; botId: string; tokens: MobileTokens }) {
  const review = body.review as EventReview;
  const pending = body.status === 'pending';
  const deleting = review.action === 'delete';
  const canEdit = review.editable && (review.action === 'create' || review.action === 'update') && !!review.fields;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<EventFields | undefined>(review.fields);
  const [scope, setScope] = useState(review.recurring?.scope);
  const [notify, setNotify] = useState(review.notifyGuests);
  useEditPing(body.approvalId, editing, pending);

  const edits = eventEditsOf(review, f, scope, notify);
  const shown = deleting ? review.before : f ?? review.before;
  const before = review.action === 'update' ? review.before : undefined;
  const hasGuests = (shown?.attendees.length ?? 0) > 0;

  return (
    <View style={box(tokens)}>
      <Kicker tokens={tokens}>Google Calendar{review.recurring ? ' · repeating event' : ''}</Kicker>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '600' }}>{body.title}</Text>
      {editing && pending && f ? (
        <View style={{ gap: tokens.space.sm }}>
          <Input tokens={tokens} label="Title" value={f.summary} onChange={(v) => setF({ ...f, summary: v })} />
          <Input tokens={tokens} label={f.allDay ? 'Starts (YYYY-MM-DD)' : 'Starts (YYYY-MM-DDTHH:MM)'} value={f.start} onChange={(v) => setF({ ...f, start: v })} />
          <Input tokens={tokens} label={f.allDay ? 'Ends (YYYY-MM-DD)' : 'Ends (YYYY-MM-DDTHH:MM)'} value={f.end} onChange={(v) => setF({ ...f, end: v })} />
          <Input tokens={tokens} label="Location" value={f.location} onChange={(v) => setF({ ...f, location: v })} />
          <Input tokens={tokens} label="Guests" value={join(f.attendees)} onChange={(v) => setF({ ...f, attendees: split(v) })} />
          <Input tokens={tokens} label="Description" value={f.description} onChange={(v) => setF({ ...f, description: v })} multiline />
        </View>
      ) : shown ? (
        <View style={{ gap: tokens.space.xs }}>
          <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm, fontWeight: '600', textDecorationLine: deleting ? 'line-through' : 'none' }}>{shown.summary || 'Untitled event'}</Text>
          <Line tokens={tokens} label="When" value={`${whenOf(shown)}${shown.allDay ? '' : ` (${shown.timezone})`}`} was={before ? `${whenOf(before)}${before.allDay ? '' : ` (${before.timezone})`}` : undefined} />
          {shown.location || before?.location ? <Line tokens={tokens} label="Where" value={shown.location} was={before?.location} /> : null}
          {hasGuests || (before?.attendees.length ?? 0) > 0 ? <Line tokens={tokens} label="Guests" value={join(shown.attendees)} was={before ? join(before.attendees) : undefined} /> : null}
          {shown.meet ? <Line tokens={tokens} label="Meet" value="Google Meet link" /> : null}
        </View>
      ) : <Outcome tokens={tokens} text={body.detail || 'The event could not be read.'} />}
      {pending && review.recurring && review.editable ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: tokens.space.xs }}>
          {SCOPES.map((s) => (
            <Pressable key={s.value} accessibilityRole="radio" accessibilityState={{ checked: scope === s.value }} onPress={() => setScope(s.value)}
              style={{ paddingHorizontal: tokens.space.md, paddingVertical: tokens.space.xs, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.colors.border, backgroundColor: scope === s.value ? tokens.colors.accent : 'transparent' }}>
              <Text style={{ color: scope === s.value ? tokens.colors.onAccent : tokens.colors.fg, fontSize: tokens.fontSizes.caption }}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {pending && hasGuests && review.action !== 'remove_attendee' && review.action !== 'move' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
          <Switch value={notify} onValueChange={setNotify} accessibilityLabel="Email guests about this" />
          <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>Email guests about this</Text>
        </View>
      ) : null}
      {pending ? (
        <>
          {canEdit && !editing ? <Button tokens={tokens} label="Edit" onPress={() => setEditing(true)} /> : null}
          <ApprovalButtons tokens={tokens} body={body} botId={botId} edits={edits} allowLabel={deleting ? 'Delete' : edits ? 'Allow with changes' : 'Allow'} danger={deleting} />
        </>
      ) : <Outcome tokens={tokens} text={body.edited && body.status === 'allowed' ? 'Done, with your changes' : OUTCOME[body.status] ?? body.status} />}
    </View>
  );
}

// ---------------------------------------------------------------- sheets and docs

export function MobileSheetApproval({ body, botId, tokens }: { body: Approval; botId: string; tokens: MobileTokens }) {
  const review = body.review as SheetReview;
  const pending = body.status === 'pending';
  const [cells, setCells] = useState<Record<string, string>>({});
  const edits = sheetEditsOf(review, cells);
  useEditPing(body.approvalId, Object.keys(cells).length > 0, pending);
  return (
    <View style={box(tokens)}>
      <Kicker tokens={tokens}>Google Sheets{review.sheet ? ` · ${review.sheet}` : ''}</Kicker>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '600' }}>{body.title}</Text>
      {review.steps.map((s) => <Text key={s} style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>• {s}</Text>)}
      {review.changes.map((c) => (
        <View key={c.cell} style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
          <Text style={{ width: 84, color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{c.cell}</Text>
          <Text style={{ flex: 1, color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption }}>{c.before || 'empty'}</Text>
          {pending && review.editable ? (
            <TextInput accessibilityLabel={`New value for ${c.cell}`} value={cells[c.cell] ?? c.after} onChangeText={(v) => setCells((m) => ({ ...m, [c.cell]: v }))}
              style={{ flex: 1.3, color: tokens.colors.fg, fontSize: tokens.fontSizes.caption, borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.colors.border, borderRadius: tokens.radii.md, paddingHorizontal: tokens.space.sm, paddingVertical: 4 }} />
          ) : <Text style={{ flex: 1.3, color: tokens.colors.fg, fontSize: tokens.fontSizes.caption }}>{c.after || 'empty'}</Text>}
        </View>
      ))}
      {review.more > 0 ? <Outcome tokens={tokens} text={`and ${review.more} more cells`} /> : null}
      {pending ? <ApprovalButtons tokens={tokens} body={body} botId={botId} edits={edits} allowLabel={edits ? 'Allow with changes' : 'Allow'} /> : <Outcome tokens={tokens} text={OUTCOME[body.status] ?? body.status} />}
    </View>
  );
}

export function MobileDocApproval({ body, botId, tokens }: { body: Approval; botId: string; tokens: MobileTokens }) {
  const review = body.review as DocReview;
  const pending = body.status === 'pending';
  const [insert, setInsert] = useState(review.insert ?? '');
  const [replaceWith, setReplaceWith] = useState(review.replace?.with ?? '');
  const [markdown, setMarkdown] = useState(review.markdown ?? '');
  const [editing, setEditing] = useState(false);
  useEditPing(body.approvalId, editing, pending);
  const edits = docEditsOf(review, review.insert !== undefined ? insert : undefined, review.replace ? replaceWith : undefined, review.markdown !== undefined ? markdown : undefined);
  return (
    <View style={box(tokens)}>
      <Kicker tokens={tokens}>Google Docs{review.title ? ` · ${review.title}` : ''}</Kicker>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '600' }}>{body.title}</Text>
      {review.steps.map((s) => <Text key={s} style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>• {s}</Text>)}
      {review.replace ? <Line tokens={tokens} label="Find" value={review.replace.find} /> : null}
      {editing && pending ? (
        <>
          {review.insert !== undefined ? <Input tokens={tokens} label="Text to insert" value={insert} onChange={setInsert} multiline /> : null}
          {review.replace ? <Input tokens={tokens} label="Replace with" value={replaceWith} onChange={setReplaceWith} /> : null}
          {review.markdown !== undefined ? <Input tokens={tokens} label="New document text" value={markdown} onChange={setMarkdown} multiline /> : null}
        </>
      ) : (
        <>
          {review.insert !== undefined ? <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>{insert}</Text> : null}
          {review.replace ? <Line tokens={tokens} label="With" value={replaceWith} /> : null}
          {review.diff ? <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption, fontFamily: 'Menlo' }}>{review.diff.slice(0, 40).join('\n')}</Text> : null}
        </>
      )}
      {pending ? (
        <>
          {review.editable && !editing ? <Button tokens={tokens} label="Edit" onPress={() => setEditing(true)} /> : null}
          <ApprovalButtons tokens={tokens} body={body} botId={botId} edits={edits} allowLabel={edits ? 'Allow with changes' : 'Allow'} />
        </>
      ) : <Outcome tokens={tokens} text={OUTCOME[body.status] ?? body.status} />}
    </View>
  );
}

/** A sheet or doc a bot created or changed. */
export function MobileFileNotice({ file, tokens }: { file: WorkspaceFile; tokens: MobileTokens }) {
  return (
    <View style={box(tokens)}>
      <Kicker tokens={tokens}>{file.app === 'googlesheets' ? 'Google Sheet' : 'Google Doc'} · {file.action}</Kicker>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '600' }}>{file.title}</Text>
      {file.preview.map((row, i) => <Text key={i} numberOfLines={1} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption }}>{row.join(' · ')}</Text>)}
      <Button tokens={tokens} label="Open" onPress={() => void Linking.openURL(file.url)} />
    </View>
  );
}
