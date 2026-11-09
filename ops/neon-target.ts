// Operator-only verification target. Never imported by the hosted application.
import { lstatSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { checkServerIdentity, type TLSSocket } from "node:tls";
import type { Pool, PoolConfig } from "pg";
import { neonConnection } from "../server/postgres/db.js";

export function approvedConnections() {
  const path = ".local/neon-staging.env";
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("Protected regular credential file required");
  execFileSync("git", ["check-ignore", "--quiet", path], { stdio: "pipe" });
  if (execFileSync("git", ["ls-files", "--", path]).length)
    throw new Error("Credential file must be untracked");
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("TLS verification required");
  const env = parseEnv(readFileSync(path, "utf8"));
  const direct = neonConnection(env.DIRECT_DATABASE_URL, false);
  const runtime = neonConnection(env.DATABASE_URL, true);
  for (const [config, pooled] of [
    [direct, false],
    [runtime, true],
  ] as const) {
    if (
      config.database !== "nimclaim" ||
      config.host !==
        `ep-royal-sunset-b9d4cl7u${pooled ? "-pooler" : ""}.c-7.eu-central-1.aws.neon.tech`
    )
      throw new Error("Unapproved endpoint/database");
  }
  return { direct, runtime };
}

export async function verifyConnection(pool: Pool, config: PoolConfig) {
  const client = await pool.connect();
  try {
    const socket = (client as unknown as { connection: { stream: TLSSocket } })
      .connection.stream;
    if (!socket.encrypted || !socket.authorized)
      throw new Error("Verified TLS required");
    const cert = socket.getPeerCertificate();
    if (
      checkServerIdentity(String(config.host), cert) ||
      !checkServerIdentity("wrong-host.invalid", cert)
    )
      throw new Error("Certificate hostname verification failed");
    if (
      (await client.query("SELECT current_database() AS name")).rows[0].name !==
      "nimclaim"
    )
      throw new Error("Wrong database");
  } finally {
    client.release();
  }
}

export function isolatedConfig(config: PoolConfig, schema: string): PoolConfig {
  if (!/^nimclaim_verify_[a-f0-9]{16}$/.test(schema))
    throw new Error("Isolated synthetic schema required");
  // Direct connection only: PgBouncer cannot preserve session search_path.
  // No public fallback, so a missing schema fails closed.
  return { ...config, options: `-c search_path=${schema}` };
}
