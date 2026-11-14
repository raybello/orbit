import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow } from '../store.js';

/**
 * Group chats ("rooms"; Grok Bot: GrokBotAgent kind=ROOM, member_agent_ids, server turn-taking).
 * A room is a bot row with kind='room' and a members list. It never runs its own agent loop:
 * a user message is dispatched to the members who should answer (@mentioned ones, else all,
 * capped), each member runs its normal loop with the group context and replies into the room
 * with post_to_group.
 *
 * Bots hand off to each other inside a room: a reply that @mentions a peer dispatches that peer
 * (see dispatchBotMentions), so the group can resolve a question in one user turn. The chain is
 * cut at MAX_BOT_CHAIN_DEPTH hops.
 */

const MAX_RESPONDERS = 3;

/** How many bot-to-bot hops one group conversation may take (a user turn is depth 0). */
export const MAX_BOT_CHAIN_DEPTH = 3;

/** Recent messages carried into a group turn: long enough to see the chained replies. */
const GROUP_HISTORY = 20;

/** What a group dispatch needs from the agent loop: its per-bot serial queue. */
export type GroupEnqueue = (botId: string, turn: any) => void;

/** Stands in when a caller has no queue to hand (checks, dry runs): dispatch does nothing. */
const noEnqueue: GroupEnqueue = () => {};

export interface GroupMember {
  id: string;
  name: string;
}

export interface GroupTurnOpts {
  /** The bot was @mentioned rather than answering the user's message to the whole group. */
  mentioned?: boolean;
  /** Who @mentioned it (a peer's name), when that is what brought it in. */
  fromName?: string;
}

export interface GroupTurn {
  type: 'system';
  text: string;
  /** Chain depth this turn runs at; the post_to_group handler hands it back to postToRoom. */
  _groupDepth: number;
}

