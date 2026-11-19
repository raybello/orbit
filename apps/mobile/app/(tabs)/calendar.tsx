import { useMemo, useState } from 'react';
import { Alert, FlatList, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Calendar, type DateData } from 'react-native-calendars';
import { router } from 'expo-router';
import type { CalendarEvent, DuplicateDefaults, GoogleCalendarEvent } from '@orbit/contracts';
import { botColor } from '../../components/bot-avatar';
import { CalendarEventModal } from '../../components/CalendarEventModal';
import { Card, Chip, PrimaryButton, ScreenHeader, Tag } from '../../components/ui';
import { GoogleEventSheet } from '../../components/GoogleEventSheet';
import { dayFromKey, dayKey } from '../../lib/format';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { fetchDuplicateDefaults, useBotsQuery, useCalendarQuery, useGoogleCalendarActions, useGoogleCalendarsQuery } from '../../lib/queries';
import { useOrbitStore } from '../../lib/store';
import { daysOf, rangeFor } from '@orbit/domain';

/**
 * The calendar: a month grid, the selected day's events underneath, and a way to create one.
 *
 * Every day cell is a tap that selects that day; the modal is opened from the header ("New event")
 * or from the selected day's section, so tapping around the grid never pops a form by accident.
 * The grid is always six weeks from the Sunday before the 1st, and the query asks for exactly that
 * window, so a day cannot render without its events.
 */

/** One row of the day list: a Bot's Orbit event, or one of the person's Google events. */
type Item = { kind: 'orbit'; ev: CalendarEvent; start: string } | { kind: 'google'; ev: GoogleCalendarEvent; start: string };
const GOOGLE = 'google';
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Thu, Nov 20" — the heading over the selected day's list. */
const longDay = (key: string) =>
  dayFromKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

