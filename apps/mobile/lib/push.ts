import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { PushPlatform, PushRegisterRequest } from '@orbit/contracts';
import { orbitDelete, orbitPost } from './api';

export type PushRegistration = 'registered' | 'denied' | 'no-project-id' | 'unsupported' | 'error';

/** Push arrives as a banner while the app is open; the thread itself keeps its own unread badge. */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

function platform(): PushPlatform | null {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return null;
}

/** The token this install last registered, so signing out can name just this device. */
let registeredToken: string | null = null;

/**
 * Ask for permission, get the Expo push token, hand it to the server. Called once after sign-in:
 * the token is per install, and the server dedupes by token, so calling it again is harmless.
 */
export async function registerPushNotifications(apiBase: string): Promise<PushRegistration> {
  const target = platform();
  if (!target) return 'unsupported';

  try {
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return 'denied';

    const id = projectId();
    // Without an EAS project id the token cannot be minted; sign-in still works, push just stays off.
    if (!id) return 'no-project-id';

    const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
    registeredToken = token.data;
    const body: PushRegisterRequest = { token: token.data, platform: target };
    await orbitPost<{ ok: boolean }>(apiBase, '/api/push/register', body);
    return 'registered';
  } catch {
    return 'error';
  }
}

/**
 * The token to unregister, resolved without ever prompting: a sign-out is no place to ask for a new
 * permission, and without one the token simply cannot be read back.
 */
export async function registeredPushToken(): Promise<string | null> {
  if (registeredToken) return registeredToken;
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return null;
    const id = projectId();
    if (!id) return null;
    const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
    registeredToken = token.data;
    return registeredToken;
  } catch {
    return null;
  }
}

/**
 * Signing out forgets this device's token only — the same account on another phone keeps its push.
 * With no token to name, the request says nothing and the server clears the account, as before.
 */
export async function unregisterPushNotifications(apiBase: string, token: string | null): Promise<void> {
  try {
    const path = token ? `/api/push/register?token=${encodeURIComponent(token)}` : '/api/push/register';
    await orbitDelete<{ ok: boolean }>(apiBase, path);
  } catch {
    /* the server forgets stale tokens on its own */
  }
}

/** The bot a tapped notification belongs to, if it carries one. */
export function botIdFromResponse(response: Notifications.NotificationResponse): string | null {
  const data = response.notification.request.content.data as { botId?: unknown } | null;
  return data && typeof data.botId === 'string' ? data.botId : null;
}
