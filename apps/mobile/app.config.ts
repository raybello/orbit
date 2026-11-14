import { existsSync } from 'node:fs';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The app talks to whichever Orbit server the person points it at, so the build has no baked-in
 * default beyond localhost. A release build is the one case where a wrong URL ships to strangers,
 * so it is a hard error there rather than a runtime surprise.
 */

const RELEASE_PROFILES = new Set(['production']);

function isReleaseBuild(): boolean {
  return RELEASE_PROFILES.has(process.env.EAS_BUILD_PROFILE ?? '') || process.env.APP_VARIANT === 'release';
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '10.0.2.2' || host.endsWith('.local');
}

/** Returns a problem description, or null when the URL is fine for the build type we are in. */
function apiUrlProblem(raw: string | undefined, release: boolean): string | null {
  if (!raw?.trim()) return release ? 'EXPO_PUBLIC_API_URL must be set for release builds' : null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return `EXPO_PUBLIC_API_URL is not a URL: ${raw}`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `EXPO_PUBLIC_API_URL must be http(s): ${raw}`;
  // Cleartext to a public host leaks the session token; loopback on a dev box is fine.
  if (release && url.protocol !== 'https:' && !isLoopback(url)) {
    return `EXPO_PUBLIC_API_URL must be https for release builds (got ${raw})`;
  }
  return null;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const release = isReleaseBuild();
  const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  const problem = apiUrlProblem(apiUrl, release);
  if (problem) throw new Error(`[app.config] ${problem}`);

  // Push notifications need a Firebase config on Android and an APNs key on iOS. Both are injected
  // by CI as a file path; when it is absent the build simply ships without native push credentials.
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ?? process.env.GOOGLE_SERVICES_FILE;
  const hasGoogleServices = Boolean(googleServicesFile && existsSync(googleServicesFile));

  return {
    ...config,
    name: 'Orbit',
    slug: 'orbit',
    version: config.version ?? '0.1.0',
    ios: {
      ...config.ios,
      ...(hasGoogleServices ? { googleServicesFile } : {}),
    },
    android: {
      ...config.android,
      ...(hasGoogleServices ? { googleServicesFile } : {}),
    },
    extra: {
      ...config.extra,
      // Expo turns a null/undefined value here into `{}` in the manifest, so only set what exists.
      ...(apiUrl ? { apiUrl } : {}),
      ...(process.env.EAS_PROJECT_ID
        ? { eas: { ...(config.extra?.eas as Record<string, unknown> | undefined), projectId: process.env.EAS_PROJECT_ID } }
        : {}),
    },
  };
};
