import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RULE_PRESETS, type Bot, type BotRule, type CreateRuleRequest, type RuleLogEntry, type UpdateRuleRequest } from '@orbit/contracts';

/**
 * The panel only reaches the network through `rulesApi`, so the mock is a small server: it keeps the
 * bot's rules and answers the way the real routes do. A test then asserts what the person sees after
 * the panel has read the list back, not which call the panel happened to make.
 */
const server = vi.hoisted(() => ({ rules: [] as BotRule[], log: [] as RuleLogEntry[], failNext: null as string | null, n: 0 }));

vi.mock('../lib/rulesApi', () => ({
  rulesApi: {
    list: vi.fn(async () => ({ rules: [...server.rules], log: [...server.log] })),
    create: vi.fn(async (botId: string, body: CreateRuleRequest) => {
      if (server.failNext) { const m = server.failNext; server.failNext = null; throw new Error(m); }
      const preset = 'preset' in body ? RULE_PRESETS.find((p) => p.id === body.preset)! : null;
      const rule: BotRule = preset
        ? { id: `rule_${++server.n}`, botId, description: preset.description, pattern: preset.pattern, action: preset.action, preset: preset.id, createdAt: server.n }
        : { id: `rule_${++server.n}`, botId, ...(body as Extract<CreateRuleRequest, { description: string }>), preset: null, createdAt: server.n };
      server.rules.push(rule);
      return { rule };
    }),
    update: vi.fn(async (_botId: string, ruleId: string, patch: UpdateRuleRequest) => {
      server.rules = server.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r));
      return { rule: server.rules.find((r) => r.id === ruleId)! };
    }),
    remove: vi.fn(async (_botId: string, ruleId: string) => {
      server.rules = server.rules.filter((r) => r.id !== ruleId);
      return { ok: true as const };
    }),
  },
}));

import { RulesPanel } from '../components/RulesPanel';

const bot = { id: 'bot_1', name: 'Atlas' } as Bot;

const sw = (name: string) => screen.getByRole('switch', { name }) as HTMLButtonElement;
const isOn = (name: string) => sw(name).getAttribute('aria-checked') === 'true';
/** The Ask me / Block / Log control of one rule. */
const actionOf = (description: string) => screen.getByRole('radiogroup', { name: `What “${description}” does` });
const chosen = (group: HTMLElement) => within(group).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')?.textContent;

async function renderPanel() {
  render(<RulesPanel bot={bot} />);
  await waitFor(() => expect(sw('Ask before sending messages').disabled).toBe(false));
}

const fillRule = (description: string) => {
  fireEvent.click(screen.getByRole('button', { name: /New rule/ }));
  fireEvent.change(screen.getByLabelText('Rule description'), { target: { value: description } });
};

