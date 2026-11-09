-- PROPOSED ONLY: do not run on hosted Neon until separately authorized.
-- A fresh nimclaim_app login must already exist without memberships or ownership.
-- Scope: approved nimclaim database, public schema. No role creation/passwords here.
BEGIN;
REVOKE TEMPORARY ON DATABASE nimclaim FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE nimclaim TO nimclaim_app;
GRANT USAGE ON SCHEMA public TO nimclaim_app;
GRANT SELECT ON public.settings, public.organiser,
  public.sessions, public.campaigns, public.invitations, public.challenges,
  public.claims, public.events, public.payment_intents,
  public.payment_attempts, public.payment_events, public.staging_rate TO nimclaim_app;
GRANT SELECT (version,checksum) ON public.schema_migrations TO nimclaim_app;
GRANT SELECT (campaign_id,address,created) ON public.campaign_wallets TO nimclaim_app;
GRANT INSERT ON public.sessions, public.campaigns, public.invitations,
  public.claims, public.staging_rate TO nimclaim_app;
GRANT INSERT (id,invitation_id,message,expires) ON public.challenges TO nimclaim_app;
GRANT INSERT (claim_id,status,at) ON public.events TO nimclaim_app;
GRANT INSERT (attempt_id,state,reason,at) ON public.payment_events TO nimclaim_app;
GRANT UPDATE (expires) ON public.sessions TO nimclaim_app;
-- PostgreSQL requires UPDATE on at least one column for SELECT FOR UPDATE.
-- Campaign mutation is still blocked by the reviewed immutable trigger.
GRANT UPDATE (id) ON public.campaigns, public.invitations TO nimclaim_app;
GRANT UPDATE (used) ON public.challenges TO nimclaim_app;
GRANT UPDATE (status) ON public.claims TO nimclaim_app;
GRANT UPDATE (count,until) ON public.staging_rate TO nimclaim_app;
GRANT UPDATE (state,reason,updated) ON public.payment_attempts TO nimclaim_app;
-- GENERATED ALWAYS AS IDENTITY inserts do not need sequence ACLs. No explicit
-- nextval/setval exists in the runtime; no sequence privileges are granted.
COMMIT;