export default function CalendarScreen() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const bots = useOrbitStore((s) => s.bots);

  const [cursor, setCursor] = useState<Date>(() => new Date());
  const [selected, setSelected] = useState<string>(() => dayKey(new Date()));
  const [creating, setCreating] = useState<Date | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [showCalendars, setShowCalendars] = useState(false);
  const [googleSheet, setGoogleSheet] = useState<{ event?: GoogleCalendarEvent; date?: Date } | null>(null);
  const [duplicating, setDuplicating] = useState<{ key: string; defaults: DuplicateDefaults } | null>(null);
  const actions = useGoogleCalendarActions();

  const range = useMemo(() => rangeFor('month', cursor), [cursor]);
  const fromIso = range.start.toISOString();
  const toIso = range.end.toISOString();
  const { data, isLoading, isError, error, refetch, isRefetching } = useCalendarQuery(fromIso, toIso);
  // The calendar needs the roster for the bot picker and the avatar colours, and it may well be the
  // first screen opened after launch.
  useBotsQuery();

  const events = useMemo(
    () => [...(data?.events ?? [])].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title)),
    [data],
  );
  const google = data?.google ?? [];
  const googleState = data?.googleState;
  const connected = Boolean(googleState?.connected && googleState.available);
  const { data: calendarList } = useGoogleCalendarsQuery(connected);
  const calendars = calendarList?.calendars ?? [];
  const toggle = (id: string) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /** Events by local day, each list already in start order. */
  const byDay = useMemo(() => {
    const map = new Map<string, Item[]>();
    const add = (key: string, item: Item) => { const list = map.get(key); if (list) list.push(item); else map.set(key, [item]); };
    for (const ev of events) if (!hidden.has(ev.botId)) add(dayKey(new Date(ev.start)), { kind: 'orbit', ev, start: ev.start });
    if (!hidden.has(GOOGLE)) for (const ev of google) for (const key of daysOf(ev.start, ev.end, ev.allDay, dayKey)) add(key, { kind: 'google', ev, start: ev.allDay ? `${key}T00:00:00` : ev.start });
    for (const list of map.values()) list.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return map;
  }, [events, google, hidden]);

  const colorFor = useMemo(() => {
    const byId = new Map(bots.map((b) => [b.id, b.avatarColor]));
    return (botId: string) => botColor(byId.get(botId) ?? 'gray');
  }, [bots]);

  /** Dots per day (up to four), plus the selected day's fill. */
  const markedDates = useMemo(() => {
    const marks: Record<string, { dots?: { color: string }[]; selected?: boolean; selectedColor?: string }> = {};
    for (const [key, list] of byDay) {
      marks[key] = { dots: list.slice(0, 4).map((it) => ({ color: it.kind === 'orbit' ? colorFor(it.ev.botId) : it.ev.color ?? tokens.colors.accent })) };
    }
    const day = marks[selected] ?? {};
    marks[selected] = { ...day, selected: true, selectedColor: tokens.colors.accent };
    return marks;
  }, [byDay, colorFor, selected, tokens.colors.accent]);

  const selectedEvents = byDay.get(selected) ?? [];
  const todayKey = dayKey(new Date());
  const canCreate = bots.some((b) => b.kind !== 'room');

  const openCreate = (key: string) => {
    const day = dayFromKey(key);
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0, 0, 0);
    // With Google Calendar connected, a new event can be either kind.
    if (!connected) return setCreating(at);
    Alert.alert('New event', undefined, [
      { text: 'Orbit event (a Bot does something)', onPress: () => setCreating(at) },
      { text: 'Google Calendar event', onPress: () => setGoogleSheet({ date: at }) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const deleteGoogle = (ev: GoogleCalendarEvent) => {
    const remove = (scope: 'this' | 'following' | 'all' | undefined, notify: boolean) => actions.remove.mutate({ key: ev.key, ...(scope ? { scope } : {}), ...(ev.attendees.length ? { notify } : {}) }, { onError: (e) => Alert.alert('Not deleted', (e as Error).message) });
    // With guests, ask whether Google emails them the cancellation (the default, as on the web).
    const go = (scope?: 'this' | 'following' | 'all') => {
      if (!ev.attendees.length) return remove(scope, false);
      Alert.alert('Email the guests?', 'Google can tell the guests that it is cancelled.', [
        { text: 'Delete and email guests', style: 'destructive', onPress: () => remove(scope, true) },
        { text: 'Delete without emailing', style: 'destructive', onPress: () => remove(scope, false) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    };
    Alert.alert(`Delete “${ev.title || 'Untitled'}”?`, ev.recurring ? 'This event repeats.' : 'It is removed from your Google Calendar.', ev.recurring ? [
      { text: 'This event', style: 'destructive', onPress: () => go('this') },
      { text: 'This and following', style: 'destructive', onPress: () => go('following') },
      { text: 'All events', style: 'destructive', onPress: () => go('all') },
      { text: 'Cancel', style: 'cancel' },
    ] : [{ text: 'Delete', style: 'destructive', onPress: () => go() }, { text: 'Cancel', style: 'cancel' }]);
  };

  const showGoogle = (ev: GoogleCalendarEvent) => {
    const when = ev.allDay ? 'All day' : `${timeLabel(ev.start)} – ${timeLabel(ev.end)}`;
    const lines = [`${ev.calendarName} · Google Calendar${ev.recurring ? ' · repeats' : ''}`, when, ev.location, ev.attendees.length ? `With ${ev.attendees.join(', ')}` : ''].filter(Boolean);
    Alert.alert(ev.title || 'Untitled', lines.join('\n'), [
      { text: 'Duplicate as Orbit event', onPress: () => void fetchDuplicateDefaults(ev.key).then((defaults) => setDuplicating({ key: ev.key, defaults })).catch((e) => Alert.alert('Not available', (e as Error).message)) },
      { text: 'Edit', onPress: () => setGoogleSheet({ event: ev }) },
      { text: 'Delete', style: 'destructive', onPress: () => deleteGoogle(ev) },
      ...(ev.htmlLink ? [{ text: 'Open in Google', onPress: () => void Linking.openURL(ev.htmlLink) }] : []),
      { text: 'Close', style: 'cancel' as const },
    ]);
  };

  const showEvent = (event: CalendarEvent) => {
    const when = new Date(event.start);
    const lines = [
      event.eventType === 'one_time'
        ? when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : `Repeats · ${event.recurrenceRule ?? 'scheduled'}`,
      `Runs on ${event.botName}`,
    ];
    if (event.parentTitle) lines.push(`Made from your Google event “${event.parentTitle}”`);
    if (event.completedAt) lines.push('Completed');
    Alert.alert(event.title, lines.join('\n'), [
      { text: 'Open chat', onPress: () => router.push(`/thread/${event.botId}`) },
      { text: 'Close', style: 'cancel' },
    ]);
  };

  const header = (
    <>
      <ScreenHeader
        title="Calendar"
        subtitle={cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        right={
          <PrimaryButton label="New event" disabled={!canCreate} onPress={() => openCreate(selected)} />
        }
      />

      <View style={{ paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.sm }}>
        <Card style={{ overflow: 'hidden', paddingVertical: tokens.space.sm }}>
          <Calendar
            current={dayKey(cursor)}
            onMonthChange={(day: DateData) => setCursor(dayFromKey(day.dateString))}
            onDayPress={(day: DateData) => setSelected(day.dateString)}
            markedDates={markedDates}
            markingType="dot"
            firstDay={0}
            enableSwipeMonths
            theme={{
              calendarBackground: tokens.colors.bgElevated,
              dayTextColor: tokens.colors.fg,
              textDisabledColor: tokens.colors.fgTertiary,
              monthTextColor: tokens.colors.fg,
              textSectionTitleColor: tokens.colors.fgTertiary,
              todayTextColor: tokens.colors.accent,
              selectedDayBackgroundColor: tokens.colors.accent,
              selectedDayTextColor: tokens.colors.onAccent,
              arrowColor: tokens.colors.fgSecondary,
              textDayFontSize: 14,
              textMonthFontSize: 16,
              textMonthFontWeight: '600',
              textDayHeaderFontSize: 11,
              dotColor: tokens.colors.accent,
              selectedDotColor: tokens.colors.onAccent,
            }}
          />
        </Card>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: tokens.space.sm, paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.sm }}>
        {googleState?.connected ? <Chip label="Google Calendar" active={!hidden.has(GOOGLE)} onPress={() => toggle(GOOGLE)} /> : null}
        {bots.filter((b) => b.kind !== 'room').map((b) => <Chip key={b.id} label={b.name} active={!hidden.has(b.id)} onPress={() => toggle(b.id)} />)}
        {connected ? <Chip label="Calendars…" active={showCalendars} onPress={() => setShowCalendars((v) => !v)} /> : null}
      </ScrollView>
      {googleState && !googleState.available && googleState.reason ? (
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption, paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.sm }}>{googleState.reason}</Text>
      ) : null}
      {showCalendars ? (
        <View style={{ paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.sm, gap: tokens.space.xs }}>
          {calendars.map((c) => (
            <View key={c.key} style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
              <Switch value={c.enabled} onValueChange={(enabled) => actions.toggle.mutate({ key: c.key, enabled })} accessibilityLabel={`Show ${c.name}`} />
              <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>{c.name}{c.primary ? ' (main)' : ''}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {isLoading ? (
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption, paddingHorizontal: tokens.space.xl }}>
          Loading events…
        </Text>
      ) : null}

      {isError ? (
        <Pressable
          onPress={() => void refetch()}
          accessibilityRole="button"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: tokens.space.sm,
            marginHorizontal: tokens.space.xl,
            padding: tokens.space.md,
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.destructiveBg,
          }}
        >
          <Text numberOfLines={2} style={{ flex: 1, color: tokens.colors.destructive, fontSize: tokens.fontSizes.sm }}>
            {error instanceof Error ? error.message : 'Could not load the calendar.'}
          </Text>
          <Text style={{ color: tokens.colors.destructive, fontSize: tokens.fontSizes.sm, fontWeight: '600' }}>Retry</Text>
        </Pressable>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: tokens.space.sm,
          paddingHorizontal: tokens.space.xl,
          paddingTop: tokens.space.md,
          paddingBottom: tokens.space.sm,
        }}
      >
        <Text style={{ flex: 1, color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '600' }}>
          {longDay(selected)}
        </Text>
        {selected !== todayKey ? (
          <Pressable onPress={() => setSelected(todayKey)} hitSlop={8}>
            <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>Today</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => openCreate(selected)} hitSlop={8} disabled={!canCreate}>
          <Text style={{ color: canCreate ? tokens.colors.accent : tokens.colors.fgTertiary, fontSize: tokens.fontSizes.sm }}>
            + Add
          </Text>
        </Pressable>
      </View>
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
      <FlatList
        data={selectedEvents}
        keyExtractor={(it) => (it.kind === 'orbit' ? `${it.ev.routineId}-${it.ev.start}` : `g-${it.ev.key}`)}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: insets.bottom + tokens.space.xxl }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={tokens.colors.fgSecondary} />
        }
        ListEmptyComponent={
          <View style={{ paddingHorizontal: tokens.space.xl, paddingTop: tokens.space.md }}>
            <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>
              {isLoading ? '' : isError ? '' : 'Nothing on this day.'}
            </Text>
            {!isLoading && !isError ? (
              <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption, marginTop: tokens.space.xs }}>
                New event schedules a prompt for a bot at a time you pick.
              </Text>
            ) : null}
          </View>
        }
        renderItem={({ item: it }) => it.kind === 'google' ? (
          <Pressable
            onPress={() => showGoogle(it.ev)}
            accessibilityRole="button"
            accessibilityLabel={`${it.ev.title || 'Untitled'}, Google Calendar`}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'flex-start', gap: tokens.space.md, marginHorizontal: tokens.space.xl, marginBottom: tokens.space.sm,
              padding: tokens.space.md, borderRadius: tokens.radii.md, borderWidth: 1.5, borderColor: it.ev.color ?? tokens.colors.accent,
              backgroundColor: pressed ? tokens.colors.bgHover : tokens.colors.bg,
            })}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '500' }} numberOfLines={2}>{it.ev.title || 'Untitled'}</Text>
              <Text numberOfLines={1} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption }}>
                {it.ev.allDay ? 'All day' : `${timeLabel(it.ev.start)} – ${timeLabel(it.ev.end)}`} · {it.ev.calendarName}
              </Text>
            </View>
            <Tag label="Google" />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => showEvent(it.ev)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: tokens.space.md,
              marginHorizontal: tokens.space.xl,
              marginBottom: tokens.space.sm,
              padding: tokens.space.md,
              borderRadius: tokens.radii.md,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: tokens.colors.border,
              backgroundColor: pressed ? tokens.colors.bgHover : tokens.colors.bgElevated,
            })}
          >
            <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: colorFor(it.ev.botId) }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                style={{
                  color: tokens.colors.fg,
                  fontSize: tokens.fontSizes.message,
                  fontWeight: '500',
                  textDecorationLine: it.ev.completedAt ? 'line-through' : 'none',
                }}
                numberOfLines={2}
              >
                {it.ev.title}
              </Text>
              <Text numberOfLines={1} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption }}>
                {it.ev.eventType === 'one_time' ? timeLabel(it.ev.start) : `${timeLabel(it.ev.start)} · repeats`} · {it.ev.botName}{it.ev.paused ? (it.ev.parentTitle ? ' · paused, its Google event was cancelled' : ' · paused') : ''}
              </Text>
            </View>
            <Tag label={it.ev.paused ? 'Paused' : it.ev.parentTitle ? '↗ Linked' : it.ev.eventType === 'one_time' ? 'Once' : 'Repeats'} tone={it.ev.paused ? 'warn' : it.ev.completedAt ? 'success' : 'muted'} />
          </Pressable>
        )}
      />

      {googleSheet ? <GoogleEventSheet event={googleSheet.event} date={googleSheet.date} calendars={calendars.filter((c) => c.enabled)} onClose={() => { setGoogleSheet(null); void refetch(); }} /> : null}

      {duplicating ? (
        <CalendarEventModal
          initialDate={new Date(duplicating.defaults.start)}
          bots={bots}
          duplicate={duplicating}
          onClose={() => setDuplicating(null)}
          onSaved={() => { setDuplicating(null); void refetch(); }}
        />
      ) : null}

      {creating ? (
        <CalendarEventModal
          initialDate={creating}
          bots={bots}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setSelected(dayKey(creating));
            setCreating(null);
            void refetch();
          }}
        />
      ) : null}
    </View>
  );
}
