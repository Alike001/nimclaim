-- Immutable receipts for exact external NIM transfers independently verified on MAINNET.
CREATE TABLE manual_payment_receipts (
  id text PRIMARY KEY,
  claim_id text NOT NULL UNIQUE REFERENCES claims(id),
  campaign_id text NOT NULL REFERENCES campaigns(id),
  hash text NOT NULL UNIQUE CHECK (hash ~ '^[a-f0-9]{64}$'),
  sender text NOT NULL,
  recipient text NOT NULL,
  amount safe_integer NOT NULL CHECK (amount > 0),
  fee safe_integer NOT NULL CHECK (fee >= 0),
  network text NOT NULL CHECK (network = 'mainnet'),
  validity_start_height safe_integer NOT NULL CHECK (validity_start_height >= 0),
  block_number safe_integer NOT NULL CHECK (block_number > 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^[a-f0-9]{64}$'),
  macro_number safe_integer NOT NULL CHECK (macro_number > block_number),
  macro_hash text NOT NULL CHECK (macro_hash ~ '^[a-f0-9]{64}$'),
  verified_at safe_integer NOT NULL
);
CREATE INDEX manual_payment_receipts_campaign ON manual_payment_receipts(campaign_id, verified_at DESC);
CREATE TRIGGER immutable_manual_payment_receipt
  BEFORE UPDATE OR DELETE ON manual_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER keep_manual_payment_receipts_truncate
  BEFORE TRUNCATE ON manual_payment_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
GRANT SELECT, INSERT ON public.manual_payment_receipts TO nimclaim_app;
