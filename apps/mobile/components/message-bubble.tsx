import { Fragment, useCallback, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { MessageFile } from '@orbit/contracts';
import { timeAgo } from '../lib/format';
import { useMobileTokens, type MobileTokens } from '../lib/native';

/**
 * A chat bubble with just enough markdown for agent replies: fenced code, inline code, bold,
 * links, headings, bullet and numbered lists. Links open in the system browser — the app has no
 * in-app browser, and the server's own links (a bot's screen, a toolkit) belong there.
 */

type Segment = { type: 'text'; value: string } | { type: 'code'; value: string; lang: string };

function splitFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ type: 'text', value: text.slice(cursor, match.index) });
    segments.push({ type: 'code', lang: match[1] ?? '', value: match[2].replace(/\n$/, '') });
    cursor = fence.lastIndex;
  }
  // An unterminated fence while the reply is still streaming: show what we have as code.
  if (cursor < text.length) {
    const rest = text.slice(cursor);
    const open = rest.indexOf('```');
    if (open !== -1) {
      if (open > 0) segments.push({ type: 'text', value: rest.slice(0, open) });
      segments.push({ type: 'code', lang: rest.slice(open + 3).split('\n')[0] ?? '', value: rest.slice(open + 3).replace(/^[\w+-]*\n/, '') });
    } else if (rest.trim()) {
      segments.push({ type: 'text', value: rest });
    }
  }
  return segments;
}

type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string; href: string };

const INLINE = /(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()"']+)/g;

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > cursor) tokens.push({ type: 'text', value: text.slice(cursor, at) });
    if (match[2] !== undefined) tokens.push({ type: 'bold', value: match[2] });
    else if (match[4] !== undefined) tokens.push({ type: 'code', value: match[4] });
    else if (match[6] !== undefined && match[7] !== undefined) tokens.push({ type: 'link', value: match[6], href: match[7] });
    else if (match[8] !== undefined) tokens.push({ type: 'link', value: match[8], href: match[8] });
    cursor = at + match[0].length;
  }
  if (cursor < text.length) tokens.push({ type: 'text', value: text.slice(cursor) });
  return tokens;
}

function openLink(href: string) {
  if (!/^https?:\/\//i.test(href)) return;
  Linking.openURL(href).catch(() => Alert.alert('Could not open that link', href));
}

function InlineText({ text, tokens, style }: { text: string; tokens: MobileTokens; style: object }) {
  const parts = useMemo(() => tokenizeInline(text), [text]);
  return (
    <Text style={style} selectable>
      {parts.map((part, i) => {
        if (part.type === 'bold') return <Text key={i} style={{ fontWeight: '600' }}>{part.value}</Text>;
        if (part.type === 'code')
          return (
            <Text key={i} style={{ fontFamily: tokens.mono, fontSize: tokens.fontSizes.sm }}>
              {part.value}
            </Text>
          );
        if (part.type === 'link')
          return (
            <Text key={i} onPress={() => openLink(part.href)} style={{ textDecorationLine: 'underline' }}>
              {part.value}
            </Text>
          );
        return <Fragment key={i}>{part.value}</Fragment>;
      })}
    </Text>
  );
}

function CodeBlock({ code, tokens }: { code: string; tokens: MobileTokens }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: tokens.space.xs }}>
      <View
        style={{
          backgroundColor: tokens.colors.bgSubtle,
          borderColor: tokens.colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: tokens.radii.sm,
          padding: tokens.space.md,
        }}
      >
        <Text style={{ fontFamily: tokens.mono, fontSize: tokens.fontSizes.sm, color: tokens.colors.fg }} selectable>
          {code}
        </Text>
      </View>
    </ScrollView>
  );
}

