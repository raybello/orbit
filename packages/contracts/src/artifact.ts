import type { ArtifactId } from './branded-types.js';
import type { ToolCallBody } from './index.js';

/** The tool a Bot calls to show a page, visualization or interactive tool beside the chat. */
export const ARTIFACT_TOOL = 'artifact';

/** Largest artifact document the server accepts, in UTF-8 bytes. */
export const MAX_ARTIFACT_BYTES = 512 * 1024;

/**
 * An `artifact` tool-call row's args once the tool has run. The server rewrites the model's args
 * into this shape, so every version of one artifact carries the same id.
 */
export interface ArtifactArgs {
  artifactId: ArtifactId;
  title: string;
  html: string;
}

/** The artifact a tool-call row holds, or null for any other row or one the tool refused. */
export function artifactArgsOf(body: ToolCallBody): ArtifactArgs | null {
  if (body.name !== ARTIFACT_TOOL || body.status !== 'done') return null;
  const a = body.args as Partial<Record<keyof ArtifactArgs, unknown>> | null | undefined;
  if (!a || typeof a.artifactId !== 'string' || typeof a.title !== 'string' || typeof a.html !== 'string') return null;
  return { artifactId: a.artifactId as ArtifactId, title: a.title, html: a.html };
}
