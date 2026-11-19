import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { EventFields, GoogleCalendarEvent, GoogleCalendarInfo } from '@orbit/contracts';
import { useMobileTokens } from '../lib/native';
import { useGoogleCalendarActions } from '../lib/queries';
import { fieldsOfGoogle, splitAddresses as split, whenOf } from '@orbit/domain';
import { PrimaryButton } from './ui';

/**
 * Creating or changing one of the person's own Google Calendar events from the phone. No bot is
 * involved. "Review" shows exactly what will happen in Google Calendar before anything is saved.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function GoogleEventSheet({ event, date, calendars, onClose }: { event?: GoogleCalendarEvent; date?: Date; calendars: GoogleCalendarInfo[]; onClose: () => void }) {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const { create, update } = useGoogleCalendarActions();
  const original = useMemo<EventFields>(() => {
    if (event) return fieldsOfGoogle(event);
    const start = date ?? new Date();
    return { summary: '', description: '', location: '', start: local(start), end: local(new Date(start.getTime() + 30 * 60_000)), allDay: false, timezone: zone(), attendees: [], meet: false };
  }, [event, date]);
  const [f, setF] = useState<EventFields>(original);
  const [calendarKey, setCalendarKey] = useState(calendars.find((c) => c.primary)?.key ?? calendars[0]?.key);
  const [scope, setScope] = useState<'this' | 'following' | 'all'>('this');
  const [notify, setNotify] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edits: Record<string, unknown> = {};
  for (const k of ['summary', 'description', 'location', 'start', 'end', 'timezone', 'meet'] as const) if (f[k] !== original[k]) edits[k] = f[k];
  if (f.attendees.join(',') !== original.attendees.join(',')) edits.attendees = f.attendees;
  const changes = Object.keys(edits);
  const ready = event ? changes.length > 0 : f.summary.trim().length > 0;
  const busy = create.isPending || update.isPending;
  const hasGuests = f.attendees.length > 0 || original.attendees.length > 0;

  const save = () => {
    setError(null);
    const onError = (e: Error) => { setError(e.message || 'Google Calendar did not accept it.'); setReviewing(false); };
    if (event) update.mutate({ key: event.key, edits: { ...edits, ...(event.recurring ? { scope } : {}), ...(hasGuests ? { notifyGuests: notify } : {}) } }, { onSuccess: onClose, onError });
    else create.mutate({ calendarKey, fields: { ...f, summary: f.summary.trim() }, notifyGuests: notify }, { onSuccess: onClose, onError });
  };

  const input = (label: string, value: string, onChange: (v: string) => void, multiline = false) => (
    <View style={{ gap: 2 }}>
      <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} multiline={multiline} autoCapitalize="none"
        style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.colors.border, borderRadius: tokens.radii.md, paddingHorizontal: tokens.space.md, paddingVertical: tokens.space.sm, minHeight: multiline ? 80 : undefined, textAlignVertical: multiline ? 'top' : 'center' }} />
    </View>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen">
      <View style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Dismiss" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={{ backgroundColor: tokens.colors.bg, borderTopLeftRadius: tokens.radii.card, borderTopRightRadius: tokens.radii.card, maxHeight: 660, paddingBottom: Math.max(insets.bottom, tokens.space.lg) }}>
            <View style={{ paddingHorizontal: tokens.space.xl, paddingTop: tokens.space.lg, paddingBottom: tokens.space.sm }}>
              <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '600' }}>{event ? 'Change Google event' : 'New Google event'}</Text>
              <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{event?.calendarName ?? calendars.find((c) => c.key === calendarKey)?.name ?? 'Google Calendar'} · no bot involved</Text>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: tokens.space.xl, gap: tokens.space.md, paddingBottom: tokens.space.lg }}>
              {reviewing ? (
                <View style={{ gap: tokens.space.xs }}>
                  {event
                    ? changes.map((k) => <Text key={k} style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>• {k === 'start' || k === 'end' ? `When: ${whenOf(f)}` : k === 'attendees' ? `Guests: ${f.attendees.join(', ') || 'none'}` : `${k}: ${String(f[k as keyof EventFields])}`}</Text>)
                    : <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>Create “{f.summary.trim()}” · {whenOf(f)}{f.location ? ` · ${f.location}` : ''}</Text>}
                </View>
              ) : (
                <>
                  {input('Title', f.summary, (v) => setF({ ...f, summary: v }))}
                  {input('Starts (YYYY-MM-DDTHH:MM)', f.start, (v) => setF({ ...f, start: v }))}
                  {input('Ends (YYYY-MM-DDTHH:MM)', f.end, (v) => setF({ ...f, end: v }))}
                  {input('Location', f.location, (v) => setF({ ...f, location: v }))}
                  {input('Guests', f.attendees.join(', '), (v) => setF({ ...f, attendees: split(v) }))}
                  {input('Description', f.description, (v) => setF({ ...f, description: v }), true)}
                </>
              )}
              {event?.recurring ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: tokens.space.xs }}>
                  {(['this', 'following', 'all'] as const).map((s) => (
                    <Pressable key={s} accessibilityRole="radio" accessibilityState={{ checked: scope === s }} onPress={() => setScope(s)}
                      style={{ paddingHorizontal: tokens.space.md, paddingVertical: tokens.space.xs, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.colors.border, backgroundColor: scope === s ? tokens.colors.accent : 'transparent' }}>
                      <Text style={{ color: scope === s ? tokens.colors.onAccent : tokens.colors.fg, fontSize: tokens.fontSizes.caption }}>{s === 'this' ? 'This event' : s === 'following' ? 'This and following' : 'All events'}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {hasGuests ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
                  <Switch value={notify} onValueChange={setNotify} accessibilityLabel="Email guests about this" />
                  <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>Email guests about this</Text>
                </View>
              ) : null}
              {error ? <Text style={{ color: tokens.colors.destructive, fontSize: tokens.fontSizes.sm }}>{error}</Text> : null}
              <View style={{ flexDirection: 'row', gap: tokens.space.sm }}>
                <Pressable onPress={reviewing ? () => setReviewing(false) : onClose} style={{ flex: 1, alignItems: 'center', padding: tokens.space.md, borderRadius: tokens.radii.md, backgroundColor: tokens.colors.bgSubtle }}>
                  <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm, fontWeight: '600' }}>{reviewing ? 'Back' : 'Cancel'}</Text>
                </Pressable>
                <View style={{ flex: 1 }}>
                  <PrimaryButton label={reviewing ? (busy ? 'Saving…' : event ? 'Save change' : 'Create event') : 'Review'} disabled={!ready || busy} onPress={reviewing ? save : () => setReviewing(true)} />
                </View>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
