import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import type { Bot, CardBody, Row, ToolCallBody } from '@orbit/contracts';
import { BotAvatarFor } from '../../components/bot-avatar';
import { MessageBubble } from '../../components/message-bubble';
import { durationLabel } from '../../lib/format';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { useApproval, useInterrupt, useMarkRead, useQuestionCard, useRowsQuery, useSendMessage } from '../../lib/queries';
import { useOrbitStore } from '../../lib/store';

/** One transcript item: a single row, or a run of tool calls folded into one chip. */
type Block =
  | { kind: 'row'; key: string; row: Row; /** Not the first message of a run from this sender. */ follow?: boolean }
  | { kind: 'tools'; key: string; rows: Row[] };

/** Messages from one sender closer together than this render as a single run. */
const RUN_GAP = 5 * 60 * 1000;

/** Who sent a message row, or null if the row is not a message. */
function senderOf(row: Row): string | null {
  const body = row.body;
  if (body.type !== 'message') return null;
  return body.from ? `${body.from.kind}:${body.from.id}` : body.role;
}

function toBlocks(rows: Row[]): Block[] {
  const blocks: Block[] = [];
  for (const row of rows) {
    if (row.kind === 'tool-call') {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'tools') last.rows.push(row);
      else blocks.push({ kind: 'tools', key: `tools-${row.seq}`, rows: [row] });
    } else {
      // `rows` is chronological (the list is inverted), so the block before this one is the row a
      // reader sees directly above it. Same sender, close in time: this row continues that run.
      const last = blocks[blocks.length - 1];
      const previous = last && last.kind === 'row' ? last.row : null;
      const sender = senderOf(row);
      const follow =
        previous !== null &&
        sender !== null &&
        sender === senderOf(previous) &&
        Math.abs(row.createdAt - previous.createdAt) < RUN_GAP;
      blocks.push({ kind: 'row', key: `${row.kind}-${row.seq}`, row, follow });
    }
  }
  return blocks;
}

