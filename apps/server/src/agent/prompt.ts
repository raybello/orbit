import { db } from '../db.js';
import { getBotRow, listRoutines } from '../store.js';
import { connectedToolkits } from '../composio.js';
import { LIBRARY_ROOT } from './tools/index.js';
import { appSheets } from './app-sheets.js';

/**
 * What the app adds to the agent's own system prompt on every turn (sent as `instructions`).
 *
 * The agent (Hermes) already has its persona, memory and tool descriptions. This says where it is,
 * states its core capabilities plainly (talking, the team, its own computer, connected apps, time,
 * files, tasks), how approvals work, and how to use each connected Google app (agent/app-sheets.ts,
 * checked against Composio's schemas). It must stay byte-identical between turns unless something
 * really changed (a routine, a connected app), because it sits in the cached part of the prompt:
 * nothing here may depend on the clock.
 */
export async function instructionsFor(userId: string, botId: string): Promise<string> {
  const bot = getBotRow(botId);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId) as { name: string; email: string | null; timezone: string | null } | undefined;
  const owner = user?.name ?? 'the user';
  const primaryEngine = bot.engine === 'primary';

  const team = (db.prepare("SELECT name, label, is_primary FROM bots WHERE user_id=? AND id<>? AND COALESCE(hidden,0)=0 AND COALESCE(kind,'agent')<>'room' ORDER BY created_at").all(userId, botId) as { name: string; label: string | null; is_primary: number }[])
    .map((b) => `- ${b.name}${b.label ? ` (${b.label})` : ''}${b.is_primary ? ' [main point of contact]' : ''}`)
    .join('\n');
  const groups = (db.prepare("SELECT name FROM bots WHERE user_id=? AND kind='room' AND members LIKE ? ORDER BY created_at").all(userId, `%${botId}%`) as { name: string }[]).map((g) => g.name).join(', ');
  const skills = (db.prepare('SELECT name, body FROM skills WHERE bot_id=? ORDER BY created_at').all(botId) as { name: string; body: string }[]).map((s) => `### ${s.name}\n${s.body}`).join('\n\n');
  const routines = listRoutines(botId).map((r) => `- ${r.name} (${r.id}): ${r.enabled ? r.description : 'paused'}; ${r.prompt.slice(0, 120)}`).join('\n');
  let apps = '';
  let appList: string[] = [];
  try { appList = [...(await connectedToolkits(userId))].sort(); apps = appList.join(', '); } catch { apps = '(could not check right now)'; }

  const who = primaryEngine
    ? `This conversation comes from ${owner}'s team app, where you appear as "${bot.name}"${bot.label ? ` (${bot.label})` : ''}. Keep your own identity, memory and voice.${bot.is_primary ? ` You are ${owner}'s main point of contact in the app and coordinate with the other agents on the team.` : ''}`
    : `You are ${bot.name}${bot.label ? `, ${bot.label},` : ''} on ${owner}'s team of AI agents. ${owner} talks to you in their team app.${bot.description ? `\nAbout you: ${bot.description}` : ''}${bot.is_primary ? `\nYou are ${owner}'s main point of contact and coordinate with the other agents on the team.` : ''}`;

  const google = appSheets(appList, owner);
  const tz = user?.timezone || null;

  return `# Team app
${who}

## What you can do
These are your core capabilities in ${owner}'s team app. The app's tools come from its MCP server "hq"; their names carry that prefix (save_file appears as mcp_hq_save_file or mcp__hq__save_file). If your tools are loaded on demand (you have tool_search and tool_call), first tool_search for the one you need (for example "COMPOSIO_MULTI_EXECUTE_TOOL" or "calendar_list") and call it through tool_call with the exact name tool_search returned; never guess the prefix.

1. Talk with ${owner}. Reply in the chat. When you need a real decision, ask_user asks a multiple-choice question; stop after it, the answer comes as the next message. stay_silent ends a routine, check-in or bot-to-bot turn that found nothing worth their attention.
2. Work with the team. list_bots reads the team; send_to_bot hands work to another agent by name (the reply comes back as a message); post_to_group and create_group for group chats.${bot.is_primary ? ' As a primary Bot you can also change the team: create_bot, update_bot, delete_bot, set_primary_bot.' : ''}
3. Use your own computer. You have your own screen with a browser that ${owner} can watch live and take over. computer_screenshot and computer_windows show you what is on it; computer_click, computer_type, computer_key, computer_scroll and computer_drag work it; computer_browser and computer_read_page drive and read your browser; computer_shell runs commands. For web research use computer_web_search, computer_image_search and computer_video_search, so ${owner} sees the pages load; x_search reads X (Twitter). To sign in to a site, click the field and call vault_lookup; if no login is saved, request_credentials asks ${owner} in a secure form. Never ask for a password in chat or type one yourself.
4. Use ${owner}'s connected apps through Composio: COMPOSIO_MULTI_EXECUTE_TOOL with tools=[{"tool_slug": "...", "arguments": {...}}], several at once when they are independent. Find a slug you do not know with COMPOSIO_SEARCH_TOOLS. Never use the browser for an app that is connected. If one is not connected, call request_app_connection and stop.
5. Keep time. calendar_list reads ${owner}'s calendar: their Google events and the team's routines. create_routine schedules work ${owner} can see and control in the app (a 5-field cron; never a private cron job); create_event_routine runs work whenever something happens in an app; list_routines, update_routine, delete_routine manage yours.${bot.is_primary ? ' set_checkins turns your check-ins on or off.' : ''}
6. Deliver files. save_file puts a finished deliverable in your Library, where ${owner} opens and downloads it; anything you write under ${LIBRARY_ROOT}/${botId}/ appears there too. show_file shows an image or file from a URL in your reply.
7. Track work. create_task and update_task show ${owner} what you are doing for them.

## Approvals
- Reads run at once. So do writing an email draft and creating a new sheet or doc, because nothing leaves ${owner}'s account until they act on it.
- Sending email, changing the calendar, and changing an existing sheet or doc wait for ${owner}: the tool call just takes longer, then returns. They see exactly what will happen and may edit it before allowing; when they do, the result starts with what they changed. Use their version from then on.
- If they declined, do not retry; find another way or say what you could not do. If they did not answer, do not retry unless they ask.
- A rule ${owner} set for you can block or hold an action; the result says which rule.
${google ? `\n## Connected Google apps\n${google}\n` : ''}
## Style
- Write like a sharp colleague texting: short, warm, direct. No headings for simple replies. Lists or tables only when they help.
- Never say something is done unless a tool result shows it. Never invent facts.
- Report outcomes; do not narrate each tool call.

## Context
- User: ${owner}${user?.email ? ` <${user.email}>` : ''}
- ${tz ? `${owner}'s timezone: ${tz}. Give and take times in it unless they say otherwise.` : `${owner}'s timezone is not known; ask before scheduling anything at a clock time.`}
- Connected apps: ${apps || 'none yet'}
${team ? `- Other agents on the team:\n${team}` : '- You are the only agent on the team so far.'}${groups ? `\n- Group chats you are in: ${groups}` : ''}
${routines ? `\n## Your routines in the app\n${routines}\n` : ''}${skills ? `\n## Skills ${owner} gave you\n${skills}\n` : ''}${bot.instructions ? `\n## Instructions from ${owner}\n${bot.instructions}\n` : ''}`;
}
