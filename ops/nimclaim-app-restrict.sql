-- PROPOSED ONLY. Requires explicit approval before hosted execution.
-- Exact target: late-dew-24158174 / br-lively-rice-b9pxx7a4 / nimclaim.
-- Connect as nimclaim_owner through the approved target; one transaction.
-- Existing role only. No password, migration, bootstrap or data changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
BEGIN
  IF current_database() <> 'nimclaim' OR current_user <> 'nimclaim_owner' THEN
    RAISE EXCEPTION 'Unexpected database or operator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nimclaim_app'
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'Unexpected runtime role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname <> 'nimclaim_app'
    AND pg_has_role('nimclaim_app',oid,'MEMBER')) THEN
    RAISE EXCEPTION 'Unexpected runtime membership';
  END IF;
END $$;
-- Branch-wide attribute change; no membership or password change.
ALTER ROLE nimclaim_app NOINHERIT;
-- Remove the scoped read_only provisioning grants before adding exact ACLs.
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM nimclaim_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nimclaim_owner IN SCHEMA public
  REVOKE SELECT ON TABLES FROM nimclaim_app;
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
