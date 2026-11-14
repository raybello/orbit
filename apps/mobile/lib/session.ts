import * as SecureStore from 'expo-secure-store';

/** The bearer session token the server hands back from POST /api/auth/sign-in. */
const TOKEN_KEY = 'orbit_session_token';

export async function getSessionToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    // A keychain failure should look like "signed out", not crash the app on launch.
    return null;
  }
}

export async function saveSessionToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearSessionToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    /* nothing saved */
  }
}
