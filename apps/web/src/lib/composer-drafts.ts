/**
 * What each Bot's composer holds while it is off screen, plus the one way to fill it from outside:
 * text a deep link carries, which goes in only while the composer is empty, so nothing the person
 * typed is ever replaced. Nothing here sends.
 */

const drafts = new Map<string, string>();
const listeners = new Set<(botId: string) => void>();

export const draftFor = (botId: string): string => drafts.get(botId) ?? '';

export function saveDraft(botId: string, text: string) {
  if (text) drafts.set(botId, text);
  else drafts.delete(botId);
}

/** Put `text` in the Bot's composer unless something is already typed there. True when it went in. */
export function prefillDraft(botId: string, text: string): boolean {
  if (!text || draftFor(botId).trim()) return false;
  drafts.set(botId, text);
  for (const listener of listeners) listener(botId);
  return true;
}

/** A mounted composer listens so a prefill for the Bot it shows appears at once. */
export function onDraftPrefill(listener: (botId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
