import type { SecureFormField } from '@orbit/contracts';
import { providerFor } from './computer-provider-registry.js';
import { CdpSession, listTabs } from './lib/cdp.js';
import { Secret, SecretBoxTamperError } from './lib/secret-box.js';
import { appendRow } from './store.js';
import { parseUrlPattern, urlMatches } from './domain/url-pattern.js';
import { findVaultEntry, openVaultSecret, parseLabel, parseStoredUrlPattern, VaultError, vaultStatus, type VaultEntryRow } from './vault.js';
import type { ToolCtx, ToolResult } from './agent/tools.js';
import type { ActivityKind } from './types.js';

/**
 * The Vault as a bot uses it: `vault_lookup` fills a saved login in on the bot's own screen, and
 * `request_credentials` asks the person for one in a secure form.
 *
 * How a secret gets onto the screen: it is typed, as key presses, into whatever has the keyboard on
 * the bot's display (ComputerProvider.typeSecret: xdotool reading its stdin inside the container, or
 * the Orgo typing endpoint). The model's side of the call carries a label going in and a sentence
 * coming out, never the value. A login saved for a site is only typed while a page of that site
 * holds the keyboard, which the server reads from the bot's browser itself and not from what the
 * model says the page is.
 *
 * What this cannot promise: the bot drives that computer, so after a fill it can look at a field that
 * does not mask its text or read the page's DOM. That is why every use asks the person first unless
 * they chose "Always allow".
 */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  policy?: 'needs_approval';
  impl: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/**
 * The bot's computer, as far as the Vault touches it. It is one object so a test can stand in for the
 * machine at the only point a secret leaves this process.
 */
export const vaultComputer = {
  /** The URL of the page that holds the keyboard in the bot's browser, or null when no page does. */
  async focusedPageUrl(ctx: ToolCtx): Promise<string | null> {
    const provider = providerFor(ctx.botId);
    const { screenId } = await provider.screenFor(ctx.userId, ctx.botId);
    const tabs = await listTabs(await provider.cdpUrl(ctx.botId, screenId));
    for (const tab of tabs) {
      let session: CdpSession | undefined;
      try {
        session = await CdpSession.open(tab.wsUrl, 4000);
        // The address bar, another tab and another window all leave this false, so a login is never
        // typed into a page on the strength of it merely being open.
        const page = await session.evaluate<{ focused: boolean; url: string }>('({ focused: document.hasFocus(), url: location.href })', 4000);
        if (page?.focused) return page.url;
      } catch {
        /* a tab that does not answer has no say in where the keyboard is */
      } finally {
        session?.close();
      }
    }
    return null;
  },

  async typeSecret(ctx: ToolCtx, secret: Secret): Promise<void> {
    const provider = providerFor(ctx.botId);
    const { screenId } = await provider.screenFor(ctx.userId, ctx.botId);
    await provider.typeSecret(ctx.botId, secret, screenId);
  },

  async pressKey(ctx: ToolCtx, key: 'Tab' | 'Return'): Promise<void> {
    const provider = providerFor(ctx.botId);
    const { screenId } = await provider.screenFor(ctx.userId, ctx.botId);
    const r = await provider.bash(ctx.botId, `xdotool key --clearmodifiers ${key}`, 20, screenId);
    if (r.exit_code !== 0) throw new Error(`could not press ${key}: ${r.output.trim().slice(-200)}`);
  },
};

const FILLS = ['both', 'username', 'password'] as const;
type Fill = (typeof FILLS)[number];

const origin = (url: string) => {
  try { return new URL(url).origin; } catch { return 'an unknown page'; }
};

const quoted = (labels: string[]) => labels.map((l) => `"${l}"`).join(', ');

