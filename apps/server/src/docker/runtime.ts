import { env } from '../env.js';
import { appleRuntime } from '../apple/runtime.js';
import { dockerRuntime } from './docker-runtime.js';
import type { ContainerRuntime } from './runtime-types.js';

export type { BotContainerSpec, ContainerRuntime, ContainerStatus, ExecResult } from './runtime-types.js';
export { withTimeout } from './runtime-types.js';

export function runtime(): ContainerRuntime {
  return env.computerRuntime === 'apple' ? appleRuntime : dockerRuntime;
}
