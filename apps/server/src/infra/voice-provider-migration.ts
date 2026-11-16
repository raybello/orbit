import type Database from 'better-sqlite3';

/**
 * Voice defaults to on-device. A row whose provider is not one of the two choices was never set to
 * anything meaningful, so it takes the default. A stored 'cloud' is left alone: the column default
 * wrote 'cloud' too, so it cannot be told apart from someone choosing the cloud, and an explicit
 * cloud choice must survive the upgrade. Idempotent: a second run changes nothing.
 */
export function migrateUnsetVoiceProviders(db: Database.Database): number {
  return db.prepare("UPDATE bots SET voice_provider='local' WHERE voice_provider NOT IN ('cloud','local')").run().changes;
}
