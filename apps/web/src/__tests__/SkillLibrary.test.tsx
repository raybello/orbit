import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, LibrarySkill } from '@orbit/contracts';

vi.mock('../lib/configApi', () => ({
  configApi: {
    skillLibrary: vi.fn(),
    createSkill: vi.fn(),
    updateSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillAccess: vi.fn(),
    inspectGithubSkill: vi.fn(),
    installGithubSkill: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({
  api: { skills: vi.fn(async () => ({ skills: [] })), setSkillEnabled: vi.fn(), send: vi.fn(async () => ({})) },
  ApiError: class ApiError extends Error {},
}));

import { configApi } from '../lib/configApi';
import { SkillsView } from '../components/SkillsView';
import { slashQuery, useSkillSuggest } from '../components/SkillSuggest';
import { useStore } from '../store';
import { useRef, useState } from 'react';

const api = vi.mocked(configApi);
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

const skill = (over: Partial<LibrarySkill>): LibrarySkill => ({
  id: 'skl_1', name: 'weekly-report', description: 'Every Monday report', content: '---\nname: weekly-report\ndescription: Every Monday report\n---\n\n1. Pull the numbers.\n',
  availability: 'all', source: { type: 'manual' }, createdBy: { kind: 'user', id: 'u1', name: 'Ada' }, files: [],
  createdAt: 1, updatedAt: Date.now(),
  bots: [{ botId: 'b_atlas', botName: 'Atlas', allowed: true }, { botId: 'b_quill', botName: 'Quill', allowed: true }],
  ...over,
});

const PDF = skill({
  id: 'skl_pdf', name: 'pdf', description: 'Read and fill PDF forms',
  source: { type: 'github', repo: 'acme/skills', ref: 'main', commit: SHA, path: 'skills/pdf', url: `https://github.com/acme/skills/tree/${SHA}/skills/pdf` },
  files: [{ path: 'scripts/fill.py', size: 15 }],
  bots: [{ botId: 'b_atlas', botName: 'Atlas', allowed: true }, { botId: 'b_quill', botName: 'Quill', allowed: false }],
});

beforeEach(() => {
  useStore.setState({ bots: [{ id: 'b_atlas', name: 'Atlas', isPrimary: true }, { id: 'b_quill', name: 'Quill', isPrimary: false }] as unknown as Bot[] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Skills → Library', () => {
  it('lists every skill with where it came from and who has it, and shows a GitHub skill\'s exact commit', async () => {
    api.skillLibrary.mockResolvedValue({ skills: [PDF, skill({})] });
    render(<SkillsView />);
    expect(await screen.findByRole('button', { name: /^\/pdf/ })).toBeTruthy();
    expect(screen.getByText('1 of 2 Bots')).toBeTruthy();
    expect(document.querySelectorAll('.skills-row__count')[1].textContent).toBe('Every Bot');
    const link = screen.getByRole('link', { name: 'acme/skills/skills/pdf' });
    expect(link.getAttribute('href')).toBe(`https://github.com/acme/skills/tree/${SHA}/skills/pdf`);
    expect(screen.getByText('abcdef1')).toBeTruthy();
    expect(screen.getByText('scripts/fill.py')).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'pdf for Quill' })).getAttribute('aria-checked')).toBe('false');
  });

  it('turns a skill on for one Bot', async () => {
    api.skillLibrary.mockResolvedValue({ skills: [PDF] });
    api.setSkillAccess.mockResolvedValue({ skill: { ...PDF, bots: PDF.bots.map((b) => ({ ...b, allowed: true })) } });
    render(<SkillsView />);
    fireEvent.click(await screen.findByRole('switch', { name: 'pdf for Quill' }));
    await waitFor(() => expect(api.setSkillAccess).toHaveBeenCalledWith('skl_pdf', 'b_quill', true));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'pdf for Quill' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('adds a written skill with a name and its SKILL.md, for only the Bots picked', async () => {
    api.skillLibrary.mockResolvedValue({ skills: [] });
    api.createSkill.mockResolvedValue({ skill: skill({ name: 'tone', availability: 'selected' }) });
    render(<SkillsView />);
    fireEvent.click(await screen.findByRole('button', { name: /Add skill/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill name' }), { target: { value: 'House Tone' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'SKILL.md content' }), { target: { value: '---\ndescription: Our tone\n---\nBe brief.' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Only the Bots I pick' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quill' }));
    fireEvent.click(document.querySelector('form.skills-form button[type=submit]')!);
    await waitFor(() => expect(api.createSkill).toHaveBeenCalledWith({ name: 'house-tone', content: '---\ndescription: Our tone\n---\nBe brief.', availability: 'selected', botIds: ['b_quill'] }));
  });

  it('checks a GitHub repository first, lets one skill be picked, then installs it', async () => {
    api.skillLibrary.mockResolvedValue({ skills: [] });
    api.inspectGithubSkill.mockResolvedValue({ repo: 'acme/skills', ref: 'main', commit: SHA, candidates: [
      { path: 'skills/brand', name: 'brand', description: 'House brand rules', files: 0 },
      { path: 'skills/pdf', name: 'pdf', description: 'Read and fill PDF forms', files: 1 },
    ] });
    api.installGithubSkill.mockResolvedValue({ skill: PDF });
    render(<SkillsView />);
    fireEvent.click(await screen.findByRole('button', { name: /Add skill/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'From GitHub' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub repository' }), { target: { value: 'https://github.com/acme/skills' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check repository' }));
    expect(await screen.findByText('/pdf')).toBeTruthy();
    expect(api.installGithubSkill).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('radio')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(api.installGithubSkill).toHaveBeenCalledWith('https://github.com/acme/skills', 'skills/pdf'));
    expect(await screen.findByRole('link', { name: 'acme/skills/skills/pdf' })).toBeTruthy();
  });

  it('shows why a GitHub source was refused, and installs nothing', async () => {
    api.skillLibrary.mockResolvedValue({ skills: [] });
    api.inspectGithubSkill.mockRejectedValue(new Error('There is no public GitHub repository acme/missing.'));
    render(<SkillsView />);
    fireEvent.click(await screen.findByRole('button', { name: /Add skill/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'From GitHub' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub repository' }), { target: { value: 'acme/missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check repository' }));
    expect((await screen.findByRole('alert')).textContent).toBe('There is no public GitHub repository acme/missing.');
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });
});

describe('/ skill suggestions', () => {
  it('finds the /token the caret is in, and only a whole one', () => {
    expect(slashQuery('/wee', 4)).toEqual({ start: 0, query: 'wee' });
    expect(slashQuery('please /', 8)).toEqual({ start: 7, query: '' });
    expect(slashQuery('a/b', 3)).toBeNull();
    expect(slashQuery('/usr/bin', 8)).toBeNull();
    expect(slashQuery('/weekly-report', 3)).toBeNull();
  });

  function Harness({ botId }: { botId: string }) {
    const [text, setText] = useState('');
    const ref = useRef<HTMLTextAreaElement>(null);
    const s = useSkillSuggest(botId, text, setText, ref);
    return (
      <div>
        {s.popover}
        <textarea ref={ref} aria-label="msg" value={text} onChange={(e) => { setText(e.target.value); s.track(e.target); }} onKeyDown={(e) => { s.onKeyDown(e); }} />
      </div>
    );
  }

  it("offers only the skills this Bot has, and Enter inserts one", async () => {
    api.skillLibrary.mockResolvedValue({ skills: [skill({}), PDF] });
    render(<Harness botId="b_quill" />);
    const box = screen.getByRole('textbox', { name: 'msg' }) as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(box, { target: { value: 'run /', selectionStart: 5 } }); });
    expect(await screen.findByRole('option', { name: /\/weekly-report/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /\/pdf/ })).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('run /weekly-report '));
  });
});
