import assert from 'node:assert/strict';
import test from 'node:test';
import { hasNativeWindowControls } from './desktop-shell.js';

// The three states that matter: a real browser (draw the dots), the desktop app (the OS
// draws them, so we must not), and a page that marked itself explicitly.

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orbit/0.1.0 Chrome/138.0.0.0 Electron/36.9.5 Safari/537.36';

test('a browser draws its own window dots', () => {
  assert.equal(hasNativeWindowControls({ userAgent: CHROME_UA }), false);
});

test('the Electron desktop app relies on the native controls', () => {
  assert.equal(hasNativeWindowControls({ userAgent: ELECTRON_UA }), true);
});

test('the Electron UA is recognised regardless of position or case', () => {
  assert.equal(hasNativeWindowControls({ userAgent: 'electron/36.9.5' }), true);
  assert.equal(hasNativeWindowControls({ userAgent: 'Mozilla/5.0 Electron/1.0 Orbit' }), true);
});

test('a document marker wins even when the UA looks like a browser', () => {
  assert.equal(hasNativeWindowControls({ userAgent: CHROME_UA, marked: true }), true);
});

test('an unknown environment falls back to drawing the dots', () => {
  assert.equal(hasNativeWindowControls({}), false);
  assert.equal(hasNativeWindowControls({ userAgent: '' }), false);
});
