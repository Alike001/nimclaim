import type { DB } from "./db.js";
import { atomic } from "./db.js";
export function migratePayments(db: DB) {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  if (version > 2) throw new Error("Database is newer than this application.");
  if (version >= 2) return;
  atomic(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS organiser_challenges (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), session_hash TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('bind','pay')), message TEXT NOT NULL, expires INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS campaign_wallets (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id), address TEXT NOT NULL,
      public_key TEXT NOT NULL, signature TEXT NOT NULL, challenge_id TEXT NOT NULL REFERENCES organiser_challenges(id), created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES claims(id), campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      sender TEXT NOT NULL, recipient TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), fee INTEGER NOT NULL CHECK(fee>=0),
      network TEXT NOT NULL CHECK(network IN ('testnet','mainnet')), validity_start_height INTEGER NOT NULL,
      created INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_attempts (
      id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE REFERENCES payment_intents(id),
      state TEXT NOT NULL CHECK(state IN ('SUBMITTING','UNKNOWN','CONFIRMED','FAILED')),
      candidate_hash TEXT UNIQUE, created INTEGER NOT NULL, updated INTEGER NOT NULL, reason TEXT NOT NULL,
      receipt TEXT, permit_hash TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS payment_hashes (
      hash TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES payment_attempts(id));
    CREATE TABLE IF NOT EXISTS payment_events (
      id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES payment_attempts(id), state TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS immutable_campaign BEFORE UPDATE ON campaigns BEGIN SELECT RAISE(ABORT,'Campaign is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_claim_identity BEFORE UPDATE OF id,invitation_id,campaign_id,address,public_key,signature,challenge_id,created ON claims BEGIN SELECT RAISE(ABORT,'Claim identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_campaign_wallet BEFORE UPDATE ON campaign_wallets BEGIN SELECT RAISE(ABORT,'Campaign wallet is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_payment_intent BEFORE UPDATE ON payment_intents BEGIN SELECT RAISE(ABORT,'Payment intent is immutable'); END;
    PRAGMA user_version=2;`);
  });
}
