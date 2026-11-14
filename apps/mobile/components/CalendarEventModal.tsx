import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Bot, CreateRoutineRequest } from '@orbit/contracts';
import { useMobileTokens, type MobileTokens } from '../lib/native';
import { useCreateRoutine } from '../lib/queries';
import { Chip, PrimaryButton, Segmented } from './ui';

/**
 * Create one calendar event: a one-time routine at a date and time, or a recurring cron routine.
 *
 * The web modal uses a datetime-local input and a cron field. A phone has neither, so a one-time
 * event is a day chip plus a half-hour stepper — both always produce a valid instant — and a
 * recurring one is a preset (with Custom for a hand-written cron). The request body is the same
 * CreateRoutineRequest the web app posts, including the device's timezone.
 */

type EventType = 'one_time' | 'recurring';

const PRESETS = [
  { value: 'daily', label: 'Daily 9am', cron: '0 9 * * *' },
  { value: 'weekly', label: 'Weekly Mon 9am', cron: '0 9 * * 1' },
  { value: 'weekdays', label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { value: 'custom', label: 'Custom', cron: '' },
] as const;

type PresetValue = (typeof PRESETS)[number]['value'];

/** Cron needs five (or six) whitespace-separated fields. */
const looksLikeCron = (value: string) => /^\s*\S+(\s+\S+){4,5}\s*$/.test(value);

const HALF_HOUR = 30 * 60_000;
const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** "Today", "Tomorrow", then "Thu 20" — a day chip's label. */
function dayLabel(date: Date, today: Date): string {
  const days = Math.round((startOfDay(date).getTime() - startOfDay(today).getTime()) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

const timeLabel = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export type CalendarEventModalProps = {
  /** The day the person tapped; the modal opens at 9am on it. */
  initialDate: Date;
  bots: Bot[];
  onClose: () => void;
  onSaved: () => void;
};

export function CalendarEventModal({ initialDate, bots, onClose, onSaved }: CalendarEventModalProps) {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const create = useCreateRoutine();

  // Rooms are group chats, not agents: they cannot run a routine.
  const agents = useMemo(() => bots.filter((b) => b.kind !== 'room'), [bots]);
  const preferredBot = agents.find((b) => b.isPrimary) ?? agents[0];

  const [title, setTitle] = useState('');
  const [botId, setBotId] = useState(preferredBot?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [eventType, setEventType] = useState<EventType>('one_time');
  const [when, setWhen] = useState<Date>(() => {
    const day = startOfDay(initialDate);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0, 0, 0);
  });
  const [preset, setPreset] = useState<PresetValue>('daily');
  const [cron, setCron] = useState<string>(PRESETS[0].cron);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Fourteen days from the tapped one — enough to place an event without a date picker. */
  const days = useMemo(() => {
    const today = new Date();
    const first = startOfDay(initialDate);
    return Array.from({ length: 14 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  }, [initialDate]);

  const shiftTime = (delta: number) => setWhen((current) => new Date(current.getTime() + delta));

  const pickPreset = (value: PresetValue) => {
    setPreset(value);
    const found = PRESETS.find((p) => p.value === value);
    if (found && value !== 'custom') setCron(found.cron);
    setError(null);
  };

  const save = async () => {
    if (busy) return;
    setError(null);

    const trimmedTitle = title.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedTitle) return setError('Give the event a title.');
    if (!botId) return setError('Pick the bot that should run this.');
    if (!trimmedPrompt) return setError('Describe what the bot should do.');
    if (eventType === 'recurring' && !looksLikeCron(cron)) {
      return setError('Enter a cron expression, e.g. 0 9 * * 1.');
    }

    const request: CreateRoutineRequest = {
      botId,
      title: trimmedTitle,
      prompt: trimmedPrompt,
      eventType,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    if (eventType === 'one_time') request.eventDate = when.toISOString();
    else request.schedule = cron.trim();

    setBusy(true);
    try {
      await create.mutateAsync(request);
      onSaved();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not create the event.');
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen">
      <View style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Dismiss" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View
            style={{
              backgroundColor: tokens.colors.bg,
              borderTopLeftRadius: tokens.radii.card,
              borderTopRightRadius: tokens.radii.card,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderColor: tokens.colors.border,
              maxHeight: 640,
              paddingBottom: Math.max(insets.bottom, tokens.space.lg),
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: tokens.space.xl,
                paddingTop: tokens.space.lg,
                paddingBottom: tokens.space.sm,
              }}
            >
              <Text style={{ flex: 1, color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '600' }}>
                New event
              </Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
                <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.lg }}>✕</Text>
              </Pressable>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.lg, gap: tokens.space.lg }}
            >
              <Field label="Title" tokens={tokens}>
                <TextInput
                  value={title}
                  onChangeText={(text) => {
                    setTitle(text);
                    setError(null);
                  }}
                  placeholder="Quarterly report"
                  placeholderTextColor={tokens.colors.fgTertiary}
                  maxLength={120}
                  autoFocus
                  style={inputStyle(tokens)}
                />
              </Field>

              <Field label="Assigned bot" tokens={tokens}>
                {agents.length === 0 ? (
                  <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>
                    No bots on this server yet.
                  </Text>
                ) : (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: tokens.space.sm }}>
                    {agents.map((bot) => (
                      <Chip
                        key={bot.id}
                        label={bot.name}
                        active={bot.id === botId}
                        onPress={() => {
                          setBotId(bot.id);
                          setError(null);
                        }}
                      />
                    ))}
                  </ScrollView>
                )}
              </Field>

              <Field label="Task" hint="What the bot should do when this event runs." tokens={tokens}>
                <TextInput
                  value={prompt}
                  onChangeText={(text) => {
                    setPrompt(text);
                    setError(null);
                  }}
                  placeholder="Draft this week's status update and post it to the team channel."
                  placeholderTextColor={tokens.colors.fgTertiary}
                  multiline
                  style={[inputStyle(tokens), { minHeight: 84, textAlignVertical: 'top', paddingTop: tokens.space.md }]}
                />
              </Field>

              <Field label="Event type" tokens={tokens}>
                <Segmented
                  value={eventType}
                  options={[
                    { value: 'one_time', label: 'One-time' },
                    { value: 'recurring', label: 'Recurring' },
                  ]}
                  onChange={(value) => {
                    setEventType(value);
                    setError(null);
                  }}
                />
              </Field>

              {eventType === 'one_time' ? (
                <>
                  <Field label="Day" tokens={tokens}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: tokens.space.sm }}>
                      {days.map((day) => {
                        const start = day.getTime();
                        const end = start + DAY;
                        const active = when.getTime() >= start && when.getTime() < end;
                        return (
                          <Chip
                            key={day.toISOString()}
                            label={dayLabel(day, new Date())}
                            active={active}
                            onPress={() =>
                              setWhen((current) => {
                                const next = new Date(day.getFullYear(), day.getMonth(), day.getDate());
                                next.setHours(current.getHours(), current.getMinutes(), 0, 0);
                                return next;
                              })
                            }
                          />
                        );
                      })}
                    </ScrollView>
                  </Field>

                  <Field label="Time" tokens={tokens}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
                      <Stepper tokens={tokens} label="−" onPress={() => shiftTime(-HALF_HOUR)} />
                      <Text
                        style={{
                          minWidth: 96,
                          textAlign: 'center',
                          color: tokens.colors.fg,
                          fontSize: tokens.fontSizes.message,
                          fontFamily: tokens.mono,
                        }}
                      >
                        {timeLabel(when)}
                      </Text>
                      <Stepper tokens={tokens} label="+" onPress={() => shiftTime(HALF_HOUR)} />
                      <Text style={{ flex: 1, textAlign: 'right', color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>
                        {when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                      </Text>
                    </View>
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Repeats" tokens={tokens}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: tokens.space.sm }}>
                      {PRESETS.map((option) => (
                        <Chip
                          key={option.value}
                          label={option.label}
                          active={preset === option.value}
                          onPress={() => pickPreset(option.value)}
                        />
                      ))}
                    </View>
                  </Field>

                  <Field label="Cron" hint="minute hour day-of-month month day-of-week" tokens={tokens}>
                    <TextInput
                      value={cron}
                      onChangeText={(text) => {
                        setCron(text);
                        setPreset('custom');
                        setError(null);
                      }}
                      placeholder="0 9 * * 1"
                      placeholderTextColor={tokens.colors.fgTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={[inputStyle(tokens), { fontFamily: tokens.mono }]}
                    />
                  </Field>
                </>
              )}

              {error ? (
                <Text style={{ color: tokens.colors.destructive, fontSize: tokens.fontSizes.sm }} accessibilityRole="alert">
                  {error}
                </Text>
              ) : null}
            </ScrollView>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: tokens.space.md,
                paddingHorizontal: tokens.space.xl,
                paddingTop: tokens.space.md,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: tokens.colors.border,
              }}
            >
              <Pressable onPress={onClose} hitSlop={6} style={{ paddingVertical: tokens.space.sm }}>
                <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>Cancel</Text>
              </Pressable>
              <View style={{ flex: 1 }} />
              <PrimaryButton
                label="Create event"
                tokens={tokens}
                busy={busy || create.isPending}
                disabled={agents.length === 0}
                onPress={() => void save()}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function inputStyle(tokens: MobileTokens) {
  return {
    backgroundColor: tokens.colors.bgSubtle,
    color: tokens.colors.fg,
    borderRadius: tokens.radii.md,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
    fontSize: tokens.fontSizes.message,
  } as const;
}

function Field({
  label,
  hint,
  tokens,
  children,
}: {
  label: string;
  hint?: string;
  tokens: MobileTokens;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: tokens.space.xs }}>
      <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {label}
      </Text>
      {children}
      {hint ? <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{hint}</Text> : null}
    </View>
  );
}

function Stepper({ tokens, label, onPress }: { tokens: MobileTokens; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={6}
      style={({ pressed }) => ({
        width: 38,
        height: 38,
        borderRadius: tokens.radii.full,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: tokens.colors.border,
        backgroundColor: pressed ? tokens.colors.bgHover : tokens.colors.bgSubtle,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg }}>{label}</Text>
    </Pressable>
  );
}
