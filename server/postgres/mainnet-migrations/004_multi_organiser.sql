-- Multi-organiser MAINNET migration. Existing records are assigned to one
-- explicit legacy tenant; no campaign, invitation, claim or event is deleted.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organiser WHERE id=1) THEN
    RAISE EXCEPTION 'Legacy organiser bootstrap is required before tenant migration';
  END IF;
END $$;

CREATE TABLE organisers (
  id uuid PRIMARY KEY,
  wallet_address text UNIQUE,
  public_key text,
  legacy boolean NOT NULL DEFAULT false,
  created safe_integer NOT NULL,
  CONSTRAINT organiser_wallet_pair CHECK (
    (wallet_address IS NULL AND public_key IS NULL AND legacy) OR
    (wallet_address IS NOT NULL AND public_key IS NOT NULL AND length(wallet_address)>0 AND public_key ~ '^[0-9a-f]{64}$')
  )
);
CREATE UNIQUE INDEX one_legacy_organiser ON organisers(legacy) WHERE legacy;
INSERT INTO organisers (id,wallet_address,public_key,legacy,created)
VALUES ('00000000-0000-4000-8000-000000000001',NULL,NULL,true,0);

ALTER TABLE campaigns ADD COLUMN organiser_id uuid;
ALTER TABLE sessions ADD COLUMN organiser_id uuid;

-- Preserve all pre-existing campaign ownership under the one legacy workspace.
-- The existing campaign trigger rejects ordinary updates and is restored in this
-- same migration transaction before the new schema is accepted.
ALTER TABLE campaigns DISABLE TRIGGER immutable_campaign;
UPDATE campaigns
SET organiser_id='00000000-0000-4000-8000-000000000001';
ALTER TABLE campaigns ENABLE TRIGGER immutable_campaign;

UPDATE sessions
SET organiser_id='00000000-0000-4000-8000-000000000001',
    expires=0;

ALTER TABLE campaigns ALTER COLUMN organiser_id SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN organiser_id SET NOT NULL;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_organiser_fk FOREIGN KEY (organiser_id) REFERENCES organisers(id);
ALTER TABLE sessions
  ADD CONSTRAINT sessions_organiser_fk FOREIGN KEY (organiser_id) REFERENCES organisers(id);
CREATE INDEX campaigns_organiser_created ON campaigns(organiser_id,created DESC);
CREATE INDEX sessions_organiser ON sessions(organiser_id);

CREATE TABLE organiser_auth_challenges (
  id text PRIMARY KEY,
  message text NOT NULL,
  expires safe_integer NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK (used IN (0,1))
);
CREATE INDEX organiser_auth_challenges_expires ON organiser_auth_challenges(expires);

CREATE FUNCTION guard_organiser_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.legacy IS DISTINCT FROM NEW.legacy
    OR OLD.created IS DISTINCT FROM NEW.created
    OR OLD.wallet_address IS NOT NULL OR OLD.public_key IS NOT NULL
    OR NEW.wallet_address IS NULL OR NEW.public_key IS NULL THEN
    RAISE EXCEPTION 'Organiser wallet identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_organiser_identity
  BEFORE UPDATE OR DELETE ON organisers
  FOR EACH ROW EXECUTE FUNCTION guard_organiser_identity();
CREATE TRIGGER keep_organisers_truncate
  BEFORE TRUNCATE ON organisers
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION guard_organiser_auth_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.message IS DISTINCT FROM NEW.message
    OR OLD.expires IS DISTINCT FROM NEW.expires
    OR OLD.used<>0 OR NEW.used<>1 THEN
    RAISE EXCEPTION 'Organiser authentication challenge is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_organiser_auth_challenge
  BEFORE UPDATE OR DELETE ON organiser_auth_challenges
  FOR EACH ROW EXECUTE FUNCTION guard_organiser_auth_challenge();
CREATE TRIGGER keep_organiser_auth_challenges_truncate
  BEFORE TRUNCATE ON organiser_auth_challenges
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
