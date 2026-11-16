import { createHash } from 'node:crypto';

/** xAI attributes a policy violation to this hashed end user instead of to the whole account key. */
export const safetyIdentifier = (userId: string): string => createHash('sha256').update(userId).digest('hex');
