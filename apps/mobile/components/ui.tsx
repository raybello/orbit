import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMobileTokens, type MobileTokens } from '../lib/native';

/**
 * The pieces every new tab shares.
 *
 * They exist so Activity, Calendar, Files, Computers and More look like the Chats screen that came
 * before them — the same 30pt title, the same card fill and hairline border, the same three loading,
 * error and empty states — without each screen inventing its own.
 */

export function ScreenHeader({ title, subtitle, right }: { title: string; subtitle?: string | null; right?: ReactNode }) {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + tokens.space.sm,
        paddingHorizontal: tokens.space.xl,
        paddingBottom: tokens.space.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: tokens.space.md }}>
        <Text style={{ color: tokens.colors.fg, fontSize: 30, fontWeight: '600', letterSpacing: -0.5 }}>{title}</Text>
        {right}
      </View>
      {subtitle ? (
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.sm, marginTop: 2 }}>{subtitle}</Text>
      ) : null}
    </View>
  );
}

/** A card: the raised surface every list row and panel in the app sits on. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const tokens = useMobileTokens();
  return (
    <View
      style={[
        {
          backgroundColor: tokens.colors.bgElevated,
          borderRadius: tokens.radii.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.colors.border,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export type StateKind = 'loading' | 'error' | 'empty';

/**
 * Loading, error-with-retry, or nothing-here-yet. One component so the three never drift apart
 * between screens, and so an error always comes with the way out of it.
 */
export function StateBlock({
  kind,
  title,
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  kind: StateKind;
  title?: string;
  message?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const tokens = useMobileTokens();
  const heading =
    title ??
    (kind === 'loading' ? 'Loading…' : kind === 'error' ? 'Could not reach the server' : 'Nothing here yet');

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: tokens.space.xxl, gap: tokens.space.md }}>
      {kind === 'loading' ? <ActivityIndicator color={tokens.colors.fgSecondary} /> : null}
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '500', textAlign: 'center' }}>
        {heading}
      </Text>
      {message ? (
        <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, textAlign: 'center', lineHeight: 19 }}>
          {message}
        </Text>
      ) : null}
      {kind === 'error' && onRetry ? (
        <Pressable
          onPress={onRetry}
          style={({ pressed }) => ({
            marginTop: tokens.space.xs,
            paddingHorizontal: tokens.space.xl,
            paddingVertical: tokens.space.sm,
            borderRadius: tokens.radii.full,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: tokens.colors.border,
            backgroundColor: pressed ? tokens.colors.bgHover : 'transparent',
          })}
        >
          <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>{retryLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A filter or choice pill. Selected pills fill with the accent, exactly like the chat list's row states. */
export function Chip({
  label,
  active = false,
  onPress,
  disabled = false,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const tokens = useMobileTokens();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: disabled || !onPress }}
      style={({ pressed }) => ({
        paddingHorizontal: tokens.space.lg,
        paddingVertical: tokens.space.sm,
        borderRadius: tokens.radii.full,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: active ? tokens.colors.accent : tokens.colors.border,
        backgroundColor: active ? tokens.colors.accent : pressed ? tokens.colors.bgHover : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text
        style={{
          color: active ? tokens.colors.onAccent : tokens.colors.fgSecondary,
          fontSize: tokens.fontSizes.sm,
          fontWeight: active ? '600' : '400',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Two or three mutually exclusive choices, e.g. one-time vs recurring. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const tokens = useMobileTokens();
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: tokens.colors.bgSubtle,
        borderRadius: tokens.radii.md,
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              paddingVertical: tokens.space.sm,
              borderRadius: tokens.radii.sm,
              alignItems: 'center',
              backgroundColor: active ? tokens.colors.bgElevated : 'transparent',
            }}
          >
            <Text style={{ color: active ? tokens.colors.fg : tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, fontWeight: active ? '600' : '400' }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A small uppercase tag, e.g. "Recurring" on a calendar event. */
export function Tag({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'accent' | 'success' | 'warn' }) {
  const tokens = useMobileTokens();
  const color =
    tone === 'accent'
      ? tokens.colors.accent
      : tone === 'success'
        ? tokens.colors.success
        : tone === 'warn'
          ? tokens.colors.warn
          : tokens.colors.fgTertiary;
  const bg =
    tone === 'success' ? tokens.colors.successBg : tone === 'warn' ? tokens.colors.warnBg : tokens.colors.bgSubtle;
  return (
    <View style={{ paddingHorizontal: tokens.space.sm, paddingVertical: 1, borderRadius: tokens.radii.full, backgroundColor: bg }}>
      <Text style={{ color, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
    </View>
  );
}

/** A primary action button: "New event", "Create". */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  tokens: injected,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  tokens?: MobileTokens;
}) {
  const own = useMobileTokens();
  const tokens = injected ?? own;
  const inert = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityState={{ disabled: inert }}
      style={{
        paddingHorizontal: tokens.space.lg,
        paddingVertical: tokens.space.sm,
        borderRadius: tokens.radii.full,
        backgroundColor: inert ? tokens.colors.bgSubtle : tokens.colors.accent,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: inert ? tokens.colors.fgTertiary : tokens.colors.onAccent, fontSize: tokens.fontSizes.sm, fontWeight: '600' }}>
        {busy ? 'Working…' : label}
      </Text>
    </Pressable>
  );
}
