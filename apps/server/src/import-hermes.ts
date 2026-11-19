import { importHostHermes } from './hermes-import.js';

/**
 * `node dist/import-hermes.js <source home> <primary home>`: the desktop app runs this once in a
 * throwaway container, with the person's Hermes home mounted read-only, before the stack starts.
 */
const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: import-hermes <source hermes home> <primary home>');
  process.exit(2);
}
console.log(`[import-hermes] ${importHostHermes(src, dest)}`);
