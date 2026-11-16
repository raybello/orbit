import type { CardBody } from '@orbit/contracts';

/** What a pending card says in the feed, or null when it no longer needs anyone. */
export function cardPreview(body: CardBody): string | null {
  if (body.status !== 'pending') return null;
  switch (body.card) {
    case 'approval': return body.title;
    case 'question': return body.question;
    case 'connect': return `Connect ${body.toolkitName}`;
    case 'draft': return body.subject || `Draft ${body.channel} message to ${body.to}`;
    case 'secure-form': return `Enter the login for ${body.label}`;
  }
}
