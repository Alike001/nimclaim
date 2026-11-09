import { Pool, types, type PoolConfig, type PoolClient } from "pg";

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
    await client.query("SET LOCAL search_path TO public,pg_catalog");
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
