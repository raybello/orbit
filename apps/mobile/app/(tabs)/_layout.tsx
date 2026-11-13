import { Tabs } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { useMobileTokens } from '../../lib/native';

type TabName = 'chats' | 'bots' | 'settings';

const ICONS: Record<TabName, string> = {
  // A speech bubble, a roster grid, a gear: drawn here rather than pulling in an icon font.
  chats: 'M4 5.5h16v10.5H9.5L4 20V5.5Z',
  bots: 'M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4',
};

function TabIcon({ name, color }: { name: TabName; color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path d={ICONS[name]} stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function TabsLayout() {
  const tokens = useMobileTokens();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tokens.colors.fg,
        tabBarInactiveTintColor: tokens.colors.fgTertiary,
        tabBarStyle: {
          backgroundColor: tokens.colors.bgChrome,
          borderTopColor: tokens.colors.border,
        },
        tabBarLabelStyle: { fontSize: 11 },
        sceneStyle: { backgroundColor: tokens.colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Chats', tabBarIcon: ({ color }) => <TabIcon name="chats" color={color} /> }}
      />
      <Tabs.Screen
        name="bots"
        options={{ title: 'Bots', tabBarIcon: ({ color }) => <TabIcon name="bots" color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: ({ color }) => <TabIcon name="settings" color={color} /> }}
      />
    </Tabs>
  );
}