export default function ThreadScreen() {
  const params = useLocalSearchParams<{ botId: string }>();
  const botId = Array.isArray(params.botId) ? params.botId[0] : (params.botId ?? '');
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();

  const bot = useOrbitStore((s) => s.bots.find((b) => b.id === botId));
  const rows = useOrbitStore((s) => s.threads[botId]);
  const live = useOrbitStore((s) => s.live[botId]);

  const [draft, setDraft] = useState('');
  const inputRef = useRef<TextInput>(null);

  const rowsQuery = useRowsQuery(botId);
  const send = useSendMessage(botId);
  const markRead = useMarkRead();
  const interrupt = useInterrupt(botId);

  // Opening the thread is what counts as reading it.
  useEffect(() => {
    if (botId) markRead.mutate(botId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  const blocks = useMemo(() => toBlocks(rows ?? []), [rows]);
  // The list is inverted, so the newest block is first in the data and sits at the bottom of the screen.
  const data = useMemo(() => [...blocks].reverse(), [blocks]);

  const running = Boolean(live?.isRunning);
  const canSend = draft.trim().length > 0 && !send.isPending && !running;

  const onSend = useCallback(() => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft('');
    send.mutate(text, {
      onError: (error) => {
        setDraft(text);
        Alert.alert('Message not sent', error instanceof Error ? error.message : 'Try again.');
      },
    });
  }, [draft, send]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: tokens.colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <View style={{ paddingTop: insets.top, backgroundColor: tokens.colors.bgChrome, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.colors.border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm, paddingHorizontal: tokens.space.sm, paddingVertical: tokens.space.sm }}>
          <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} hitSlop={10} style={{ padding: tokens.space.xs }}>
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
              <Path d="M14.5 5 8 12l6.5 7" stroke={tokens.colors.fg} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </Pressable>

          {bot ? <BotAvatarFor bot={bot} size={28} /> : null}

          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '600' }}>
              {bot?.name ?? 'Thread'}
            </Text>
            <Text numberOfLines={1} style={{ color: tokens.colors.fgTertiary, fontSize: 11 }}>
              {running ? activityLabel(live?.activity?.kind) : 'Idle'}
            </Text>
          </View>

          {running ? (
            <Pressable onPress={() => interrupt.mutate()} hitSlop={8} style={{ padding: tokens.space.xs }}>
              <View style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: tokens.colors.destructive }} />
            </Pressable>
          ) : null}

          <Pressable onPress={() => router.push(`/computer/${botId}`)} hitSlop={8} style={{ padding: tokens.space.xs }}>
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
              <Path
                d="M4 5.5h16v11H4zM9 20h6M12 16.5V20"
                stroke={tokens.colors.fg}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </Pressable>
        </View>
      </View>

      <FlatList
        inverted
        data={data}
        keyExtractor={(block) => block.key}
        contentContainerStyle={{ paddingTop: tokens.space.md, paddingBottom: tokens.space.md }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          rowsQuery.isLoading ? null : (
            <View style={{ padding: tokens.space.xxl, alignItems: 'center', transform: [{ scaleY: -1 }] }}>
              <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, textAlign: 'center' }}>
                {bot ? `Say something to ${bot.name}.` : 'This bot is not on the roster any more.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) =>
          item.kind === 'tools' ? (
            <ToolRunChip rows={item.rows} tokens={tokens} />
          ) : (
            <RowView row={item.row} botId={botId} tokens={tokens} bot={bot} follow={item.follow} />
          )
        }
      />

      {running ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: tokens.space.sm,
            paddingHorizontal: tokens.space.xl,
            paddingVertical: tokens.space.sm,
          }}
        >
          <ActivityIndicator size="small" color={tokens.colors.fgSecondary} />
          <Text numberOfLines={1} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, flex: 1 }}>
            {live?.caption || activityLabel(live?.activity?.kind)}
          </Text>
        </View>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: tokens.space.sm,
          paddingHorizontal: tokens.space.lg,
          paddingTop: tokens.space.sm,
          paddingBottom: Math.max(insets.bottom, tokens.space.sm),
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: tokens.colors.border,
          backgroundColor: tokens.colors.bgChrome,
        }}
      >
        <Pressable
          onPress={() => Alert.alert('Voice is next', 'Talking to a bot from the phone arrives in the voice phase.')}
          hitSlop={6}
          style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
        >
          <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
            <Path
              d="M12 4a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 12 4ZM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20"
              stroke={tokens.colors.fgTertiary}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        </Pressable>

        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={setDraft}
          placeholder={running ? `${bot?.name ?? 'The bot'} is working…` : `Message ${bot?.name ?? ''}`.trim()}
          placeholderTextColor={tokens.colors.fgTertiary}
          multiline
          maxLength={8000}
          style={{
            flex: 1,
            maxHeight: 140,
            minHeight: 40,
            backgroundColor: tokens.colors.bgSubtle,
            color: tokens.colors.fg,
            borderRadius: tokens.radii.md,
            paddingHorizontal: tokens.space.lg,
            paddingTop: tokens.space.md,
            paddingBottom: tokens.space.md,
            fontSize: tokens.fontSizes.message,
          }}
        />
        <Pressable
          onPress={onSend}
          disabled={!canSend}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: canSend ? tokens.colors.accent : tokens.colors.bgSubtle,
          }}
        >
          {send.isPending ? (
            <ActivityIndicator size="small" color={tokens.colors.onAccent} />
          ) : (
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
              <Path
                d="M12 19V5m0 0-6 6m6-6 6 6"
                stroke={canSend ? tokens.colors.onAccent : tokens.colors.fgTertiary}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function activityLabel(kind: string | null | undefined): string {
  if (!kind) return 'Working…';
  return kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function RowView({
  row,
  botId,
  tokens,
  bot,
  follow,
}: {
  row: Row;
  botId: string;
  tokens: MobileTokens;
  bot: Bot | undefined;
  /** Not the first message of a run: no avatar, no name, just the text. */
  follow?: boolean;
}) {
  const body = row.body;

  switch (body.type) {
    case 'message':
      return (
        <MessageBubble
          role={body.role}
          text={body.text}
          createdAt={row.createdAt}
          streaming={body.streaming}
          from={body.from}
          files={body.files}
          bot={bot}
          follow={follow}
        />
      );
    case 'card':
      return <CardView body={body} seq={row.seq} botId={botId} tokens={tokens} />;
    case 'tool-call':
      // Consecutive tool calls are folded together before rendering; a lone one still gets a chip.
      return <ToolRunChip rows={[row]} tokens={tokens} />;
    case 'event':
    case 'notice':
      return (
        <Text
          style={{
            color: body.type === 'notice' && body.tone === 'error' ? tokens.colors.destructive : tokens.colors.fgTertiary,
            fontSize: tokens.fontSizes.caption,
            textAlign: 'center',
            marginVertical: tokens.space.sm,
            marginHorizontal: tokens.space.xxl,
          }}
        >
          {body.text}
        </Text>
      );
    default:
      return null;
  }
}

/** "Worked for 12s · 4 steps", expanding to the calls themselves. */
function ToolRunChip({ rows, tokens }: { rows: Row[]; tokens: MobileTokens }) {
  const [open, setOpen] = useState(false);
  const calls = rows
    .map((row) => (row.body.type === 'tool-call' ? row.body : null))
    .filter((body): body is ToolCallBody => body !== null);
  const startedAt = rows[0]?.createdAt ?? 0;
  const endedAt = rows[rows.length - 1]?.createdAt ?? startedAt;
  const running = calls.some((call) => call.status === 'running' || call.status === 'awaiting-approval');
  const failed = calls.some((call) => call.status === 'error' || call.status === 'denied');

  return (
    <View style={{ marginHorizontal: tokens.space.xl, marginVertical: tokens.space.xxs }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: tokens.space.sm,
          alignSelf: 'flex-start',
          paddingHorizontal: tokens.space.md,
          paddingVertical: tokens.space.sm,
          borderRadius: tokens.radii.full,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.colors.border,
          backgroundColor: tokens.colors.bgSubtle,
        }}
      >
        {running ? (
          <ActivityIndicator size="small" color={tokens.colors.fgSecondary} />
        ) : (
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: failed ? tokens.colors.destructive : tokens.colors.fgTertiary,
            }}
          />
        )}
        <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>
          {running ? 'Working' : `Worked for ${durationLabel(endedAt - startedAt)}`} · {rows.length} step{rows.length === 1 ? '' : 's'}
        </Text>
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{open ? 'Hide' : 'Show'}</Text>
      </Pressable>

      {open ? (
        <View style={{ marginTop: tokens.space.xs, gap: tokens.space.xs, paddingLeft: tokens.space.md }}>
          {calls.map((call) => (
            <View key={call.callId} style={{ flexDirection: 'row', gap: tokens.space.sm, alignItems: 'flex-start' }}>
              <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption, marginTop: 2 }}>
                {call.status === 'error' || call.status === 'denied' ? '×' : call.status === 'running' ? '·' : '✓'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>{call.label || call.name}</Text>
                {call.summary ? (
                  <Text numberOfLines={3} style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>
                    {call.summary}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function CardView({ body, seq, botId, tokens }: { body: Extract<CardBody, { type: 'card' }>; seq: number; botId: string; tokens: MobileTokens }) {
  if (body.card === 'approval') return <ApprovalCard body={body} tokens={tokens} botId={botId} />;
  if (body.card === 'question') return <QuestionCard body={body} seq={seq} botId={botId} tokens={tokens} />;

  // Connect and draft cards are informational on the phone: the work happens on the web app.
  const title = body.card === 'connect' ? `Connect ${body.toolkitName}` : `Draft ${body.channel}`;
  const text = body.card === 'connect' ? body.reason : body.subject ? `${body.subject}\n\n${body.text}` : body.text;
  return (
    <View style={cardStyle(tokens)}>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '600' }}>{title}</Text>
      <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, lineHeight: 19 }}>{text}</Text>
      <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>
        Finish this on the web app.
      </Text>
    </View>
  );
}

function ApprovalCard({ body, botId, tokens }: { body: Extract<CardBody, { card: 'approval' }>; botId: string; tokens: MobileTokens }) {
  const approval = useApproval(botId);
  const pending = body.status === 'pending';
  const statusText =
    body.status === 'allowed' ? 'Allowed' : body.status === 'always' ? 'Always allowed' : body.status === 'denied' ? 'Denied' : body.status === 'expired' ? 'Expired' : null;

  return (
    <View style={cardStyle(tokens)}>
      <Text style={{ color: tokens.colors.fgTertiary, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {body.toolkitName ?? 'Permission'}
      </Text>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '600' }}>{body.title}</Text>
      {body.detail ? (
        <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, lineHeight: 19 }}>{body.detail}</Text>
      ) : null}

      {pending ? (
        <View style={{ flexDirection: 'row', gap: tokens.space.sm, marginTop: tokens.space.xs }}>
          <CardButton
            tokens={tokens}
            label="Allow"
            primary
            busy={approval.isPending}
            onPress={() => approval.mutate({ approvalId: body.approvalId, decision: 'allow' })}
          />
          <CardButton
            tokens={tokens}
            label="Always"
            busy={approval.isPending}
            onPress={() => approval.mutate({ approvalId: body.approvalId, decision: 'always' })}
          />
          <CardButton
            tokens={tokens}
            label="Deny"
            danger
            busy={approval.isPending}
            onPress={() => approval.mutate({ approvalId: body.approvalId, decision: 'deny' })}
          />
        </View>
      ) : statusText ? (
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{statusText}</Text>
      ) : null}
    </View>
  );
}

function QuestionCard({
  body,
  seq,
  botId,
  tokens,
}: {
  body: Extract<CardBody, { card: 'question' }>;
  seq: number;
  botId: string;
  tokens: MobileTokens;
}) {
  const card = useQuestionCard(botId);
  const pending = body.status === 'pending';

  return (
    <View style={cardStyle(tokens)}>
      <Text style={{ color: tokens.colors.fgTertiary, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>Question</Text>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message }}>{body.question}</Text>

      {pending ? (
        <View style={{ gap: tokens.space.xs, marginTop: tokens.space.xs }}>
          {body.options.map((option) => (
            <Pressable
              key={option}
              disabled={card.isPending}
              onPress={() => card.mutate({ seq, answer: option })}
              style={{
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: tokens.colors.border,
                borderRadius: tokens.radii.md,
                paddingHorizontal: tokens.space.lg,
                paddingVertical: tokens.space.md,
              }}
            >
              <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>{option}</Text>
            </Pressable>
          ))}
          <Pressable disabled={card.isPending} onPress={() => card.mutate({ seq })} hitSlop={6}>
            <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.sm, marginTop: tokens.space.xs }}>
              Dismiss
            </Text>
          </Pressable>
        </View>
      ) : (
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>
          {body.status === 'answered' ? `Answered: ${body.answer ?? ''}` : 'Dismissed'}
        </Text>
      )}
    </View>
  );
}

function CardButton({
  tokens,
  label,
  onPress,
  primary,
  danger,
  busy,
}: {
  tokens: MobileTokens;
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  busy?: boolean;
}) {
  const background = primary ? tokens.colors.accent : danger ? tokens.colors.destructiveBg : tokens.colors.bgSubtle;
  const color = primary ? tokens.colors.onAccent : danger ? tokens.colors.destructive : tokens.colors.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={{
        flex: 1,
        alignItems: 'center',
        paddingVertical: tokens.space.md,
        borderRadius: tokens.radii.md,
        backgroundColor: background,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Text style={{ color, fontSize: tokens.fontSizes.sm, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

function cardStyle(tokens: MobileTokens) {
  return {
    marginHorizontal: tokens.space.xl,
    marginVertical: tokens.space.xs,
    padding: tokens.space.lg,
    gap: tokens.space.xs,
    borderRadius: tokens.radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.colors.border,
    backgroundColor: tokens.colors.bgElevated,
  } as const;
}
