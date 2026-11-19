// Capture the screenshots the guide shows for the skill library, from a running app.
//
//   ORBIT_LINK=<sign-in link> QUILL="Quill" node apps/web/scripts/capture-skills-screenshots.mjs
//
// ORBIT_LINK is a one-time owner sign-in link on the web app (scripts/sign-in-link.sh prints one).
// The app needs a few skills in its library: one from GitHub (pdf), one a Bot wrote, one only some
// Bots have, and a Bot named $QUILL that has used /meeting-notes in its chat. CHROMIUM may name a
// Chromium binary to use instead of the one this Playwright version installs.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const link = process.env.ORBIT_LINK;
if (!link) throw new Error('Set ORBIT_LINK to a sign-in link (scripts/sign-in-link.sh).');
const quill = process.env.QUILL ?? 'Quill';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/screenshots/skills');

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const shot = async (name, clip) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `${name}.png`), ...(clip ? { clip } : {}) });
  console.log(`  ✓ ${name}.png`);
};

await page.goto(link);
await page.waitForSelector('[aria-label^="Message "]');
// A fresh browser opens with a first-run dialog; close whatever is open.
for (let i = 0; i < 3 && (await page.locator('.modal-scrim').count()); i++) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

await page.locator('[data-section="skills"]').click();
await page.getByRole('button', { name: /^\/pdf/ }).click();
await page.getByRole('link', { name: /anthropics\/skills/ }).waitFor();
await shot('library-github-skill');

await page.getByRole('button', { name: /^\/weekly-report/ }).click();
await shot('library-only-some-bots');

await page.getByRole('button', { name: 'Add skill' }).click();
await page.getByRole('textbox', { name: 'Skill name' }).fill('standup-summary');
await page.getByRole('textbox', { name: 'SKILL.md content' }).fill('---\ndescription: Turn a day of chat into a three-line standup\n---\n\n# Steps\n\n1. Read today\'s messages.\n2. Write Yesterday, Today and Blockers, one line each.\n');
await shot('add-write');

await page.getByRole('tab', { name: 'From GitHub' }).click();
await page.getByRole('textbox', { name: 'GitHub repository' }).fill('https://github.com/anthropics/skills');
await page.getByRole('button', { name: 'Check repository' }).click();
await page.getByRole('radiogroup', { name: 'Skill to install' }).waitFor({ timeout: 60_000 });
await shot('add-github');
await page.getByRole('button', { name: 'Cancel' }).click();

await page.locator('[data-section="chat"]').click();
await page.getByRole('button', { name: new RegExp(`^${quill}`) }).first().click();
const box = page.getByRole('textbox', { name: `Message ${quill}` });
await box.click();
await box.fill('');
await box.type('/');
await page.getByRole('listbox', { name: 'Skills' }).waitFor();
await shot('composer-suggest');
await box.press('Escape');
await box.fill('');

await page.getByText('## Decisions').or(page.getByRole('heading', { name: 'Decisions' })).first().scrollIntoViewIfNeeded();
await shot('chat-skill-used');

await browser.close();
