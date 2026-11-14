import { useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Calendar, type DateData } from 'react-native-calendars';
import { router } from 'expo-router';
import type { CalendarEvent } from '@orbit/contracts';
import { botColor } from '../../components/bot-avatar';
import { CalendarEventModal } from '../../components/CalendarEventModal';
import { Card, PrimaryButton, ScreenHeader, Tag } from '../../components/ui';
import { dayFromKey, dayKey } from '../../lib/format';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { useBotsQuery, useCalendarQuery } from '../../lib/queries';
import { useOrbitStore } from '../../lib/store';

/**
 * The calendar: a month grid, the selected day's events underneath, and a way to create one.
 *
 * Every day cell is a tap that selects that day; the modal is opened from the header ("New event")
 * or from the selected day's section, so tapping around the grid never pops a form by accident.
 * The grid is always six weeks from the Sunday before the 1st, and the query asks for exactly that
 * window, so a day cannot render without its events.
 */

/** Six weeks starting the Sunday before the month's first day — the shape of the month grid. */
function gridRange(cursor: Date): { start: Date; end: Date } {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 42);
  return { start, end };
}

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

  const range = useMemo(() => gridRange(cursor), [cursor]);
  const fromIso = range.start.toISOString();
  const toIso = range.end.toISOString();
  const { data, isLoading, isError, error, refetch, isRefetching } = useCalendarQuery(fromIso, toIso);
  // The calendar needs the roster for the bot picker and the avatar colours, and it may well be the
  // first screen opened after launch.
  useBotsQuery();

  const events = useMemo(
    () => [...(data ?? [])].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title)),
    [data],
  );

  /** Events by local day, each list already in start order. */
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const key = dayKey(new Date(event.start));
      const list = map.get(key);
      if (list) list.push(event);
      else map.set(key, [event]);
    }
    return map;
  }, [events]);

  const colorFor = useMemo(() => {
    const byId = new Map(bots.map((b) => [b.id, b.avatarColor]));
    return (botId: string) => botColor(byId.get(botId) ?? 'gray');
  }, [bots]);

  /** Dots per day (up to four), plus the selected day's fill. */
  const markedDates = useMemo(() => {
    const marks: Record<string, { dots?: { color: string }[]; selected?: boolean; selectedColor?: string }> = {};
    for (const [key, list] of byDay) {
      marks[key] = { dots: list.slice(0, 4).map((event) => ({ color: colorFor(event.botId) })) };
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
    setCreating(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0, 0, 0));
  };

  const showEvent = (event: CalendarEvent) => {
    const when = new Date(event.start);
    const lines = [
      event.eventType === 'one_time'
        ? when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : `Repeats · ${event.recurrenceRule ?? 'scheduled'}`,
      `Runs on ${event.botName}`,
    ];
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
        keyExtractor={(event) => `${event.routineId}-${event.start}`}
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
        renderItem={({ item }) => (
          <Pressable
            onPress={() => showEvent(item)}
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
            <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: colorFor(item.botId) }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                style={{
                  color: tokens.colors.fg,
                  fontSize: tokens.fontSizes.message,
                  fontWeight: '500',
                  textDecorationLine: item.completedAt ? 'line-through' : 'none',
                }}
                numberOfLines={2}
              >
                {item.title}
              </Text>
              <Text numberOfLines={1} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption }}>
                {item.eventType === 'one_time' ? timeLabel(item.start) : `${timeLabel(item.start)} · repeats`} · {item.botName}
              </Text>
            </View>
            <Tag label={item.eventType === 'one_time' ? 'Once' : 'Repeats'} tone={item.completedAt ? 'success' : 'muted'} />
          </Pressable>
        )}
      />

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
