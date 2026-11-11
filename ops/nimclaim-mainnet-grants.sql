-- Fresh separate MAINNET database only. No staging target. Runtime cannot reserve or confirm payments.
-- PROPOSED ONLY: do not run on hosted Neon until separately authorized.
-- A fresh nimclaim_app login must already exist without memberships or ownership.
-- Scope: nimclaim_mainnet, public schema. No role creation/passwords here.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'nimclaim_mainnet' OR NOT EXISTS (
    SELECT 1 FROM public.settings WHERE key = 'deployment' AND value = 'isolated-mainnet-claims-v1'
  ) THEN RAISE EXCEPTION 'Wrong MAINNET grant target'; END IF;
END $$;
REVOKE TEMPORARY ON DATABASE nimclaim_mainnet FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE nimclaim_mainnet TO nimclaim_app;
GRANT USAGE ON SCHEMA public TO nimclaim_app;
GRANT SELECT ON public.settings, public.organiser, public.organisers,
  public.organiser_auth_challenges, public.sessions, public.campaigns,
  public.invitations, public.challenges, public.claims, public.events,
  public.staging_rate TO nimclaim_app;
GRANT SELECT (version,checksum) ON public.schema_migrations TO nimclaim_app;
GRANT SELECT (campaign_id,address,created) ON public.campaign_wallets TO nimclaim_app;
GRANT INSERT ON public.sessions, public.campaigns, public.invitations,
  public.claims, public.staging_rate TO nimclaim_app;
GRANT INSERT (id,wallet_address,public_key,created) ON public.organisers TO nimclaim_app;
GRANT INSERT (id,message,expires) ON public.organiser_auth_challenges TO nimclaim_app;
GRANT INSERT (id,invitation_id,message,expires) ON public.challenges TO nimclaim_app;
GRANT INSERT (claim_id,status,at) ON public.events TO nimclaim_app;
GRANT UPDATE (expires) ON public.sessions TO nimclaim_app;
-- PostgreSQL requires UPDATE on at least one column for SELECT FOR UPDATE.
-- Campaign mutation is still blocked by the reviewed immutable trigger.
GRANT UPDATE (id) ON public.campaigns, public.invitations TO nimclaim_app;
GRANT UPDATE (used) ON public.challenges TO nimclaim_app;
GRANT UPDATE (status) ON public.claims TO nimclaim_app;
GRANT UPDATE (count,until) ON public.staging_rate TO nimclaim_app;
-- GENERATED ALWAYS AS IDENTITY inserts do not need sequence ACLs. No explicit
-- nextval/setval exists in the runtime; no sequence privileges are granted.
GRANT SELECT ON public.organiser_challenges TO nimclaim_app;
GRANT INSERT (id,campaign_id,session_hash,purpose,message,expires) ON public.organiser_challenges TO nimclaim_app;
GRANT UPDATE (used) ON public.organiser_challenges,
  public.organiser_auth_challenges TO nimclaim_app;
GRANT UPDATE (wallet_address,public_key) ON public.organisers TO nimclaim_app;
GRANT INSERT ON public.campaign_wallets TO nimclaim_app;
COMMIT;