/** Refuse unless a page of the entry's own site holds the keyboard. Entries saved for any page pass. */
async function requireOwnSite(entry: VaultEntryRow, ctx: ToolCtx, knownFocus: string | null | undefined): Promise<void> {
  if (!entry.url_pattern) return;
  const pattern = parseUrlPattern(entry.url_pattern);
  const focused = knownFocus !== undefined ? knownFocus : await vaultComputer.focusedPageUrl(ctx).catch(() => null);
  if (!focused) {
    throw new Error(`"${entry.label}" is saved for ${entry.url_pattern} only, and no page in your browser has the keyboard right now. Open that page, click the sign-in field, then call vault_lookup again. Nothing was typed.`);
  }
  if (!pattern || !urlMatches(pattern, focused)) {
    throw new Error(`"${entry.label}" is saved for ${entry.url_pattern} only, and the page in front is ${origin(focused)}. Nothing was typed.`);
  }
}

async function lookup(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const status = vaultStatus();
  if (!status.configured) throw new Error(`${status.reason} Saved logins cannot be used until the person running the server fixes that; tell the user, and do not ask them to paste a password into the chat.`);

  const label = typeof args.label === 'string' ? args.label.trim() : '';
  const givenUrl = typeof args.url === 'string' ? args.url.trim() : '';
  // With neither a label nor a URL, the page that really has the keyboard says which login is meant.
  const focus = label || givenUrl ? undefined : await vaultComputer.focusedPageUrl(ctx).catch(() => null);
  if (!label && !givenUrl && !focus) {
    return { output: 'Say which login you mean with `label`, or click the sign-in field on the page first so the Vault can tell which site it is.', summary: 'No login named' };
  }
  const match = findVaultEntry(ctx.userId, label ? { by: 'label', label } : { by: 'url', url: givenUrl || focus! });
  if (match.kind === 'several') {
    return { output: `More than one saved login fits: ${quoted(match.labels)}. Call vault_lookup again with the label you mean.`, summary: 'Several logins fit' };
  }
  if (match.kind === 'none') {
    const have = match.labels.length ? `The Vault has: ${quoted(match.labels)}.` : 'The Vault is empty.';
    return { output: `${label ? `No saved login is called "${label}".` : 'No login is saved for this page.'} ${have} If none of them is right, call request_credentials to ask the user for it in a secure form.`, summary: 'No saved login matched' };
  }

  const entry = match.entry;
  const requested = FILLS.includes(args.fill as Fill) ? (args.fill as Fill) : 'both';
  if (requested === 'username' && !entry.username) {
    return { output: `"${entry.label}" has no username saved, only a secret. Use fill "password" for it.`, summary: 'No username saved' };
  }
  const fill: Fill = requested === 'both' && !entry.username ? 'password' : requested;

  await requireOwnSite(entry, ctx, focus);

  // Opened before anything is typed: a login that cannot be read must not leave half of itself in the form.
  let secret: Secret | null = null;
  if (fill !== 'username') {
    try {
      secret = openVaultSecret(entry);
    } catch (e) {
      if (e instanceof SecretBoxTamperError) throw new Error(`The saved login "${entry.label}" could not be verified, so it was not used. Ask the user to save it again in Settings → Vault.`);
      throw e;
    }
  }
  const username = fill !== 'password' && entry.username ? new Secret(entry.username) : null;

  try {
    if (username) await vaultComputer.typeSecret(ctx, username);
    if (username && secret) await vaultComputer.pressKey(ctx, 'Tab');
    if (secret) await vaultComputer.typeSecret(ctx, secret);
    if (args.submit === true) await vaultComputer.pressKey(ctx, 'Return');
  } catch (e) {
    // The message is the computer's own words, which go back to the model: whatever it echoed is removed.
    const message = String((e as { message?: unknown } | null)?.message ?? e);
    throw new Error(`Could not type the login for "${entry.label}": ${secret ? secret.redact(message) : message}`);
  }

  const what = username && secret ? 'username and password' : username ? 'username' : 'secret';
  return {
    output: `Typed the ${what} for "${entry.label}" into the focused field${args.submit === true ? ' and pressed Enter' : ''}. The values were not given to you and are not in this conversation; do not try to read them back. Check the page to see whether the sign-in went through.`,
    summary: `Filled in "${entry.label}"`,
  };
}

