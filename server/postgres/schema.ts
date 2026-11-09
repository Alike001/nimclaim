// Read-only schema validation, shared by runtime and explicit admin tooling.
import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transaction } from "./db.js";
import contract from "./schema-contract.json" with { type: "json" };

export const migrationDirectory = fileURLToPath(
  new URL("./migrations/", import.meta.url),
);
export function migrationPlan() {
  const files = readdirSync(migrationDirectory)
    .filter((f) => /^\d{3}_[a-z_]+\.sql$/.test(f))
    .sort();
  if (!files.length) throw new Error("Missing migration files");
  return files.map((file, index) => {
    const version = Number(file.slice(0, 3));
    if (version !== index + 1) throw new Error("Invalid migration sequence");
    return {
      version,
      checksum: createHash("sha256")
        .update(readFileSync(`${migrationDirectory}/${file}`))
        .digest("hex"),
    };
  });
}

export async function schemaHash(c: PoolClient) {
  // pg_get_* output is canonicalized by the same PostgreSQL 17 major and search path.
  await c.query("SET LOCAL search_path TO public,pg_catalog");
  const queries = [
    `SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname`,
    `SELECT c.relname,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname`,
    `SELECT c.relname,s.seqtypid::regtype::text AS type,s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname`,
    `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
    `SELECT co.conname,co.conrelid::regclass::text AS relation,co.convalidated,pg_get_constraintdef(co.oid) AS definition FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace WHERE n.nspname='public' ORDER BY relation,co.conname`,
    `SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    `SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname`,
    `SELECT t.typname,t.typtype,t.typbasetype::regtype::text AS base,t.typnotnull,t.typdefault FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='d' ORDER BY t.typname`,
  ];
  const shape = [];
  for (const sql of queries) shape.push((await c.query(sql)).rows);
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

export async function verifySchema(pool: Pool, requireOrganiser = true) {
  await transaction(pool, async (c) => {
    await c.query("SET TRANSACTION READ ONLY");
    const version = (await c.query("SHOW server_version_num")).rows[0]
      .server_version_num;
    if (Math.floor(Number(version) / 10000) !== contract.postgresMajor)
      throw new Error("Unsupported PostgreSQL major");
    const applied = (
      await c.query(
        "SELECT version,checksum FROM public.schema_migrations ORDER BY version",
      )
    ).rows;
    if (JSON.stringify(applied) !== JSON.stringify(migrationPlan()))
      throw new Error("Missing or incorrect schema migrations");
    if ((await schemaHash(c)) !== contract.sha256)
      throw new Error("Schema differs from reviewed migrations");
    const settings = (
      await c.query("SELECT key,value FROM public.settings ORDER BY key")
    ).rows;
    if (
      JSON.stringify(settings) !==
      JSON.stringify([
        { key: "deployment", value: "isolated-neon-testnet-staging-v1" },
        { key: "network", value: "testnet" },
      ])
    )
      throw new Error("Wrong staging identity/network");
    if (requireOrganiser) {
      const row = (
        await c.query("SELECT password_hash FROM public.organiser WHERE id=1")
      ).rows[0];
      if (!row || !/^[a-f0-9]{64}:[a-f0-9]{128}$/.test(row.password_hash))
        throw new Error("Staging organiser missing or invalid");
    }
  });
}
