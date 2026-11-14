/**
 * Gmail + Google Calendar tools for the agent MCP server.
 *
 * All tools use the user's own Google OAuth2 credentials (see google-oauth.ts).
 * Destructive tools (send email, create/update event) are tagged with
 * activity:'connecting_service' so the approval layer can gate them.
 */

import { googleFetch } from './google-oauth.js';
import type { ToolCtx, ToolResult } from './agent/tools.js';

// ---------- shared ----------

function safe(v: unknown, maxLen = 8000): string {
  return JSON.stringify(v, null, 2).slice(0, maxLen);
}

function dateParam(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00Z').toISOString();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).toISOString();
  return undefined;
}

// ---------- Gmail ----------

function decodeBody(payload: any): string {
  const getFromParts = (parts: any[]): string => {
    for (const p of parts ?? []) {
      if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64').toString('utf8');
      if (p.parts) { const r = getFromParts(p.parts); if (r) return r; }
    }
    for (const p of parts ?? []) {
      if (p.mimeType === 'text/html' && p.body?.data) return Buffer.from(p.body.data, 'base64').toString('utf8').replace(/<[^>]+>/g, '').trim();
      if (p.parts) { const r = getFromParts(p.parts); if (r) return r; }
    }
    return '';
  };
  if (payload?.body?.data) return Buffer.from(payload.body.data, 'base64').toString('utf8');
  return getFromParts(payload?.parts ?? []);
}

