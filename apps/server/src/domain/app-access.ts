/**
 * Which connected apps a bot may use. Every bot shares the person's Composio connections; a bot the
 * person turned an app off for must not reach it by any route (an action, a trigger, the calendar
 * mirror, a connect card).
 */

/** The app a slug belongs to: the toolkit itself (`gmail`), or an action or trigger of it (`GMAIL_SEND_EMAIL`). */
export function appOfSlug(slug: string, apps: Iterable<string>): string | null {
  const s = slug.trim().toLowerCase();
  let best: string | null = null;
  for (const app of apps) {
    const a = app.toLowerCase();
    if ((s === a || s.startsWith(`${a}_`)) && (!best || a.length > best.length)) best = a;
  }
  return best;
}

/** The app's own tools that name an app in an argument, and which argument holds it. */
const APP_ARGUMENT: Record<string, string> = {
  request_app_connection: 'toolkit',
  list_event_triggers: 'toolkit',
  create_event_routine: 'trigger_slug',
};

/** The app slugs one of the app's own tools would touch, read from its arguments. */
export function ownToolApps(name: string, args: Record<string, unknown>): string[] {
  const key = APP_ARGUMENT[name];
  const v = key ? args[key] : undefined;
  return typeof v === 'string' && v.trim() ? [v] : [];
}

/** What a bot is told when it reaches for an app the person turned off for it. */
export const appOffNotice = (app: string) =>
  `${app} is turned off for you: the user has not allowed you to use it. Do not retry, and do not try another route to it. ` +
  'If you need it, tell the user; they can allow it under Settings → Connected apps.';
