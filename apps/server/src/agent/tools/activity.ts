import type { ActivityKind } from '@orbit/contracts';
import { toolMap } from './registry.js';

/** A Hermes tool name as the app knows it: tools served by this app's MCP server lose their `mcp_hq_` prefix. */
export function appToolName(raw: string): { name: string; ours: boolean; server?: string } {
  const hq = /^mcp_+hq_+(.+)$/.exec(raw);
  if (hq) {
    // Hermes may fold names to lower case; ours are matched case-insensitively.
    const hit = [...toolMap.keys()].find((k) => k.toLowerCase() === hq[1].toLowerCase());
    return { name: hit ?? (/^composio_/i.test(hq[1]) ? hq[1].toUpperCase() : hq[1]), ours: true };
  }
  const other = /^mcp_+([a-zA-Z0-9-]+?)_+(.+)$/.exec(raw);
  if (other) return { name: other[2], ours: false, server: other[1] };
  return { name: raw, ours: false };
}

const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What to show while a tool runs. `raw` is the name Hermes reports. */
export function activityFor(raw: string): { kind: ActivityKind; label: string; detail?: string } {
  const { name, ours, server } = appToolName(raw);
  if (ours) {
    const t = toolMap.get(name);
    if (t) return { kind: t.activity, label: t.label, ...(name === 'x_search' ? { detail: 'X' } : {}) };
    return { kind: 'connecting_service', label: 'Using a connected app' };
  }
  if (server) return { kind: 'connecting_service', label: `Using ${words(server)}`, detail: sentence(words(server)) };
  if (name === 'terminal' || name === 'process' || name === 'execute_code') return { kind: 'running_commands', label: 'Running commands' };
  if (name === 'write_file' || name === 'patch') return { kind: 'drafting_file', label: 'Writing a file' };
  if (name === 'read_file' || name === 'search_files') return { kind: 'working', label: 'Reading files' };
  if (name === 'web_search') return { kind: 'searching_web', label: 'Searching the web' };
  if (name === 'web_extract') return { kind: 'reading_web', label: 'Reading a page' };
  if (name === 'x_search') return { kind: 'searching_web', label: 'Searching X', detail: 'X' };
  if (name.startsWith('browser_')) return { kind: 'browsing_web', label: 'Browsing a site' };
  if (name === 'computer_use') return { kind: 'on_its_computer', label: 'Using its computer' };
  if (name === 'vision_analyze') return { kind: 'working', label: 'Looking at an image' };
  if (name === 'memory') return { kind: 'remembering', label: 'Saving notes' };
  if (name === 'session_search') return { kind: 'remembering', label: 'Searching memory' };
  if (name === 'todo') return { kind: 'working', label: 'Planning' };
  if (name === 'delegate_task') return { kind: 'working', label: 'Handing off work' };
  if (name === 'send_message') return { kind: 'messaging_named', label: 'Sending a message' };
  if (name.startsWith('skill')) return { kind: 'working', label: 'Using a skill' };
  if (name === 'clarify') return { kind: 'waiting_for_you', label: 'Waiting on you' };
  if (name === 'cronjob') return { kind: 'working', label: 'Scheduling' };
  return { kind: 'working', label: sentence(words(name)) || 'Working' };
}