/** Paragraphs, headings and list items. Anything else renders as a plain paragraph. */
function TextBody({ value, color, tokens }: { value: string; color: string; tokens: MobileTokens }) {
  const blocks = useMemo(() => value.split(/\n{2,}/).filter((b) => b.trim().length > 0), [value]);
  const bodyStyle = { color, fontSize: tokens.fontSizes.message, lineHeight: tokens.fontSizes.message * 1.45 };

  return (
    <View>
      {blocks.map((block, i) => {
        const heading = /^(#{1,3})\s+(.*)$/.exec(block);
        if (heading) {
          return (
            <Text
              key={i}
              style={[bodyStyle, { fontWeight: '600', fontSize: tokens.fontSizes.lg, marginTop: i ? tokens.space.sm : 0 }]}
            >
              {heading[2]}
            </Text>
          );
        }

        const lines = block.split('\n');
        const isList = lines.every((line) => /^\s*([-*+]|\d+[.)])\s+/.test(line));
        if (isList) {
          return (
            <View key={i} style={{ marginTop: i ? tokens.space.xs : 0 }}>
              {lines.map((line, j) => {
                const ordered = /^\s*\d+[.)]/.test(line);
                const label = ordered ? line.match(/^\s*(\d+)[.)]/)?.[1] : '•';
                return (
                  <View key={j} style={{ flexDirection: 'row', gap: tokens.space.sm }}>
                    <Text style={[bodyStyle, { color }]}>{label}</Text>
                    <View style={{ flex: 1 }}>
                      <InlineText text={line.replace(/^\s*([-*+]|\d+[.)])\s+/, '')} tokens={tokens} style={bodyStyle} />
                    </View>
                  </View>
                );
              })}
            </View>
          );
        }

        return (
          <View key={i} style={{ marginTop: i ? tokens.space.sm : 0 }}>
            <InlineText text={block} tokens={tokens} style={bodyStyle} />
          </View>
        );
      })}
    </View>
  );
}

export interface MessageBubbleProps {
  role: 'user' | 'assistant';
  text: string;
  createdAt?: number;
  streaming?: boolean;
  /** Set when the message came from another bot, a routine or a voice call. */
  from?: { kind: string; name: string };
  files?: MessageFile[];
}

export function MessageBubble({ role, text, createdAt, streaming, from, files }: MessageBubbleProps) {
  const tokens = useMobileTokens();
  const [copied, setCopied] = useState(false);
  const isUser = role === 'user';
  const segments = useMemo(() => splitFences(text), [text]);
  const color = isUser ? tokens.colors.onAccent : tokens.colors.fg;

  const copy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable (rare, e.g. a locked device) — nothing to say about it */
    }
  }, [text]);

  return (
    <View
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '88%',
        marginHorizontal: tokens.space.xl,
        marginVertical: tokens.space.xxs,
      }}
    >
      {from && !isUser ? (
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.xs, marginBottom: 2, marginLeft: tokens.space.md }}>
          {from.name}
        </Text>
      ) : null}
      <Pressable
        onLongPress={copy}
        delayLongPress={350}
        style={{
          backgroundColor: isUser ? tokens.colors.bubbleUser : tokens.colors.bubbleAgent,
          borderRadius: tokens.radii.bubble,
          paddingHorizontal: tokens.space.lg,
          paddingVertical: tokens.space.md,
        }}
      >
        {segments.map((segment, i) =>
          segment.type === 'code' ? (
            <CodeBlock key={i} code={segment.value} tokens={tokens} />
          ) : (
            <TextBody key={i} value={segment.value} color={color} tokens={tokens} />
          ),
        )}
        {streaming ? (
          <Text style={{ color, opacity: 0.5, fontSize: tokens.fontSizes.sm, marginTop: tokens.space.xs }}>…</Text>
        ) : null}
      </Pressable>

      {copied ? (
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: 11, marginTop: 2, marginHorizontal: tokens.space.xs }}>
          Copied
        </Text>
      ) : null}

      {files?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: tokens.space.xs, marginTop: tokens.space.xs }}>
          {files.map((file) => (
            <Pressable
              key={file.path}
              onPress={() => Alert.alert(file.filename, 'Files open on the web app for now.')}
              style={{
                borderColor: tokens.colors.border,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: tokens.radii.sm,
                paddingHorizontal: tokens.space.sm,
                paddingVertical: 2,
              }}
            >
              <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.xs }}>{file.filename}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {createdAt ? (
        <Text
          style={{
            color: tokens.colors.fgTertiary,
            fontSize: 11,
            alignSelf: isUser ? 'flex-end' : 'flex-start',
            marginTop: 2,
            marginHorizontal: tokens.space.xs,
          }}
        >
          {timeAgo(createdAt)}
        </Text>
      ) : null}
    </View>
  );
}
