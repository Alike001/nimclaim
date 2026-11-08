import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS organiser (id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount>0), slots INTEGER NOT NULL CHECK(slots>0),
      expires INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL REFERENCES invitations(id),
      message TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL UNIQUE REFERENCES invitations(id),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id), address TEXT NOT NULL,
      public_key TEXT NOT NULL, signature TEXT NOT NULL, challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id),
      status TEXT NOT NULL CHECK(status IN ('pending','payment-ready','rejected','expired')),
      created INTEGER NOT NULL, UNIQUE(campaign_id,address));
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES claims(id),
      status TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS challenges_invitation ON challenges(invitation_id);
    `);
  return db;
}
export type DB = ReturnType<typeof openDb>;
export function atomic<T>(db: DB, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
