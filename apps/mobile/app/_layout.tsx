import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { Stack, router, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ServerEvent } from '@orbit/contracts';
import { currentApiBase, savedApiBase } from '../lib/api-server';
import { hasBakedApiBase } from '../lib/endpoint';
import { getSessionToken } from '../lib/session';
import { connectSSE } from '../lib/sse';
import { useOrbitStore } from '../lib/store';
import { useMobileTokens } from '../lib/native';
import { botIdFromResponse, configureNotificationHandler, registerPushNotifications } from '../lib/push';
import { queryKeys } from '../lib/queries';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A phone loses signal constantly; SSE already keeps the app live, so a failed fetch is not worth three retries.
      retry: 1,
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
});

configureNotificationHandler();

/**
 * Where the app is allowed to be. Three states, checked in order: no server chosen yet, no session,
 * otherwise the tabs. The redirect only fires when the current route is wrong, so it cannot loop.
 */
function AuthGate({ onSessionChange }: { onSessionChange: () => void }) {
  const segments = useSegments();
  const [ready, setReady] = useState(false);
  const lastRedirect = useRef<string>('');
  const signedIn = useRef<boolean | null>(null);

  const path = `/${segments.join('/')}`.replace(/\/$/, '');
  const onServer = path === '/server';
  const onSignIn = path === '/sign-in';
  const onSignOut = path === '/sign-out';

  useEffect(() => {
    let alive = true;
    (async () => {
      const [saved, token] = await Promise.all([savedApiBase(), getSessionToken()]);
      if (!alive) return;
      setReady(true);

      // Signing in or out is the one change that has to restart the live session; navigation is not.
      const nowSignedIn = Boolean(token);
      if (signedIn.current !== nowSignedIn) {
        signedIn.current = nowSignedIn;
        onSessionChange();
      }

      const needsServer = !saved && !hasBakedApiBase();
      if (needsServer && !onServer) return remember('/server');
      if (!token && !onSignIn && !onSignOut) return remember('/sign-in');
      if (token && (onSignIn || onServer)) return remember('/(tabs)');
    })();
    return () => {
      alive = false;
    };
    // `path` is the dependency that matters: it changes on every navigation.
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  function remember(target: string) {
    if (lastRedirect.current === target) return;
    lastRedirect.current = target;
    // Let the navigation settle before the next check, so a push and a redirect cannot race.
    setTimeout(() => {
      lastRedirect.current = '';
      router.replace(target as Parameters<typeof router.replace>[0]);
    }, 0);
  }

  if (!ready) return null;
  return null;
}

/**
 * The two things that only make sense while signed in: the live event feed, and telling the server
 * where to send push notifications. Both re-establish when the app comes back to the foreground.
 */
function LiveSession() {
  const [foreground, setForeground] = useState(0);
  const pushRegistered = useRef<string | null>(null);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setForeground((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const [apiBase, token] = await Promise.all([currentApiBase(), getSessionToken()]);
      if (cancelled || !token) return;

      if (pushRegistered.current !== token) {
        pushRegistered.current = token;
        void registerPushNotifications(apiBase);
      }

      dispose = connectSSE({
        apiBase,
        token,
        onEvent: handleServerEvent,
      });
    })();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [foreground]);

  return null;
}

/** One place where a server frame becomes app state. */
function handleServerEvent(event: ServerEvent) {
  const store = useOrbitStore.getState();
  switch (event.type) {
    case 'rows':
      for (const row of event.rows) store.upsertRow(event.botId, row);
      break;
    case 'cleared':
      store.clearThread(event.botId);
      break;
    case 'live':
      store.upsertLive(event.state);
      break;
    case 'bot':
      store.upsertBot(event.bot);
      break;
    case 'roster':
      void queryClient.invalidateQueries({ queryKey: queryKeys.bots });
      break;
    case 'computer':
    case 'routines':
    case 'tasks':
    case 'memories':
    case 'connections':
    case 'hello':
    case 'ping':
      // Screens that care fetch on focus; nothing global to keep in sync.
      break;
  }
}

export default function RootLayout() {
  const tokens = useMobileTokens();
  const [sessionTick, setSessionTick] = useState(0);
  const bumpSession = useCallback(() => setSessionTick((n) => n + 1), []);

  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      const botId = response ? botIdFromResponse(response) : null;
      if (botId) router.push(`/thread/${botId}`);
    };
    // A tap that launched the app is not delivered to the listener, so read it back on mount.
    Notifications.getLastNotificationResponseAsync().then(open).catch(() => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <StatusBar style={tokens.dark ? 'light' : 'dark'} />
        <AuthGate onSessionChange={bumpSession} />
        <LiveSession key={sessionTick > 0 ? `session-${sessionTick}` : 'boot'} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: tokens.colors.bg },
            headerStyle: { backgroundColor: tokens.colors.bgChrome },
            headerTintColor: tokens.colors.fg,
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="sign-in" options={{ gestureEnabled: false }} />
          <Stack.Screen name="server" options={{ presentation: 'modal', headerShown: true, title: 'Server' }} />
          <Stack.Screen name="sign-out" options={{ presentation: 'modal', headerShown: true, title: 'Sign out' }} />
          <Stack.Screen name="thread/[botId]" options={{ headerShown: false }} />
          <Stack.Screen
            name="computer/[botId]"
            options={{
              headerShown: true,
              title: 'Computer',
              // The screen is wide: it is the one place where landscape is the better fit.
              orientation: Platform.OS === 'ios' ? 'all' : 'default',
            }}
          />
        </Stack>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
