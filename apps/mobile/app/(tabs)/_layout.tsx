import { StyleSheet, Text } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { useMobileTokens } from '../../lib/native';

/**
 * The bottom bar: the sections of the web app's rail, in the order a phone wants them.
 *
 * Activity, Chat, Calendar, Files, Computers and More are the six a thumb can reach. Skills and the
 * roster are one tap deeper — More pushes them — and Settings keeps its own route so the existing
 * screen and every link to /settings still work; it is simply not a tab of its own.
 *
 * The thread and computer viewers stay out of this group on purpose: both are full-screen pushes
 * over the tabs (app/thread/[botId], app/computer/[botId]), which is what a chat and a live screen
 * want. Their routes are unchanged.
 *
 * Fluent-dense (plan §12.2): a 48px bar on the window canvas, not on the pane white, so it reads as
 * chrome rather than as part of the screen above it. Six labels across a phone get 10/12 type, and
 * only the current tab is semibold — the bar is a status line, not a second toolbar.
 */

type TabName = 'activity' | 'index' | 'calendar' | 'files' | 'computers' | 'more';

const ICONS: Record<TabName, string> = {
  // A pulse line, a speech bubble, a calendar page, a paperclip, a monitor, and an ellipsis.
  activity: 'M3 12h4l2.5-6 3 12L15 12h6',
  index: 'M4 5.5h16v10.5H9.5L4 20V5.5Z',
  calendar: 'M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v4M15.5 4v4',
  files: 'M9 12.5 14.5 7a3.5 3.5 0 0 1 5 5L13 18.5a5 5 0 0 1-7-7l6-6',
  computers: 'M3.5 5.5h17v10h-17zM9 19.5h6M12 15.5v4',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
};

/** Height of the bar's own content; the safe-area inset is added below it. */
const BAR_HEIGHT = 48;
/** Icons are 24px on every platform — the bar is 48 tall, so an icon is half of it. */
const ICON_SIZE = 24;

function TabIcon({ name, color }: { name: TabName; color: string }) {
  return (
    <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none">
      <Path
        d={ICONS[name]}
        stroke={color}
        // The ellipsis is three dots: it needs a weight a stroke icon does not.
        strokeWidth={name === 'more' ? 2.6 : 1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * A tab label. Rendering it ourselves is what buys the focused-only semibold: `tabBarLabelStyle`
 * is a single style object and cannot vary with focus.
 */
function TabLabel({ focused, color, children }: { focused: boolean; color: string; children: string }) {
  return (
    <Text
      numberOfLines={1}
      style={{ color, fontSize: 10, lineHeight: 12, fontWeight: focused ? '600' : '400' }}
    >
      {children}
    </Text>
  );
}

/** One tab's options: its label, its label renderer and its 24px icon. */
function tab(label: string, icon: TabName) {
  return {
    title: label,
    tabBarLabel: ({ focused, color }: { focused: boolean; color: string }) => (
      <TabLabel focused={focused} color={color}>
        {label}
      </TabLabel>
    ),
    tabBarIcon: ({ color }: { color: string }) => <TabIcon name={icon} color={color} />,
  };
}

export default function TabsLayout() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tokens.colors.accent,
        tabBarInactiveTintColor: tokens.colors.fgTertiary,
        tabBarStyle: {
          height: BAR_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
          backgroundColor: tokens.colors.bgCanvas,
          borderTopColor: tokens.colors.borderTertiary,
          borderTopWidth: StyleSheet.hairlineWidth,
          // iOS draws no shadow by default; Android would otherwise add elevation on top of the hairline.
          elevation: 0,
        },
        // The bar's own icon slot is 28 tall (bottom-tabs' uikit variant), which with a 12px label
        // and the item's 5px padding would overflow a 48px bar. Pin the slot to the 24px icon.
        tabBarIconStyle: { width: ICON_SIZE, height: ICON_SIZE },
        tabBarItemStyle: { paddingVertical: 0 },
        // Six labels across the width of a phone: one line, a little tighter than before.
        tabBarLabelStyle: { fontSize: 10, lineHeight: 12 },
        sceneStyle: { backgroundColor: tokens.colors.bg },
      }}
    >
      <Tabs.Screen name="activity" options={tab('Activity', 'activity')} />
      <Tabs.Screen name="index" options={tab('Chat', 'index')} />
      <Tabs.Screen name="calendar" options={tab('Calendar', 'calendar')} />
      <Tabs.Screen name="files" options={tab('Files', 'files')} />
      <Tabs.Screen name="computers" options={tab('Computers', 'computers')} />
      <Tabs.Screen name="more" options={tab('More', 'more')} />

      {/* Reachable, not tabbed: the roster, and Settings which More pushes. The tab bar stays on
          both, because neither screen has a header of its own to offer a way back. */}
      <Tabs.Screen name="bots" options={{ href: null }} />
      <Tabs.Screen name="settings" options={{ href: null }} />
    </Tabs>
  );
}
