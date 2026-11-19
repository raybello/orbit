import assert from 'node:assert/strict';
import test from 'node:test';
import { expandSkillCommands, nameProblem, parseGithubSource, parseSkillMd, skillMdFor, slugifySkillName } from '../domain/skill-md.js';

/** SKILL.md, skill names, `/<name>` expansion and GitHub sources: the pure rules the library is built on. */

test('a SKILL.md is read into its frontmatter and body; text without frontmatter is all body', () => {
  const md = '---\nname: pdf\ndescription: Work with PDFs\nlicense: MIT\n---\n\n# PDF\nUse pdftotext.\n';
  assert.deepEqual(parseSkillMd(md), { frontmatter: { name: 'pdf', description: 'Work with PDFs', license: 'MIT' }, body: '# PDF\nUse pdftotext.' });
  assert.deepEqual(parseSkillMd('Just do it.\n'), { frontmatter: {}, body: 'Just do it.' });
  assert.deepEqual(parseSkillMd('﻿---\r\nname: x\r\n---\r\nbody\r\n'), { frontmatter: { name: 'x' }, body: 'body' });
  assert.match((parseSkillMd('---\nname: [unclosed\n---\nbody') as { error: string }).error, /not valid YAML/);
  assert.match((parseSkillMd('---\n- a\n- b\n---\nbody') as { error: string }).error, /key: value/);
});

test('a skill name follows the Agent Skills rule, and a title is turned into one', () => {
  assert.equal(nameProblem('weekly-report'), null);
  assert.equal(nameProblem('pdf2'), null);
  for (const bad of ['Weekly', 'weekly report', '-lead', 'trail-', 'two--hyphens', 'a'.repeat(65), '']) assert.ok(nameProblem(bad), bad);
  assert.equal(slugifySkillName('Weekly Report!'), 'weekly-report');
  assert.equal(slugifySkillName('  Prep for a sales call  '), 'prep-for-a-sales-call');
  assert.equal(slugifySkillName('!!!'), 'skill');
  assert.ok(slugifySkillName('x'.repeat(100)).length <= 64);
});

test('the stored SKILL.md always carries the library name and description, keeping other frontmatter', () => {
  const out = skillMdFor('pdf', 'Work with PDFs', '---\nname: old\nlicense: MIT\n---\nUse pdftotext.');
  assert.deepEqual(parseSkillMd(out), { frontmatter: { name: 'pdf', license: 'MIT', description: 'Work with PDFs' }, body: 'Use pdftotext.' });
  assert.deepEqual(parseSkillMd(skillMdFor('x', 'y', 'plain steps')), { frontmatter: { name: 'x', description: 'y' }, body: 'plain steps' });
});

test('/<name> becomes the skill in place; paths, URLs and unknown names stay as typed', () => {
  const skills = new Map([['weekly-report', 'Step 1. Pull the numbers.'], ['tone', 'Be brief.']]);
  const r = expandSkillCommands('/weekly-report for March, and keep it /tone.', skills);
  assert.deepEqual(r.used, ['weekly-report', 'tone']);
  assert.equal(r.text, '<skill name="weekly-report">\nStep 1. Pull the numbers.\n</skill>\n for March, and keep it <skill name="tone">\nBe brief.\n</skill>\n.');
  for (const left of ['see /usr/bin/env', 'https://x.com/tone', 'run /unknown now', 'a/tone', '/tone-deaf']) {
    assert.equal(expandSkillCommands(left, skills).text, left, left);
  }
  assert.deepEqual(expandSkillCommands('/tone and /tone', skills).used, ['tone'], 'a skill used twice is counted once');
});

test('a GitHub source is read from each form people paste', () => {
  assert.deepEqual(parseGithubSource('anthropics/skills'), { owner: 'anthropics', repo: 'skills' });
  assert.deepEqual(parseGithubSource('github:anthropics/skills'), { owner: 'anthropics', repo: 'skills' });
  assert.deepEqual(parseGithubSource('anthropics/skills/skills/pdf'), { owner: 'anthropics', repo: 'skills', path: 'skills/pdf' });
  assert.deepEqual(parseGithubSource('https://github.com/anthropics/skills.git'), { owner: 'anthropics', repo: 'skills' });
  assert.deepEqual(parseGithubSource('https://github.com/anthropics/skills/tree/main/skills/pdf'), { owner: 'anthropics', repo: 'skills', ref: 'main', path: 'skills/pdf' });
  assert.deepEqual(parseGithubSource('https://github.com/o/r/blob/v1.2/a/SKILL.md'), { owner: 'o', repo: 'r', ref: 'v1.2', path: 'a' });
  for (const bad of ['', 'justone', 'https://gitlab.com/o/r', 'o/r/../etc', 'o/r/./x', 'own er/repo', 'https://github.com/o/r/tree']) {
    assert.equal(parseGithubSource(bad), null, bad);
  }
});
