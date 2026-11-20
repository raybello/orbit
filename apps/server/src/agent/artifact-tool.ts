import { ARTIFACT_TOOL, MAX_ARTIFACT_BYTES, asArtifactId, type ActivityKind, type ArtifactArgs } from '@orbit/contracts';
import { newId } from '../lib/ids.js';
import type { ToolCtx, ToolResult } from './tools/index.js';

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
}

const ID = /^art_[A-Za-z0-9_-]{6,40}$/;

/** The model's args as the canonical artifact, or an Error whose message tells the model what to fix. */
export function parseArtifact(args: Record<string, unknown>): ArtifactArgs {
  const html = typeof args.html === 'string' ? args.html.trim() : '';
  if (!html) throw new Error('html is empty. Pass a complete HTML document.');
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`html is ${Math.ceil(bytes / 1024)} KiB, over the ${MAX_ARTIFACT_BYTES / 1024} KiB limit. Load large data from a URL or trim it, then call artifact again.`);
  }
  const given = typeof args.artifact_id === 'string' ? args.artifact_id.trim() : '';
  if (given && !ID.test(given)) throw new Error(`artifact_id "${given.slice(0, 60)}" is not one this tool returned. Leave it out to start a new artifact.`);
  const title = (typeof args.title === 'string' ? args.title.trim() : '').slice(0, 120) || 'Untitled';
  return { artifactId: asArtifactId(given || newId('art')), title, html };
}

export const ARTIFACT_TOOLS: ToolDef[] = [
  {
    name: ARTIFACT_TOOL,
    description:
      'Show a web page, visualization, dashboard, game or small interactive tool to the user, rendered live beside the chat. ' +
      'Pass a complete, self-contained HTML document with inline CSS and JavaScript (CDN scripts are fine). ' +
      'To revise an artifact, call this again with the artifact_id it returned and the full new document. ' +
      'Never paste the HTML into your reply; the user sees the artifact.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short title, for example "Pomodoro timer".' },
        html: { type: 'string', description: 'The complete HTML document, starting with <!doctype html>.' },
        artifact_id: { type: 'string', description: 'The id an earlier artifact call returned, to replace that artifact with a new version. Omit to create a new one.' },
      },
      required: ['title', 'html'],
      additionalProperties: false,
    },
    activity: 'drafting_file',
    label: 'Building an artifact',
    impl: async (args) => {
      const artifact = parseArtifact(args);
      return {
        output: `Showing "${artifact.title}" to the user as artifact_id ${artifact.artifactId}. Pass that artifact_id to revise it.`,
        summary: artifact.title,
        rowArgs: artifact,
      };
    },
  },
];