export function initRooms() {
  for (const col of ["kind TEXT NOT NULL DEFAULT 'agent'", 'members TEXT']) {
    try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

export const isRoom = (botId: string) => (db.prepare('SELECT kind FROM bots WHERE id=?').get(botId) as any)?.kind === 'room';

export function roomMembers(roomId: string): GroupMember[] {
  const r = db.prepare('SELECT members FROM bots WHERE id=?').get(roomId) as any;
  const ids: string[] = r?.members ? JSON.parse(r.members) : [];
  return ids.map((id) => db.prepare('SELECT id, name FROM bots WHERE id=?').get(id) as any).filter(Boolean);
}

export function createRoom(userId: string, name: string, memberIds: string[]) {
  const id = newId('room');
  db.prepare(
    `INSERT INTO bots(id,user_id,name,label,description,avatar_shape,avatar_color,kind,members,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'room',?,?,?)`,
  ).run(id, userId, name.slice(0, 60), 'Group', `Group chat with ${memberIds.length} Bots`, 'cloud', 'gray', JSON.stringify(memberIds), now(), now());
  hub.emit(userId, { type: 'roster' });
  return id;
}

/**
 * The members a text @mentions, in the order their mention first appears. Names may contain
 * spaces ("@Ann Marie"), so longer names are matched first and their span is then off limits to
 * shorter ones — "@Ann Marie" never also reads as "@Ann". Matching is case-insensitive, a member
 * is returned at most once, and a name must not run on into another word ("@Ann" inside "@Anna").
 */
export function mentionedMembers(text: string, candidates: GroupMember[]): GroupMember[] {
  const lower = text.toLowerCase();
  const taken: [number, number][] = [];
  const hits: GroupMember[] = [];
  for (const m of [...candidates].sort((a, b) => b.name.length - a.name.length)) {
    const needle = `@${m.name.toLowerCase()}`;
    let hit = false;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      const end = at + needle.length;
      if (/[\p{L}\p{N}_-]/u.test(lower.charAt(end))) continue; // "@Ann" inside "@Anna"
      if (taken.some(([s, e]) => at < e && end > s)) continue; // inside a longer member's name
      taken.push([at, end]);
      hit = true;
    }
    if (hit) hits.push(m);
  }
  return hits;
}

/** The last `limit` messages of the room, one "User: …" / "Name: …" line each. */
function recentMessages(roomId: string, generation: number, limit = GROUP_HISTORY): string {
  return (db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT ?").all(roomId, generation, limit) as any[])
    .reverse()
    .map((r) => {
      const b = JSON.parse(r.body);
      return `${b.from?.name ?? (b.role === 'user' ? 'User' : 'Bot')}: ${String(b.text).slice(0, 600)}`;
    })
    .join('\n');
}

/**
 * The system turn handed to one group member. User-initiated turns (depth 0) and chained ones
 * share this shape so a bot sees the same group context either way; only why-it-is-here and the
 * near-limit note differ.
 */
export function buildGroupTurn(roomId: string, depth: number, opts: GroupTurnOpts = {}): GroupTurn {
  const room = db.prepare('SELECT * FROM bots WHERE id=?').get(roomId) as any;
  const name = room?.name ?? 'Group';
  const members = roomMembers(roomId);
  const recent = recentMessages(roomId, room?.generation ?? 1);
  const why = opts.mentioned
    ? `You were @mentioned${opts.fromName ? ` by ${opts.fromName}` : ''}.`
    : 'The user addressed the whole group.';
  const nearLimit =
    depth >= MAX_BOT_CHAIN_DEPTH - 1
      ? `\nDepth: ${depth} of ${MAX_BOT_CHAIN_DEPTH} — this is near the chain limit, so aim to wrap up your contribution.`
      : '';
  return {
    type: 'system',
    text:
      `[Group chat "${name}"] Members: ${members.map((m) => m.name).join(', ')}. ${why}\n` +
      `Recent messages:\n${recent}\n\n` +
      `Reply to the group by calling post_to_group with group_name "${name}" (use your tools first if the request needs real work). ` +
      `If you need input from another Bot before you can answer, @mention them in that message — they are dispatched automatically. ` +
      `Keep it short and don't repeat what other Bots already said. If you have nothing to add, call stay_silent. Do not write a normal reply.` +
      nearLimit,
    _groupDepth: depth,
  };
}

/** Called instead of the agent loop when the user posts in a room. */
export function dispatchRoomMessage(roomId: string, text: string, enqueue: GroupEnqueue) {
  const members = roomMembers(roomId);
  if (!members.length) {
    appendRow(roomId, 'notice', { type: 'notice', text: 'This group has no Bots yet.', tone: 'warn' });
    return;
  }
  const mentioned = mentionedMembers(text, members);
  const responders = (mentioned.length ? mentioned : members).slice(0, MAX_RESPONDERS);
  for (const m of responders) {
    enqueue(m.id, buildGroupTurn(roomId, 0, { mentioned: mentioned.some((x) => x.id === m.id) }));
  }
}

/**
 * A bot posted into the room. Dispatch the peers it @mentioned so they can answer in the same
 * conversation. Stops at MAX_BOT_CHAIN_DEPTH (no-op at the limit), never dispatches the poster
 * itself, and ignores mentions of bots outside the room. Returns the ids dispatched.
 */
export function dispatchBotMentions(
  roomId: string,
  fromBotId: string,
  text: string,
  depth: number,
  enqueue: GroupEnqueue = noEnqueue,
): string[] {
  if (depth >= MAX_BOT_CHAIN_DEPTH) return [];
  const from = db.prepare('SELECT name FROM bots WHERE id=?').get(fromBotId) as any;
  const peers = roomMembers(roomId).filter((m) => m.id !== fromBotId);
  if (!peers.length) return [];
  const hits = mentionedMembers(text, peers);
  for (const peer of hits) enqueue(peer.id, buildGroupTurn(roomId, depth + 1, { mentioned: true, fromName: from?.name }));
  return hits.map((p) => p.id);
}

/**
 * A bot posts text into a group it belongs to. `depth` is the chain depth of the turn that posted
 * (0 for a user-initiated turn); the posted text's @mentions are dispatched one hop deeper.
 */
export function postToRoom(
  fromBotId: string,
  roomName: string,
  text: string,
  depth = 0,
  enqueue: GroupEnqueue = noEnqueue,
) {
  const from = db.prepare('SELECT id, user_id, name FROM bots WHERE id=?').get(fromBotId) as any;
  const room = db.prepare("SELECT * FROM bots WHERE user_id=? AND kind='room' AND lower(name)=lower(?)").get(from.user_id, roomName.trim()) as any;
  if (!room) return `No group named "${roomName}".`;
  const members: string[] = room.members ? JSON.parse(room.members) : [];
  if (!members.includes(fromBotId)) return `You're not a member of "${room.name}".`;
  appendRow(room.id, 'message', { type: 'message', role: 'assistant', text, from: { kind: 'bot', id: from.id, name: from.name } });
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(room.id);
  dispatchBotMentions(room.id, fromBotId, text, depth, enqueue);
  return 'Posted to the group.';
}
