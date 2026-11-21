/**
 * What the launch window shows while a local stack starts: a step list, and when the start
 * stops short, the problem and what the person can do about it.
 *
 * Pure and shared: main never branches on it, and the renderer only draws what it returns, so
 * the whole mapping from a stack phase to a screen lives in the two tables below.
 */

import type { DesktopLocalStackState, LaunchAction, StackKind, StackPhase } from './shared/api';

export type StepStatus = 'done' | 'active' | 'pending' | 'failed';

export interface LaunchStep {
  label: string;
  status: StepStatus;
}

export interface LaunchProblem {
  title: string;
  body: string;
  /** In button order; the first is the primary action. */
  actions: LaunchAction[];
}

/** Each step owns the phases that happen during it, in the order a start walks them. */
const STEPS: Record<StackKind, ReadonlyArray<{ label: string; phases: readonly StackPhase[] }>> = {
  docker: [
    { label: 'Check Docker', phases: ['idle', 'stopped', 'checking-docker', 'docker-missing', 'docker-not-running'] },
    { label: 'Get the Orbit images', phases: ['preparing', 'pulling'] },
    { label: 'Start the containers', phases: ['starting'] },
    { label: 'Wait for Orbit to answer', phases: ['waiting-healthy'] },
  ],
  native: [
    { label: 'Prepare the Orbit server', phases: ['idle', 'stopped', 'starting'] },
    { label: 'Wait for Orbit to answer', phases: ['waiting-healthy'] },
  ],
};

const FINISHED: readonly StackPhase[] = ['ready', 'running'];
const STOPPED_SHORT: readonly StackPhase[] = ['failed', 'docker-missing', 'docker-not-running'];

/**
 * `lastActive` is the most recent phase that was not a failure: a `failed` state does not say
 * which step it failed in, so the renderer remembers where the start had got to.
 */
export function launchSteps(kind: StackKind, state: DesktopLocalStackState, lastActive: StackPhase = 'idle'): LaunchStep[] {
  const steps = STEPS[kind];
  if (FINISHED.includes(state.phase)) return steps.map((s) => ({ label: s.label, status: 'done' }));
  const failed = STOPPED_SHORT.includes(state.phase);
  const at = failed && state.phase === 'failed' ? lastActive : state.phase;
  const index = Math.max(0, steps.findIndex((s) => s.phases.includes(at)));
  return steps.map((s, i) => ({
    label: s.label,
    status: i < index ? 'done' : i > index ? 'pending' : failed ? 'failed' : 'active',
  }));
}

export interface ProblemContext {
  platform: NodeJS.Platform;
  /** The native stack can run here and is not the one that just failed. */
  nativeAvailable: boolean;
}

export function launchProblem(kind: StackKind, state: DesktopLocalStackState, ctx: ProblemContext): LaunchProblem | null {
  const alternative: LaunchAction[] = kind === 'docker' && ctx.nativeAvailable ? ['use-native'] : [];
  switch (state.phase) {
    case 'docker-missing': {
      const installable = ctx.platform === 'darwin' || ctx.platform === 'win32';
      return installable
        ? {
            title: 'Docker is not installed',
            body: 'Orbit runs its server and each bot’s computer in Docker. Orbit can install Docker Desktop for you (about 600 MB).',
            actions: ['install-docker', ...alternative, 'back'],
          }
        : {
            title: 'Docker is not installed',
            body: 'Install Docker Engine with your package manager, start it, then try again.',
            actions: ['retry', 'open-docker-download', 'back'],
          };
    }
    case 'docker-not-running':
      return {
        title: 'Docker is not running',
        body: state.error ?? 'Start Docker Desktop, wait for it to say it is running, then try again.',
        actions: ['retry', ...alternative, 'back'],
      };
    case 'failed':
      return {
        title: 'Orbit could not start',
        body: state.error ?? state.detail ?? 'The start stopped without saying why.',
        actions: ['retry', 'show-log', 'back'],
      };
    default:
      return null;
  }
}

export const ACTION_LABELS: Record<LaunchAction, string> = {
  retry: 'Try again',
  'install-docker': 'Install Docker Desktop',
  'open-docker-download': 'Get Docker',
  'use-native': 'Run without Docker',
  'show-log': 'Show log',
  back: 'Back',
};
