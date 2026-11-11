import type { Pool } from "pg";
import { transaction } from "./db.js";

const reads: Record<string, true | string[]> = {
  schema_migrations: ["version", "checksum"],
  settings: true,
  organiser: true,
  sessions: true,
  campaigns: true,
  invitations: true,
  challenges: true,
  claims: true,
  events: true,
  campaign_wallets: ["campaign_id", "address", "created"],
  payment_intents: true,
  payment_attempts: true,
  payment_events: true,
  staging_rate: true,
};
const inserts: Record<string, true | string[]> = {
  sessions: true,
  campaigns: true,
  invitations: true,
  claims: true,
  staging_rate: true,
  challenges: ["id", "invitation_id", "message", "expires"],
  events: ["claim_id", "status", "at"],
  payment_events: ["attempt_id", "state", "reason", "at"],
};
const updates: Record<string, string[]> = {
  sessions: ["expires"],
  campaigns: ["id"],
  invitations: ["id"],
  challenges: ["used"],
  claims: ["status"],
  staging_rate: ["count", "until"],
  payment_attempts: ["state", "reason", "updated"],
};

export async function verifyRuntimeRole(pool: Pool, claimsOnlyMainnet = false) {
  const allowedReads: Record<string, true | string[]> = {
    ...reads,
    ...(claimsOnlyMainnet
      ? {
          organiser_challenges: true as const,
          organisers: true as const,
          organiser_auth_challenges: true as const,
        }
      : {}),
  };
  const allowedInserts: Record<string, true | string[]> = {
    ...inserts,
    ...(claimsOnlyMainnet
      ? {
          organiser_challenges: [
            "id",
            "campaign_id",
            "session_hash",
            "purpose",
            "message",
            "expires",
          ],
          organisers: ["id", "wallet_address", "public_key", "created"],
          organiser_auth_challenges: ["id", "message", "expires"],
          campaign_wallets: true as const,
        }
      : {}),
  };
  const allowedUpdates: Record<string, string[]> = {
    ...updates,
    ...(claimsOnlyMainnet
      ? {
          organiser_challenges: ["used"],
          organisers: ["wallet_address", "public_key"],
          organiser_auth_challenges: ["used"],
        }
      : {}),
  };
  if (claimsOnlyMainnet) {
    for (const table of [
      "payment_intents",
      "payment_attempts",
      "payment_events",
    ]) {
      delete allowedReads[table];
      delete allowedInserts[table];
      delete allowedUpdates[table];
    }
  }
  await transaction(pool, async (c) => {
    await c.query("SET TRANSACTION READ ONLY");
    const role = (
      await c.query(
        `SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin FROM pg_roles WHERE rolname=current_user`,
      )
    ).rows[0];
    if (
      role.name !== "nimclaim_app" ||
      !role.rolcanlogin ||
      [
        role.rolsuper,
        role.rolcreatedb,
        role.rolcreaterole,
        role.rolreplication,
        role.rolbypassrls,
        role.rolinherit,
      ].some(Boolean)
    )
      throw new Error("Restricted nimclaim_app login required");
    const escalation = (
      await c.query(`SELECT
      EXISTS(SELECT 1 FROM pg_roles WHERE rolname<>current_user AND pg_has_role(current_user,oid,'MEMBER')) AS membership,
      has_database_privilege(current_database(),'CREATE') OR has_database_privilege(current_database(),'TEMP') OR has_database_privilege(current_database(),'CONNECT WITH GRANT OPTION') AS database_create,
      has_parameter_privilege('session_replication_role','SET') OR has_parameter_privilege('allow_system_table_mods','SET') AS unsafe_parameters,
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND (has_schema_privilege(oid,'CREATE') OR has_schema_privilege(oid,'USAGE WITH GRANT OPTION'))) AS schema_create,
      EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owner,
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND (p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR p.prosecdef AND has_function_privilege(p.oid,'EXECUTE'))) AS definer,
      EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND t.typowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS type_owner
    `)
    ).rows[0];
    if (Object.values(escalation).some(Boolean))
      throw new Error("Runtime administrative access refused");
    const columns = (
      await c.query(`SELECT c.oid,c.relname,a.attname,a.attnum,
      has_column_privilege(c.oid,a.attnum,'SELECT') AS sel,
      has_column_privilege(c.oid,a.attnum,'INSERT') AS ins,
      has_column_privilege(c.oid,a.attnum,'UPDATE') AS upd,
      has_column_privilege(c.oid,a.attnum,'REFERENCES') AS ref,
      (has_column_privilege(c.oid,a.attnum,'SELECT WITH GRANT OPTION') OR has_column_privilege(c.oid,a.attnum,'INSERT WITH GRANT OPTION') OR has_column_privilege(c.oid,a.attnum,'UPDATE WITH GRANT OPTION')) AS delegation
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`)
    ).rows;
    for (const row of columns) {
      const ins = allowedInserts[row.relname];
      if (
        row.sel !==
          (allowedReads[row.relname] === true ||
            (Array.isArray(allowedReads[row.relname]) &&
              (allowedReads[row.relname] as string[]).includes(row.attname))) ||
        row.ins !==
          (ins === true || (Array.isArray(ins) && ins.includes(row.attname))) ||
        row.upd !==
          (allowedUpdates[row.relname]?.includes(row.attname) ?? false) ||
        row.ref ||
        row.delegation
      )
        throw new Error("Runtime column privilege mismatch");
    }
    const unsafe = (
      await c.query(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%' AND
      (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR
       (c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(c.oid,'DELETE') OR has_table_privilege(c.oid,'TRUNCATE') OR has_table_privilege(c.oid,'TRIGGER') OR has_table_privilege(c.oid,'MAINTAIN') OR (n.nspname<>'public' AND (has_any_column_privilege(c.oid,'INSERT') OR has_any_column_privilege(c.oid,'UPDATE'))))) OR
       (c.relkind='S' AND (has_sequence_privilege(c.oid,'USAGE') OR has_sequence_privilege(c.oid,'SELECT') OR has_sequence_privilege(c.oid,'UPDATE'))))) AS bad`)
    ).rows[0].bad;
    if (unsafe)
      throw new Error("Runtime ownership or unsafe object privileges refused");
  });
}