function headerVal(headers: any[], name: string): string {
  return headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function formatMessage(msg: any, includeBody = false): object {
  const headers = msg.payload?.headers ?? [];
  const out: Record<string, any> = {
    id: msg.id,
    threadId: msg.threadId,
    subject: headerVal(headers, 'subject'),
    from: headerVal(headers, 'from'),
    to: headerVal(headers, 'to'),
    date: headerVal(headers, 'date'),
    snippet: msg.snippet ?? '',
    labels: msg.labelIds ?? [],
  };
  if (includeBody) out.body = decodeBody(msg.payload).slice(0, 10000);
  return out;
}

export async function gmailListMessages(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const q = encodeURIComponent(String(a.query ?? '').trim() || 'in:inbox');
  const maxResults = Math.min(Number(a.max_results ?? 20), 50);
  const data = await googleFetch(ctx.userId, `/gmail/v1/users/me/messages?q=${q}&maxResults=${maxResults}`);
  if (!data.messages?.length) return { output: 'No messages found.', summary: 'No Gmail results' };
  const messages = await Promise.all(
    data.messages.slice(0, maxResults).map((m: any) => googleFetch(ctx.userId, `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=subject,from,to,date`)),
  );
  return {
    output: safe(messages.map((m: any) => formatMessage(m))),
    summary: `Listed ${messages.length} Gmail messages`,
  };
}

export async function gmailGetMessage(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const id = String(a.message_id ?? '').trim();
  if (!id) return { output: 'message_id is required', summary: 'Error' };
  const msg = await googleFetch(ctx.userId, `/gmail/v1/users/me/messages/${id}?format=full`);
  return {
    output: safe(formatMessage(msg, true)),
    summary: `Read email: ${(msg.payload?.headers ?? []).find((h: any) => h.name === 'Subject')?.value ?? id}`,
  };
}

export async function gmailSend(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const to = String(a.to ?? '').trim();
  const subject = String(a.subject ?? '').trim();
  const body = String(a.body ?? '').trim();
  if (!to || !subject || !body) return { output: 'to, subject, and body are required', summary: 'Error' };

  const profile = await googleFetch(ctx.userId, '/gmail/v1/users/me/profile');
  const from = profile.emailAddress ?? '';

  const inReplyTo = a.in_reply_to ? String(a.in_reply_to) : undefined;
  const threadId = a.thread_id ? String(a.thread_id) : undefined;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
  ].join('\r\n');

  const raw = Buffer.from(`${headers}\r\n\r\n${body}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const payload: any = { raw };
  if (threadId) payload.threadId = threadId;

  const sent = await googleFetch(ctx.userId, '/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return {
    output: JSON.stringify({ ok: true, messageId: sent.id, threadId: sent.threadId }),
    summary: `Sent email to ${to}: "${subject}"`,
  };
}

export async function gmailGetThread(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const id = String(a.thread_id ?? '').trim();
  if (!id) return { output: 'thread_id is required', summary: 'Error' };
  const thread = await googleFetch(ctx.userId, `/gmail/v1/users/me/threads/${id}?format=full`);
  const messages = (thread.messages ?? []).map((m: any) => formatMessage(m, true));
  return {
    output: safe({ threadId: thread.id, messages }),
    summary: `Read thread (${messages.length} messages)`,
  };
}

// ---------- Google Calendar ----------

function formatEvent(ev: any): object {
  return {
    id: ev.id,
    calendarId: ev.calendarId,
    summary: ev.summary ?? '(no title)',
    description: ev.description ?? '',
    location: ev.location ?? '',
    start: ev.start?.dateTime ?? ev.start?.date ?? '',
    end: ev.end?.dateTime ?? ev.end?.date ?? '',
    allDay: !ev.start?.dateTime,
    status: ev.status ?? '',
    attendees: (ev.attendees ?? []).map((a: any) => ({ email: a.email, name: a.displayName, status: a.responseStatus })),
    organizer: ev.organizer?.email ?? '',
    htmlLink: ev.htmlLink ?? '',
    recurringEventId: ev.recurringEventId ?? null,
  };
}

export async function calendarListEvents(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const calendarId = encodeURIComponent(String(a.calendar_id ?? 'primary'));
  const maxResults = Math.min(Number(a.max_results ?? 20), 100);
  const params: string[] = [`maxResults=${maxResults}`, 'singleEvents=true', 'orderBy=startTime'];
  const timeMin = dateParam(a.time_min ?? new Date().toISOString());
  const timeMax = dateParam(a.time_max);
  if (timeMin) params.push(`timeMin=${encodeURIComponent(timeMin)}`);
  if (timeMax) params.push(`timeMax=${encodeURIComponent(timeMax)}`);
  if (a.query) params.push(`q=${encodeURIComponent(String(a.query))}`);

  const data = await googleFetch(ctx.userId, `/calendar/v3/calendars/${calendarId}/events?${params.join('&')}`);
  const events = (data.items ?? []).map((ev: any) => formatEvent(ev));
  return {
    output: events.length ? safe(events) : 'No events found.',
    summary: `Listed ${events.length} calendar events`,
  };
}

export async function calendarGetEvent(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const calendarId = encodeURIComponent(String(a.calendar_id ?? 'primary'));
  const eventId = encodeURIComponent(String(a.event_id ?? '').trim());
  if (!a.event_id) return { output: 'event_id is required', summary: 'Error' };
  const ev = await googleFetch(ctx.userId, `/calendar/v3/calendars/${calendarId}/events/${eventId}`);
  return { output: safe(formatEvent(ev)), summary: `Got event: ${ev.summary ?? eventId}` };
}

export async function calendarCreateEvent(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const calendarId = encodeURIComponent(String(a.calendar_id ?? 'primary'));
  const summary = String(a.summary ?? '').trim();
  if (!summary) return { output: 'summary is required', summary: 'Error' };
  if (!a.start) return { output: 'start is required (ISO 8601 or YYYY-MM-DD)', summary: 'Error' };

  const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(String(a.start));
  const startObj = isAllDay ? { date: a.start } : { dateTime: new Date(a.start).toISOString(), timeZone: a.timezone ?? 'UTC' };
  const endObj = a.end
    ? (isAllDay ? { date: a.end } : { dateTime: new Date(a.end).toISOString(), timeZone: a.timezone ?? 'UTC' })
    : (isAllDay ? { date: a.start } : { dateTime: new Date(new Date(a.start).getTime() + 60 * 60 * 1000).toISOString(), timeZone: a.timezone ?? 'UTC' });

  const body: any = { summary, start: startObj, end: endObj };
  if (a.description) body.description = String(a.description);
  if (a.location) body.location = String(a.location);
  if (Array.isArray(a.attendees)) body.attendees = a.attendees.map((e: string) => ({ email: e }));

  const ev = await googleFetch(ctx.userId, `/calendar/v3/calendars/${calendarId}/events`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return {
    output: safe(formatEvent(ev)),
    summary: `Created event: "${summary}"`,
  };
}

export async function calendarUpdateEvent(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const calendarId = encodeURIComponent(String(a.calendar_id ?? 'primary'));
  const eventId = encodeURIComponent(String(a.event_id ?? '').trim());
  if (!a.event_id) return { output: 'event_id is required', summary: 'Error' };

  const patch: any = {};
  if (a.summary !== undefined) patch.summary = String(a.summary);
  if (a.description !== undefined) patch.description = String(a.description);
  if (a.location !== undefined) patch.location = String(a.location);
  if (a.start !== undefined) {
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(String(a.start));
    patch.start = isAllDay ? { date: a.start } : { dateTime: new Date(a.start).toISOString(), timeZone: a.timezone ?? 'UTC' };
  }
  if (a.end !== undefined) {
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(String(a.end));
    patch.end = isAllDay ? { date: a.end } : { dateTime: new Date(a.end).toISOString(), timeZone: a.timezone ?? 'UTC' };
  }

  const ev = await googleFetch(ctx.userId, `/calendar/v3/calendars/${calendarId}/events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return {
    output: safe(formatEvent(ev)),
    summary: `Updated event: "${ev.summary ?? a.event_id}"`,
  };
}

export async function calendarListCalendars(a: any, ctx: ToolCtx): Promise<ToolResult> {
  const data = await googleFetch(ctx.userId, '/calendar/v3/users/me/calendarList');
  const cals = (data.items ?? []).map((c: any) => ({ id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole }));
  return {
    output: safe(cals),
    summary: `Listed ${cals.length} calendars`,
  };
}
