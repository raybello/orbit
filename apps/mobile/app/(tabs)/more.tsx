import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { Card, ScreenHeader } from '../../components/ui';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { useOrbitStore } from '../../lib/store';

/**
 * More: everything that is not a feed of its own.
 *
 * Skills and Bots are full screens pushed on top of the tabs; Settings is the existing tab screen,
 * still at /settings. Calls is a placeholder here rather than a section of its own — voice already
 * lives in each chat's composer, and this says so.
 */
export default function MoreScreen() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const bots = useOrbitStore((s) => s.bots);
  const primary = bots.find((b) => b.isPrimary) ?? bots.find((b) => b.kind !== 'room');

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
      <ScreenHeader title="More" />

      <ScrollView contentContainerStyle={{ padding: tokens.space.xl, paddingTop: tokens.space.sm, gap: tokens.space.xl, paddingBottom: insets.bottom + tokens.space.xxl }}>
        <Section title="Workspace" tokens={tokens}>
          <LinkRow
            tokens={tokens}
            label="Skills"
            caption="Tools and MCP servers, per bot"
            onPress={() => router.push('/skills')}
          />
          <LinkRow
            tokens={tokens}
            label="Bots"
            caption="The roster and what each bot is for"
            onPress={() => router.push('/bots')}
            last
          />
        </Section>

        <Section title="Settings" tokens={tokens}>
          <LinkRow tokens={tokens} label="Server, notifications, sign out" onPress={() => router.push('/settings')} last />
        </Section>

        <Card style={{ padding: tokens.space.lg, gap: tokens.space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
              <Path
                d="M12 4a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 12 4ZM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20"
                stroke={tokens.colors.fgSecondary}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
            <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '500' }}>Calls are coming</Text>
          </View>
          <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, lineHeight: 19 }}>
            Voice calls with your bots are available today from any chat: press the microphone in the message box and talk to the
            bot the way you would on a call. A screen built for calls is still to come.
          </Text>
          <Pressable
            onPress={() => (primary ? router.push(`/thread/${primary.id}`) : router.push('/(tabs)'))}
            disabled={!primary}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              marginTop: tokens.space.xs,
              paddingHorizontal: tokens.space.lg,
              paddingVertical: tokens.space.sm,
              borderRadius: tokens.radii.full,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: tokens.colors.border,
              backgroundColor: pressed ? tokens.colors.bgHover : 'transparent',
              opacity: primary ? 1 : 0.5,
            })}
          >
            <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>
              {primary ? `Open ${primary.name}'s chat` : 'Open a chat'}
            </Text>
          </Pressable>
        </Card>
      </ScrollView>
    </View>
  );
}

function Section({ title, tokens, children }: { title: string; tokens: MobileTokens; children: React.ReactNode }) {
  return (
    <View style={{ gap: tokens.space.sm }}>
      <Text
        style={{
          color: tokens.colors.fgTertiary,
          fontSize: tokens.fontSizes.caption,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          paddingHorizontal: tokens.space.xs,
        }}
      >
        {title}
      </Text>
      <View
        style={{
          backgroundColor: tokens.colors.bgElevated,
          borderRadius: tokens.radii.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.colors.border,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

function LinkRow({
  tokens,
  label,
  caption,
  onPress,
  last = false,
}: {
  tokens: MobileTokens;
  label: string;
  caption?: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens.space.md,
        paddingHorizontal: tokens.space.lg,
        paddingVertical: tokens.space.md,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: tokens.colors.border,
        backgroundColor: pressed ? tokens.colors.bgHover : 'transparent',
      })}
    >
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message }}>{label}</Text>
        {caption ? (
          <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{caption}</Text>
        ) : null}
      </View>
      <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
        <Path d="M9.5 5 16 12l-6.5 7" stroke={tokens.colors.fgTertiary} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </Pressable>
  );
}
