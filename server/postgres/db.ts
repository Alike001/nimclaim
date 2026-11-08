import { Pool, types, type PoolConfig, type PoolClient } from "pg";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function safeNumber(raw: string) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new Error("Database integer outside safe range");
  return value;
}
export const integerTypes = {
  getTypeParser(oid: number, format?: string) {
    return oid === 20 ? safeNumber : types.getTypeParser(oid, format as "text");
  },
};
export function neonConnection(
  raw: string | undefined,
  pooled: boolean,
): PoolConfig {
  try {
    if (!raw) throw new Error();
    const url = new URL(raw);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) ||
      url.hostname.includes("-pooler.") !== pooled ||
      !url.username ||
      !url.password ||
      !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname) ||
      (url.port && url.port !== "5432") ||
      url.hash
    )
      throw new Error();
    for (const [key, value] of url.searchParams) {
      if (
        !(key === "sslmode" && ["require", "verify-full"].includes(value)) &&
        !(key === "channel_binding" && value === "require")
      )
        throw new Error();
    }
    // Parse explicitly: pg must never replace the verified TLS object with URL sslmode options.
    return {
      host: url.hostname,
      port: 5432,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      ssl: { rejectUnauthorized: true, servername: url.hostname },
      enableChannelBinding: true,
      max: pooled ? 3 : 1,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 10_000,
      query_timeout: 15_000,
      types: integerTypes,
    };
  } catch {
    throw new Error(
      `A valid ${pooled ? "pooled DATABASE_URL" : "direct DIRECT_DATABASE_URL"} with verified Neon TLS is required`,
    );
  }
}
export function createPool(config: PoolConfig) {
  const pool = new Pool({ ...config, types: integerTypes });
  // Driver errors can contain connection details or SQL values. Never log them.
  pool.on("error", () => console.error("Database connection unavailable"));
  return pool;
}
export async function transaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    // Never retry a transaction with an uncertain COMMIT result automatically.
    throw error;
  } finally {
    client.release(broken);
  }
}
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
    await c.query(
      "INSERT INTO organiser VALUES (1,$1) ON CONFLICT(id) DO NOTHING",
      [hash],
    );
    if (
      (await c.query("SELECT password_hash FROM organiser WHERE id=1")).rows[0]
        ?.password_hash !== hash
    )
      throw new Error(
        "Staging credential mismatch; credentials are never overwritten",
      );
  });
}
