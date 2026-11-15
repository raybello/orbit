import assert from 'node:assert/strict';
import test from 'node:test';
import { IMAGE_READY, RESULTS_READY, SEARCH_ENGINES, VIDEO_READY, extractScript, imageScript, pageTextScript, searchUrl, videoScript } from '../computer-research-scripts.js';

/**
 * The page scripts are code that runs in another process, where a typo surfaces as "the page did not
 * load" 30 seconds later. Parsing every one of them here turns that into a failing test.
 *
 * `new Function` compiles without running, which is exactly the check: the script must be valid
 * JavaScript. A selector spliced into an expression as bare text (#search) fails right here.
 */
const parses = (source: string, what: string) => {
  assert.doesNotThrow(() => new Function(source), `${what} does not parse: ${source.slice(0, 120)}`);
};

test('every search engine has a URL, a ready predicate and an extractor that parse', () => {
  for (const engine of SEARCH_ENGINES) {
    const url = searchUrl(engine, 'open source llm & agents');
    assert.match(url, /^https:\/\//, `${engine} search url`);
    assert.ok(url.includes(encodeURIComponent('open source llm & agents')), `${engine} encodes the query`);
    parses(RESULTS_READY[engine], `${engine} ready predicate`);
    parses(extractScript(engine, 8), `${engine} extractor`);
  }
});

test('image, video and page scripts parse and carry the requested counts', () => {
  parses(IMAGE_READY, 'image ready predicate');
  parses(VIDEO_READY, 'video ready predicate');

  const images = imageScript(4);
  parses(images, 'image script');
  assert.match(images, /const count = 4/);

  const videos = videoScript(6);
  parses(videos, 'video script');
  assert.match(videos, /const limit = 6/);

  parses(pageTextScript(1234), 'page text script');
});

test('a ready predicate is a boolean expression, not a selector', () => {
  // The bug this guards: Boolean(#search) is a syntax error, and the retry loop reported it as a
  // page that never loaded. Every predicate must compile on its own.
  for (const engine of SEARCH_ENGINES) {
    assert.doesNotThrow(() => new Function(`return (${RESULTS_READY[engine]});`), `${engine} is an expression`);
  }
});
