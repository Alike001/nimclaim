-- Fresh, independent MAINNET database. No importer or sample records.
CREATE DOMAIN safe_integer AS bigint CHECK (VALUE BETWEEN -9007199254740991 AND 9007199254740991);
CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO settings VALUES ('network','mainnet'), ('deployment','isolated-mainnet-claims-v1');
CREATE TABLE organiser (id integer PRIMARY KEY CHECK(id=1), password_hash text NOT NULL);
CREATE TABLE sessions (hash text PRIMARY KEY, expires safe_integer NOT NULL);
CREATE TABLE campaigns (
  id text PRIMARY KEY, title text NOT NULL, description text NOT NULL,
  amount safe_integer NOT NULL CHECK(amount>0), slots integer NOT NULL CHECK(slots BETWEEN 1 AND 1000),
  expires safe_integer NOT NULL, created safe_integer NOT NULL);
CREATE TABLE invitations (
  id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES campaigns(id),
  token_hash text NOT NULL UNIQUE, created safe_integer NOT NULL);
CREATE TABLE challenges (
  id text PRIMARY KEY, invitation_id text NOT NULL REFERENCES invitations(id),
  message text NOT NULL, expires safe_integer NOT NULL, used integer NOT NULL DEFAULT 0 CHECK(used IN (0,1)));
CREATE TABLE claims (
  id text PRIMARY KEY, invitation_id text NOT NULL UNIQUE REFERENCES invitations(id),
  campaign_id text NOT NULL REFERENCES campaigns(id), address text NOT NULL,
  public_key text NOT NULL, signature text NOT NULL, challenge_id text NOT NULL UNIQUE REFERENCES challenges(id),
  status text NOT NULL CHECK(status IN ('pending','payment-ready','rejected','expired')),
  created safe_integer NOT NULL, UNIQUE(campaign_id,address));
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id text NOT NULL REFERENCES claims(id), status text NOT NULL, at safe_integer NOT NULL);
CREATE INDEX challenges_invitation ON challenges(invitation_id);
CREATE INDEX claims_campaign ON claims(campaign_id);
CREATE INDEX invitations_campaign ON invitations(campaign_id);
CREATE INDEX events_claim ON events(claim_id,id);
CREATE INDEX sessions_expires ON sessions(expires);
