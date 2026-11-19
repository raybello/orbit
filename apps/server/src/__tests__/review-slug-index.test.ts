import { cleanupTmpEnv } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

const { GOOGLE_ACTIONS } = await import('../domain/google-actions.js');
const { adapterFor } = await import('../review/index.js');
const { reviewSlugs } = await import('../review/slug-index.js');
after(cleanupTmpEnv);

test('every action that asks first and names a card gets that card\'s adapter', () => {
  for (const a of GOOGLE_ACTIONS.values()) {
    const expected = a.kind === 'review' ? a.card : undefined;
    assert.equal(adapterFor(a.slug)?.kind, expected, a.slug);
    assert.equal(adapterFor(a.slug.toLowerCase())?.kind, expected, `${a.slug} lower-case`);
  }
});

test('actions that run without asking get no review card, even when the catalogue names one', () => {
  for (const slug of ['GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_UPDATE_DRAFT', 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1', 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN']) {
    assert.equal(adapterFor(slug), undefined, slug);
  }
  assert.ok(reviewSlugs('email').includes('GMAIL_SEND_DRAFT'));
  assert.equal(reviewSlugs('email').includes('GMAIL_CREATE_EMAIL_DRAFT'), false);
});