beforeEach(() => {
  server.rules = [];
  server.log = [];
  server.failNext = null;
  server.n = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('common rules', () => {
  it('offers every preset, switched off for a bot with no rules', async () => {
    await renderPanel();
    for (const p of RULE_PRESETS) expect(isOn(p.description)).toBe(false);
    expect(screen.getByText('Every shell command on its computer')).toBeTruthy();
    expect(screen.getByText('Connected-app tools that delete')).toBeTruthy();
  });

  it('switching a preset on adds its rule, with the action the preset starts with', async () => {
    await renderPanel();
    fireEvent.click(sw('Log all file writes'));
    await waitFor(() => expect(isOn('Log all file writes')).toBe(true));
    expect(chosen(actionOf('Log all file writes'))).toBe('Log');
    expect(server.rules.map((r) => r.preset)).toEqual(['log-file-writes']);
    expect(isOn('Ask before deleting anything')).toBe(false);
  });

  it('switching a preset off removes its rule', async () => {
    await renderPanel();
    fireEvent.click(sw('Ask before running shell commands'));
    await waitFor(() => expect(isOn('Ask before running shell commands')).toBe(true));
    fireEvent.click(sw('Ask before running shell commands'));
    await waitFor(() => expect(isOn('Ask before running shell commands')).toBe(false));
    expect(server.rules).toEqual([]);
  });

  it('a preset that is on can be made to block instead of ask', async () => {
    await renderPanel();
    fireEvent.click(sw('Ask before deleting anything'));
    await waitFor(() => expect(isOn('Ask before deleting anything')).toBe(true));
    fireEvent.click(within(actionOf('Ask before deleting anything')).getByRole('radio', { name: 'Block' }));
    await waitFor(() => expect(chosen(actionOf('Ask before deleting anything'))).toBe('Block'));
    expect(server.rules[0].action).toBe('block');
  });

  it('says why when the server refuses a change, and leaves the switch off', async () => {
    await renderPanel();
    server.failNext = 'A Bot can have at most 50 rules.';
    fireEvent.click(sw('Ask before sending messages'));
    expect((await screen.findByRole('alert')).textContent).toBe('A Bot can have at most 50 rules.');
    expect(isOn('Ask before sending messages')).toBe(false);
  });
});

describe('rules the person writes', () => {
  it('a shell rule is saved as the expression that was typed', async () => {
    await renderPanel();
    fillRule('Never force-push');
    fireEvent.click(screen.getByRole('radio', { name: 'Shell commands' }));
    fireEvent.change(screen.getByLabelText('Command pattern'), { target: { value: 'git push .*--force' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'What the rule does' })).getByRole('radio', { name: 'Block' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(await screen.findByText('Never force-push')).toBeTruthy();
    expect(screen.getByText('Shell commands matching git push .*--force')).toBeTruthy();
    expect(server.rules).toHaveLength(1);
    expect(server.rules[0]).toMatchObject({
      description: 'Never force-push', action: 'block', preset: null,
      pattern: { kind: 'computer-shell', matchRegex: 'git push .*--force' },
    });
  });

  it('an expression that does not compile is caught before anything is sent', async () => {
    await renderPanel();
    fillRule('Broken');
    fireEvent.click(screen.getByRole('radio', { name: 'Shell commands' }));
    fireEvent.change(screen.getByLabelText('Command pattern'), { target: { value: '(' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    expect((await screen.findByRole('alert')).textContent).toBe('That is not a valid regular expression.');
    expect(server.rules).toEqual([]);
  });

  it('a rule needs a description', async () => {
    await renderPanel();
    fillRule('   ');
    fireEvent.click(screen.getByRole('radio', { name: 'Everything' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Say what the rule is for.');
    expect(server.rules).toEqual([]);
  });

  it('tool names are split into a list, and action kinds can be limited to apps', async () => {
    await renderPanel();
    fillRule('No email');
    fireEvent.change(screen.getByLabelText('Tool names'), { target: { value: 'GMAIL_SEND_EMAIL, OUTLOOK_*' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await screen.findByText('Connected-app tools: GMAIL_SEND_EMAIL, OUTLOOK_*');

    fillRule('Careful on socials');
    fireEvent.click(screen.getByRole('radio', { name: 'Connected-app actions' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Creates or sends' }));
    fireEvent.change(screen.getByLabelText('Apps'), { target: { value: 'twitter linkedin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await screen.findByText('Connected-app tools that create or send in twitter, linkedin');

    expect(server.rules.map((r) => r.pattern)).toEqual([
      { kind: 'composio-tool', tools: ['GMAIL_SEND_EMAIL', 'OUTLOOK_*'] },
      { kind: 'composio-hint', hints: ['createHint'], toolkits: ['twitter', 'linkedin'] },
    ]);
  });

  it('an existing rule opens in the editor with what it already says, and saves the change', async () => {
    server.rules = [{ id: 'rule_9', botId: bot.id, description: 'No sudo', pattern: { kind: 'computer-shell', matchRegex: '^sudo ' }, action: 'ask', preset: null, createdAt: 1 }];
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Edit No sudo' }));
    const pattern = screen.getByLabelText('Command pattern') as HTMLInputElement;
    expect(pattern.value).toBe('^sudo ');
    fireEvent.change(pattern, { target: { value: '\\bsudo\\b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    await screen.findByText('Shell commands matching \\bsudo\\b');
    expect(server.rules[0].pattern).toEqual({ kind: 'computer-shell', matchRegex: '\\bsudo\\b' });
    expect(server.rules[0].id).toBe('rule_9');
  });

  it('a deleted rule leaves the list once the person confirms', async () => {
    server.rules = [{ id: 'rule_9', botId: bot.id, description: 'No sudo', pattern: { kind: 'always' }, action: 'ask', preset: null, createdAt: 1 }];
    await renderPanel();
    fireEvent.click(screen.getByTitle('Delete'));
    expect(server.rules).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('No sudo')).toBeNull());
    expect(server.rules).toEqual([]);
  });
});

describe('recent matches', () => {
  const entry = (over: Partial<RuleLogEntry>): RuleLogEntry => ({
    id: 1, botId: bot.id, ruleId: 'rule_1', ruleDescription: 'Ask before sending messages', action: 'ask',
    tool: 'GMAIL_SEND_EMAIL', detail: 'GMAIL_SEND_EMAIL', outcome: 'ran', createdAt: Date.now(), ...over,
  });

  it('says so when nothing has matched yet', async () => {
    await renderPanel();
    expect(screen.getByText(/Nothing yet\. When a rule matches something Atlas tries to do/)).toBeTruthy();
  });

  it('reads each entry by what the rule does and what became of the call', async () => {
    server.log = [
      entry({ id: 5, action: 'block', outcome: 'blocked', ruleDescription: 'No recursive deletes', tool: 'computer_shell', detail: 'rm -rf /tmp/build' }),
      entry({ id: 4, action: 'ask', outcome: 'denied' }),
      entry({ id: 3, action: 'ask', outcome: 'ran' }),
      entry({ id: 2, action: 'ask', outcome: 'expired' }),
      entry({ id: 1, action: 'log', outcome: 'ran', ruleDescription: 'Log all file writes', tool: 'GOOGLEDRIVE_EDIT_FILE', detail: 'GOOGLEDRIVE_EDIT_FILE' }),
    ];
    await renderPanel();
    const labels = [...document.querySelectorAll('.rule-log__outcome')].map((el) => el.textContent);
    expect(labels).toEqual(['Blocked', 'Not allowed', 'Allowed', 'Not answered', 'Logged']);
    expect(screen.getByText(/rm -rf \/tmp\/build/)).toBeTruthy();
    expect(screen.getByText('No recursive deletes')).toBeTruthy();
  });
});
