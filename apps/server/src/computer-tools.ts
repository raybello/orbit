import fs from 'node:fs/promises';
import path from 'node:path';
import { hrtime } from 'node:process';
import { env } from './env.js';
import { providerFor } from './computer-provider-registry.js';
import type { ToolCtx, ToolResult } from './agent/tools.js';
import type { ActivityKind } from './types.js';

/**
 * Computer control as app tools, so a Bot drives the desktop it actually has.
 *
 * Hermes' own `computer_use` toolset acts on the display of the process running the agent — on a
 * machine that is not the Bot's computer (and never is on macOS, where there is no X server), so a
 * container Bot could not use it. These tools go through the ComputerProvider instead: the same
 * xdotool commands run inside the Bot's container, or on the shared Orgo computer, and nothing here
 * depends on where this server runs.
 */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  policy?: 'needs_approval';
  impl: (args: any, ctx: ToolCtx) => Promise<ToolResult>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const LIBRARY = () => `${env.botDataDir}/files`;

/** A screen to act on: boot the computer, make sure the display is up, and return its id. */
async function screen(ctx: ToolCtx): Promise<{ screenId: string; display: number }> {
  const provider = providerFor(ctx.botId);
  const { screenId } = await provider.screenFor(ctx.userId, ctx.botId);
  const display = Number(screenId.replace(/^screen-/, '')) || 1;
  return { screenId, display };
}

async function run(ctx: ToolCtx, command: string, timeoutSec = 30): Promise<{ output: string; code: number; display: number }> {
  const { screenId, display } = await screen(ctx);
  const r = await providerFor(ctx.botId).bash(ctx.botId, command, timeoutSec, screenId);
  return { output: r.output.trim(), code: r.exit_code, display };
}

const num = (v: unknown, name: string, min: number, max: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return n;
};

const BUTTONS: Record<string, number> = { left: 1, middle: 2, right: 3 };
const buttonNumber = (v: unknown) => BUTTONS[String(v ?? 'left').toLowerCase()] ?? 1;

/** xdotool keys we accept: names, with optional ctrl/alt/shift/super modifiers. */
function keyCombo(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9+_\-\[\].:,/ ]{1,60}$/.test(s)) throw new Error('key must look like "Return", "ctrl+l" or "super"');
  return s.replace(/\s+/g, ' ');
}

const screenshotDir = (botId: string) => path.join(LIBRARY(), botId, 'screenshots');