async function requestCredentials(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const status = vaultStatus();
  if (!status.configured) {
    return { output: `${status.reason} There is no safe way to collect a login until that is fixed: tell the user, and do not ask them to paste a password into the chat.`, summary: 'Vault is off' };
  }
  let label: string;
  let urlPattern: string | null = null;
  try {
    label = parseLabel(args.label);
    // A page address names its site; the path and query of one sign-in page should not narrow the login.
    if (typeof args.url === 'string' && args.url.trim()) urlPattern = parseStoredUrlPattern(/^https?:\/\//i.test(args.url.trim()) ? origin(args.url.trim()) : args.url);
  } catch (e) {
    if (e instanceof VaultError) return { output: e.message, summary: 'Not asked' };
    throw e;
  }
  const secretName = (typeof args.secret_name === 'string' ? args.secret_name : '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Password';
  const fields: SecureFormField[] = [
    ...(args.username === false ? [] : [{ key: 'username' as const, label: 'Username' }]),
    { key: 'secret' as const, label: secretName },
  ];
  appendRow(ctx.botId, 'card', {
    type: 'card', card: 'secure-form', label, fields, status: 'pending',
    reason: String(args.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    ...(urlPattern ? { urlPattern } : {}),
  });
  return {
    output: `A secure form for "${label}" is in front of the user. Stop here; you will be told when they have filled it in. You will never see what they type: afterwards, click the sign-in field and call vault_lookup to have it typed for you.`,
    summary: `Asked for "${label}"`,
    endTurn: true,
  };
}

export const VAULT_TOOLS: ToolDef[] = [
  {
    name: 'vault_lookup',
    description: 'Sign in with a login the user saved in their Vault, without ever seeing it. Click the username (or password) field on your screen first, then call this: the saved username and password are typed into the focused field for you, with Tab between them. You get a confirmation, never the values. Name the login with `label`, or pass no label to use the one saved for the page that has the keyboard. A login saved for a site is only typed on that site. For a sign-in that asks for the username and the password on separate pages, call it once with fill "username" and once with fill "password".',
    parameters: obj({
      label: { type: 'string', description: 'The name the login is saved under, e.g. "AWS Console".' },
      url: { type: 'string', description: 'The address of the sign-in page, to find the login saved for that site.' },
      fill: { type: 'string', enum: [...FILLS], description: 'What to type: both (default), only the username, or only the password/secret.' },
      submit: { type: 'boolean', description: 'Press Enter after typing. Default false.' },
    }),
    activity: 'on_its_computer',
    // The approval card titles itself from the words after the colon: "Allow <Bot> to use a saved login?"
    label: 'Vault: use a saved login',
    policy: 'needs_approval',
    impl: lookup,
  },
  {
    name: 'request_credentials',
    description: 'Ask the user for a login or secret you need (a password, an API key, a one-time code) in a secure form. What they type goes straight to their Vault: it never appears in the chat and you never see it. Ends your turn; when they have filled it in you are told, and vault_lookup types it for you. Never ask the user to paste a password or key into the chat instead.',
    parameters: obj({
      label: { type: 'string', description: 'What the login is for, e.g. "AWS Console". The user sees it, and it becomes the name you pass to vault_lookup.' },
      reason: { type: 'string', description: 'One sentence the user sees: why you need it.' },
      url: { type: 'string', description: 'The sign-in page it is for. The saved login is then only ever typed on that site.' },
      username: { type: 'boolean', description: 'Also ask for a username. Default true; false for a lone API key or code.' },
      secret_name: { type: 'string', description: 'What to call the secret on the form. Default "Password".' },
    }, ['label', 'reason']),
    activity: 'waiting_for_you',
    label: 'Asking for a login',
    impl: requestCredentials,
  },
];
