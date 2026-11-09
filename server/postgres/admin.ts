// Administrative tasks only. Never imported by runtime startup or the HTTP API.
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transaction } from "./db.js";
export const migrationDirectory = fileURLToPath(
  new URL("./migrations/", import.meta.url),
);
export async function migrate(pool: Pool, directory = migrationDirectory) {
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(786324109)");
    const tables = (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      )
    ).rows.map((r) => r.tablename);
    if (tables.length && !tables.includes("schema_migrations"))
      throw new Error("Refusing a nonempty, unrelated database");
    if (tables.includes("schema_migrations")) {
      const marker = await client.query(
        "SELECT value FROM settings WHERE key='deployment'",
      );
      if (marker.rows[0]?.value !== "isolated-neon-testnet-staging-v1")
        throw new Error("Wrong staging database");
    }
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = readdirSync(directory)
      .filter((f) => /^\d{3}_[a-z_]+\.sql$/.test(f))
      .sort();
    const applied = (
      await client.query(
        "SELECT version,checksum FROM schema_migrations ORDER BY version",
      )
    ).rows;
    if (!files.length || applied.length > files.length)
      throw new Error("Unsupported migration version");
    for (let i = 0; i < files.length; i++) {
      const version = Number(files[i].slice(0, 3));
      if (version !== i + 1)
        throw new Error("Migration sequence is not contiguous");
      const sql = readFileSync(`${directory}/${files[i]}`, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (i < applied.length) {
        if (applied[i].version !== version || applied[i].checksum !== checksum)
          throw new Error("Applied migration checksum/version mismatch");
      } else {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)",
          [version, checksum],
        );
      }
    }
  });
}
export async function bootstrap(pool: Pool, hash: string) {
  if (!/^[a-f0-9]{64}:[a-f0-9]{128}$/.test(hash))
    throw new Error("Invalid staging organiser hash");
  await transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(786324109)");
    const settings = (await c.query("SELECT key,value FROM settings")).rows;
    if (
      !settings.some((r) => r.key === "network" && r.value === "testnet") ||
      !settings.some(
        (r) =>
          r.key === "deployment" &&
          r.value === "isolated-neon-testnet-staging-v1",
      )
    )
      throw new Error("Wrong staging identity/network");
    if ((await c.query("SELECT id FROM organiser")).rowCount)
      throw new Error(
        "Staging organiser already exists; credentials are never overwritten",
      );
    await c.query("INSERT INTO organiser VALUES (1,$1)", [hash]);
  });
}
