-- Preserve the durable payment model. This application provides no PG payment mutation routes.
CREATE TABLE organiser_challenges (
  id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES campaigns(id), session_hash text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('bind','pay')), message text NOT NULL, expires safe_integer NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK(used IN (0,1)));
CREATE TABLE campaign_wallets (
  campaign_id text PRIMARY KEY REFERENCES campaigns(id), address text NOT NULL,
  public_key text NOT NULL, signature text NOT NULL, challenge_id text NOT NULL REFERENCES organiser_challenges(id), created safe_integer NOT NULL);
CREATE TABLE payment_intents (
  id text PRIMARY KEY, claim_id text NOT NULL UNIQUE REFERENCES claims(id), campaign_id text NOT NULL REFERENCES campaigns(id),
  sender text NOT NULL, recipient text NOT NULL, amount safe_integer NOT NULL CHECK(amount>0), fee safe_integer NOT NULL CHECK(fee>=0),
  network text NOT NULL CHECK(network IN ('testnet','mainnet')), validity_start_height safe_integer NOT NULL,
  created safe_integer NOT NULL, expires safe_integer NOT NULL);
CREATE TABLE payment_attempts (
  id text PRIMARY KEY, intent_id text NOT NULL UNIQUE REFERENCES payment_intents(id),
  state text NOT NULL CHECK(state IN ('SUBMITTING','UNKNOWN','CONFIRMED','FAILED')),
  candidate_hash text UNIQUE, created safe_integer NOT NULL, updated safe_integer NOT NULL, reason text NOT NULL,
  receipt text, permit_hash text NOT NULL, dispatched integer NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)));
CREATE TABLE payment_hashes (hash text PRIMARY KEY, attempt_id text NOT NULL REFERENCES payment_attempts(id));
CREATE TABLE payment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES payment_attempts(id), state text NOT NULL, reason text NOT NULL, at safe_integer NOT NULL);
CREATE INDEX payment_events_attempt ON payment_events(attempt_id,id);

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable or append-only record' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_campaign BEFORE UPDATE OR DELETE ON campaigns FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_claim_identity BEFORE UPDATE OF id,invitation_id,campaign_id,address,public_key,signature,challenge_id,created ON claims FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_claim BEFORE DELETE ON claims FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_campaign_wallet BEFORE UPDATE OR DELETE ON campaign_wallets FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_payment_intent BEFORE UPDATE OR DELETE ON payment_intents FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_attempt BEFORE DELETE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER append_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER append_payment_events BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_hashes BEFORE UPDATE OR DELETE ON payment_hashes FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER fixed_settings BEFORE UPDATE OR DELETE ON settings FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE FUNCTION guard_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.created IS DISTINCT FROM OLD.created
    OR NEW.permit_hash IS DISTINCT FROM OLD.permit_hash OR NEW.dispatched<OLD.dispatched
    OR (OLD.candidate_hash IS NOT NULL AND NEW.candidate_hash IS DISTINCT FROM OLD.candidate_hash)
    OR (OLD.state IN ('CONFIRMED','FAILED') AND NEW IS DISTINCT FROM OLD)
    OR (OLD.state='UNKNOWN' AND NEW.state='SUBMITTING') THEN
    RAISE EXCEPTION 'Permanent payment attempt lock' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lock_attempt BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION guard_attempt();
CREATE FUNCTION guard_claim_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Claim decision is final' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER final_claim_decision BEFORE UPDATE OF status ON claims FOR EACH ROW EXECUTE FUNCTION guard_claim_status();
-- PostgreSQL TRUNCATE bypasses row-level DELETE triggers. Guard it explicitly so
-- an accidental bulk cleanup cannot erase history or release durable locks.
CREATE TRIGGER keep_campaigns_truncate BEFORE TRUNCATE ON campaigns FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_claims_truncate BEFORE TRUNCATE ON claims FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_wallets_truncate BEFORE TRUNCATE ON campaign_wallets FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_intents_truncate BEFORE TRUNCATE ON payment_intents FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_attempts_truncate BEFORE TRUNCATE ON payment_attempts FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_events_truncate BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_payment_events_truncate BEFORE TRUNCATE ON payment_events FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_hashes_truncate BEFORE TRUNCATE ON payment_hashes FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_settings_truncate BEFORE TRUNCATE ON settings FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
