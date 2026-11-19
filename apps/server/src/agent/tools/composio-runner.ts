import { executeComposio } from '../../composio.js';
import { revokedApps } from '../../core/app-access.js';
import type { ToolArgs, ToolCtx, ToolResult } from './registry.js';

export function humanizeSlug(slug: string) {
  const parts = slug.split('_');
  const app = parts.shift() ?? '';
  return `${app.charAt(0) + app.slice(1).toLowerCase()}: ${parts.join(' ').toLowerCase()}`;
}

/**
 * How a batch call went inside: Composio reports the outer call as completed even when actions in it
 * failed (`data.results[i].response.successful`), so those are counted here.
 */
export function innerOutcome(data: unknown): { total: number; failed: number } {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return { total: 0, failed: 0 };
  const failed = results.filter((x) => (x as { response?: { successful?: unknown } } | null)?.response?.successful === false).length;
  return { total: results.length, failed };
}

/** Run a Composio call. `summary` is 'done', 'partial' (some actions in a batch failed) or 'failed'. */
export async function runComposioTool(ctx: ToolCtx, name: string, args: ToolArgs): Promise<ToolResult> {
  const r = await executeComposio(ctx.userId, name, args, revokedApps(ctx.botId));
  const ok = r.resultType ? r.resultType === 'completed' : !r.error;
  const inner = ok ? innerOutcome(r.data) : { total: 0, failed: 0 };
  const payload = ok ? r.data : { error: r.error, logId: r.logId };
  let out = JSON.stringify(payload ?? null);
  if (out.length > 60000) out = out.slice(0, 60000) + '…(truncated)';
  const summary = !ok || (inner.total > 0 && inner.failed === inner.total) ? 'failed' : inner.failed > 0 ? 'partial' : 'done';
  return { output: out, summary, data: ok ? r.data : undefined };
}
