import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Bot, Row, RowBody } from '@orbit/contracts';
import { Transcript } from '../components/Transcript';

afterEach(cleanup);

const bot = { id: 'bot_a', name: 'Atlas', mode: 'personal' } as Bot;
const t0 = Date.now() - 60_000;
let seq = 0;
const row = (body: RowBody): Row => ({ seq: ++seq, createdAt: t0 + seq * 1000, body } as Row);

describe('Transcript timeline', () => {
  it('puts steps, cards and notices in the text column and leaves events and messages outside it', () => {
    const rows = [
      row({ type: 'message', role: 'user', text: 'Send Stacy an email' }),
      row({ type: 'tool-call', callId: 'c1', name: 'GMAIL_SEND_EMAIL', label: 'Sending email', status: 'done' }),
      row({ type: 'card', card: 'connect', toolkit: 'slack', toolkitName: 'Slack', reason: 'Post the digest', status: 'pending' }),
      row({ type: 'notice', text: "You're at 80% of your weekly usage limit.", tone: 'warn' }),
      row({ type: 'event', event: 'routine-created', text: 'Routine created' }),
      row({ type: 'message', role: 'assistant', text: 'Sent.' }),
    ];
    const { container } = render(<Transcript bot={bot} rows={rows} live={undefined} loaded />);

    const lanes = [...container.querySelectorAll('.lane')];
    expect(lanes.map((l) => l.firstElementChild?.className.split(' ')[0])).toEqual(['steps', 'card', 'notice']);
    expect(container.querySelector('.lane .system-event')).toBeNull();
    expect(container.querySelector('.lane .msg-row')).toBeNull();
  });
});
