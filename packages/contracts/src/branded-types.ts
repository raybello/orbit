/**
 * Branded ids for the server's core modules.
 *
 * A brand is a compile-time tag, not a runtime value: `asBotId('bot_x')` returns the same string, and
 * nothing is checked when it runs. That is the whole point — these types stop a core function from
 * being handed a user id where a bot id belongs, at zero runtime cost and without rewriting the wire
 * contracts (a plain `string` still flows in from JSON and SQL).
 *
 * Deliberately not applied to the contract interfaces in this package: `Bot.id` stays `string` so the
 * web, desktop and mobile clients keep compiling unchanged.
 */

export type BotId = string & { readonly __brand: 'BotId' };
export type UserId = string & { readonly __brand: 'UserId' };
export type CardId = string & { readonly __brand: 'CardId' };
export type ScreenId = string & { readonly __brand: 'ScreenId' };
export type ArtifactId = string & { readonly __brand: 'ArtifactId' };

/**
 * Unchecked cast. Valid only where the value came from the database (a row already scoped to a bot)
 * or from a parsed request (a session user, a URL param the router matched) — never for a value that
 * still has to be checked against something.
 */
export const asBotId = (value: string): BotId => value as BotId;

/** Unchecked cast; see {@link asBotId}. Use for ids read from `users`, a session or a parsed body. */
export const asUserId = (value: string): UserId => value as UserId;

/** Unchecked cast; see {@link asBotId}. Cards have no table of their own, so this is usually a row seq. */
export const asCardId = (value: string): CardId => value as CardId;

/** Unchecked cast; see {@link asBotId}. Use for ids read from a `screens` / `computer_screens` row. */
export const asScreenId = (value: string): ScreenId => value as ScreenId;

/** Unchecked cast; see {@link asBotId}. Use for an id the artifact tool minted or a row's args already hold. */
export const asArtifactId = (value: string): ArtifactId => value as ArtifactId;
