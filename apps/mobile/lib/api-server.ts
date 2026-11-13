import * as SecureStore from 'expo-secure-store';
import { defaultApiBase } from './endpoint';

/**
 * The server this install points at. Kept apart from the session token because they change at
 * different moments: switching servers then signing in is a normal flow.
 */
const BASE_KEY = 'orbit_api_base';

export async function savedApiBase(): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(BASE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export async function saveApiBase(url: string): Promise<void> {
  await SecureStore.setItemAsync(BASE_KEY, url);
}

export async function resetApiBase(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(BASE_KEY);
  } catch {
    /* nothing saved */
  }
}

/** The saved server, or the build's default when nobody has chosen one yet. */
export async function currentApiBase(): Promise<string> {
  return (await savedApiBase()) ?? defaultApiBase();
}