export const COMPUTER_TOOLS: ToolDef[] = [
  {
    name: 'computer_windows',
    description: 'List the windows open on your computer: id, position, size and title. Use it to see what is on screen before clicking, or to check that an action worked. Your own browser also answers at its DevTools address for web work.',
    parameters: obj({}),
    activity: 'on_its_computer',
    label: 'Looking at its screen',
    impl: async (_a, ctx) => {
      const r = await run(ctx, 'wmctrl -lpGx 2>/dev/null || xprop -root _NET_CLIENT_LIST 2>/dev/null', 20);
      const lines = r.output.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return { output: 'No windows are open on this computer.', summary: 'Screen is empty' };
      const windows = lines.slice(0, 40).map((l) => {
        const p = l.split(/\s+/);
        if (p.length >= 8 && /^0x[0-9a-f]+$/i.test(p[0])) {
          return { id: p[0], desktop: p[1], pid: p[2], x: Number(p[3]), y: Number(p[4]), width: Number(p[5]), height: Number(p[6]), title: p.slice(8).join(' ') };
        }
        return { raw: l };
      });
      return { output: JSON.stringify({ display: `:${r.display}`, windows }), summary: `${windows.length} window(s)` };
    },
  },
  {
    name: 'computer_screenshot',
    description: 'Take a picture of your computer screen and save it in your Library, so the user can see what you are looking at. Returns the file path; the image appears in your next message.',
    parameters: obj({}),
    activity: 'on_its_computer',
    label: 'Taking a screenshot',
    impl: async (_a, ctx) => {
      const provider = providerFor(ctx.botId);
      const shot = await provider.screenshot(ctx.botId, await provider.screenIdFor(ctx.botId) ?? '');
      if (!shot) return { output: 'The screen did not answer, so there is no screenshot.' };
      const dir = screenshotDir(ctx.botId);
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `screen-${stamp}.${shot.mime === 'image/png' ? 'png' : 'jpg'}`;
      await fs.writeFile(path.join(dir, name), shot.data);
      // The marker makes the app attach the picture to the reply, so the person sees it in the chat
      // instead of having to open the Library.
      const rel = `screenshots/${name}`;
      return {
        output: `Screenshot saved as ${rel} in your Library.\n[hq-file:${rel}|${name}|${shot.mime}]`,
        summary: 'Took a screenshot',
      };
    },
  },
  {
    name: 'computer_click',
    description: 'Click on your computer screen at pixel coordinates (x from the left, y from the top). Use computer_windows first to find where things are. Buttons: left (default), right, middle.',
    parameters: obj({
      x: { type: 'number', description: 'Pixels from the left edge' },
      y: { type: 'number', description: 'Pixels from the top edge' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      count: { type: 'number', description: 'How many clicks (2 = double-click), default 1' },
    }, ['x', 'y']),
    activity: 'on_its_computer',
    label: 'Clicking on its screen',
    impl: async (a, ctx) => {
      const x = num(a.x, 'x', 0, 20000);
      const y = num(a.y, 'y', 0, 20000);
      const count = num(a.count ?? 1, 'count', 1, 3);
      const button = buttonNumber(a.button);
      const r = await run(ctx, `xdotool mousemove --sync ${x} ${y} click --repeat ${count} --delay 120 ${button}`, 20);
      if (r.code !== 0) return { output: `Click failed: ${r.output.slice(-300)}` };
      return { output: `Clicked ${count === 1 ? '' : `${count}× `}(button ${button}) at ${x},${y}.`, summary: `Clicked at ${x},${y}` };
    },
  },
  {
    name: 'computer_drag',
    description: 'Drag from one point to another with the left mouse button (selecting text, moving a window, sliders).',
    parameters: obj({
      from_x: { type: 'number' }, from_y: { type: 'number' },
      to_x: { type: 'number' }, to_y: { type: 'number' },
    }, ['from_x', 'from_y', 'to_x', 'to_y']),
    activity: 'on_its_computer',
    label: 'Dragging on its screen',
    impl: async (a, ctx) => {
      const x1 = num(a.from_x, 'from_x', 0, 20000), y1 = num(a.from_y, 'from_y', 0, 20000);
      const x2 = num(a.to_x, 'to_x', 0, 20000), y2 = num(a.to_y, 'to_y', 0, 20000);
      const r = await run(ctx, `xdotool mousemove --sync ${x1} ${y1} mousedown 1 mousemove --sync ${x2} ${y2} mouseup 1`, 20);
      if (r.code !== 0) return { output: `Drag failed: ${r.output.slice(-300)}` };
      return { output: `Dragged from ${x1},${y1} to ${x2},${y2}.`, summary: 'Dragged on screen' };
    },
  },
  {
    name: 'computer_type',
    description: 'Type text into whatever has focus on your computer (click the field first). Works in any app on the screen.',
    parameters: obj({ text: { type: 'string', description: 'The text to type' } }, ['text']),
    activity: 'on_its_computer',
    label: 'Typing on its screen',
    impl: async (a, ctx) => {
      const text = String(a.text ?? '');
      if (!text) return { output: 'Nothing to type.' };
      if (text.length > 4000) return { output: 'That is too much text to type in one go; split it up.' };
      const { screenId } = await screen(ctx);
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      // Text goes over base64 so quotes, newlines and shell metacharacters survive untouched.
      const cmd = `printf %s '${b64}' | base64 -d | xdotool type --clearmodifiers --delay 12 --file -`;
      const r = await providerFor(ctx.botId).bash(ctx.botId, cmd, 120, screenId);
      if (r.exit_code !== 0) return { output: `Typing failed: ${r.output.trim().slice(-300)}` };
      return { output: `Typed ${text.length} character(s).`, summary: `Typed ${text.length} characters` };
    },
  },
  {
    name: 'computer_key',
    description: 'Press a key or a key combination on your computer: "Return", "Escape", "Tab", "BackSpace", "ctrl+l", "ctrl+shift+t", "super", "alt+F4".',
    parameters: obj({ key: { type: 'string', description: 'Key name, with modifiers joined by +' } }, ['key']),
    activity: 'on_its_computer',
    label: 'Pressing keys on its screen',
    impl: async (a, ctx) => {
      const combo = keyCombo(a.key);
      const r = await run(ctx, `xdotool key --clearmodifiers -- ${JSON.stringify(combo)}`, 20);
      if (r.code !== 0) return { output: `Key press failed: ${r.output.slice(-300)}` };
      return { output: `Pressed ${combo}.`, summary: `Pressed ${combo}` };
    },
  },
  {
    name: 'computer_scroll',
    description: 'Scroll the wheel on your computer: up, down, left or right, a number of wheel steps. Optional x,y to move the pointer there first.',
    parameters: obj({
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number', description: 'Wheel steps, default 3' },
      x: { type: 'number' }, y: { type: 'number' },
    }, ['direction']),
    activity: 'on_its_computer',
    label: 'Scrolling on its screen',
    impl: async (a, ctx) => {
      const dir = String(a.direction ?? 'down');
      const button = { up: 4, down: 5, left: 6, right: 7 }[dir as 'up' | 'down' | 'left' | 'right'] ?? 5;
      const steps = num(a.amount ?? 3, 'amount', 1, 50);
      const move = a.x !== undefined && a.y !== undefined
        ? `mousemove --sync ${num(a.x, 'x', 0, 20000)} ${num(a.y, 'y', 0, 20000)} `
        : '';
      const r = await run(ctx, `xdotool ${move}click --repeat ${steps} --delay 40 ${button}`, 20);
      if (r.code !== 0) return { output: `Scroll failed: ${r.output.slice(-300)}` };
      return { output: `Scrolled ${dir} ${steps} step(s).`, summary: `Scrolled ${dir}` };
    },
  },
  {
    name: 'computer_shell',
    description: 'Run a shell command on your computer (as the desktop user, with DISPLAY set). Use it for things the screen tools cannot do: inspecting files, launching an app by name, window manager commands.',
    parameters: obj({
      command: { type: 'string', description: 'The shell command to run' },
      timeout_seconds: { type: 'number', description: 'Default 60, at most 180' },
    }, ['command']),
    activity: 'on_its_computer',
    label: 'Running a command on its computer',
    impl: async (a, ctx) => {
      const command = String(a.command ?? '').trim();
      if (!command) return { output: 'No command given.' };
      const timeoutSec = Math.min(180, Math.max(5, Number(a.timeout_seconds ?? 60) || 60));
      const started = hrtime.bigint();
      const r = await run(ctx, command, timeoutSec);
      const ms = Number((hrtime.bigint() - started) / 1_000_000n);
      const body = r.output.length > 8000 ? `${r.output.slice(0, 8000)}\n… (truncated)` : r.output;
      return { output: `${body || '(no output)'}\n\n(exit ${r.code}, ${ms} ms)`, summary: r.code === 0 ? 'Command finished' : `Command failed (exit ${r.code})` };
    },
  },
];
