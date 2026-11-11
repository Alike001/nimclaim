import { verifySchema } from "../../server/postgres/schema.js";
import { verifyRuntimeRole } from "../../server/postgres/permissions.js";
import {
  migrate,
  bootstrap,
  migrationDirectory,
} from "../../server/postgres/admin.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import {
  createPool,
  neonConnection,
  safeNumber,
} from "../../server/postgres/db.js";
import {
  postgresStagingConfig,
  stagingOrigin,
} from "../../server/postgres/staging.js";
import { passwordHash } from "../../server/crypto.js";
import { encryptedDump, restoreDump } from "../../ops/postgres-backup.js";
import { testSigner } from "../helpers.js";
import type { Pool } from "pg";

const port = Number(process.env.NIMCLAIM_PG_TEST_PORT);
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  !process.env.NIMCLAIM_PG_TEST_CONTAINER?.startsWith("nimclaim-pg-test-")
)
  throw new Error("Run through npm run test:postgres only");
const origin = "https://nimclaim-testnet-staging.onrender.com";
const password = "synthetic-postgres-only",
  hash = passwordHash(password);
let admin = createPool({
  host: "127.0.0.1",
  port,
  user: "postgres",
  database: "nimclaim_test",
  max: 2,
});
const databasePools = new Map<string, Pool[]>();
const databaseWorkers = new Map<string, Array<() => Promise<void>>>();
function poolFor(database: string) {
  const pool = createPool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    max: 3,
  });
  databasePools.set(database, [...(databasePools.get(database) ?? []), pool]);
  return pool;
}
async function grantRuntime(pool: Pool, name: string) {
  if (!/^nimclaim_test_[a-z0-9_]+$/.test(name))
    throw new Error("Disposable database required");
  const sql = readFileSync("ops/nimclaim-app-grants.sql", "utf8").replaceAll(
    "ON DATABASE nimclaim",
    `ON DATABASE ${name}`,
  );
  await pool.query(sql);
}
function runtimePool(name: string) {
  const pool = createPool({
    host: "127.0.0.1",
    port,
    user: "nimclaim_app",
    database: name,
    max: 3,
  });
  databasePools.set(name, [...(databasePools.get(name) ?? []), pool]);
  return pool;
}
test.before(async () => {
  // Role fixture exists only inside the disposable loopback Docker container.
  await admin.query(
    "CREATE ROLE nimclaim_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
  );
});
async function database(t: { after: Function }, initialize = true) {
  const name = "nimclaim_test_" + randomBytes(6).toString("hex");
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = poolFor(name);
  t.after(async () => {
    for (const stop of databaseWorkers.get(name) ?? []) await stop();
    for (const connection of databasePools.get(name) ?? [])
      await connection.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    databaseWorkers.delete(name);
    databasePools.delete(name);
  });
  if (initialize) {
    await migrate(pool);
    await bootstrap(pool, hash);
    await grantRuntime(pool, name);
  }
  return { name, pool };
}
async function worker(name: string, appOrigin = origin, mainnet = false) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/postgres/worker.ts"],
    {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: {
        ...process.env,
        NIMCLAIM_PG_TEST_DB: name,
        NIMCLAIM_PG_TEST_ORIGIN: appOrigin,
        NIMCLAIM_PG_TEST_MAINNET: mainnet ? "1" : "0",
      },
    },
  );
  const ended = once(child, "exit");
  const ready = await Promise.race([
    once(child, "message").then(
      ([r]) => r as { port: number; backend: number },
    ),
    ended.then(() => {
      throw new Error("Worker exited before readiness");
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Worker readiness timed out")),
        20000,
      );
      timer.unref();
    }),
  ]);
  const processHandle = {
    child,
    port: ready.port,
    backend: ready.backend,
    async stop(signal: NodeJS.Signals = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        await ended;
      }
    },
  };
  databaseWorkers.set(name, [
    ...(databaseWorkers.get(name) ?? []),
    () => processHandle.stop(),
  ]);
  return processHandle;
}
function client(apiPort: number, appOrigin = origin) {
  let cookie = "";
  async function call(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return new Promise<{
      status: number;
      body: any;
      headers: import("node:http").IncomingHttpHeaders;
    }>((ok, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: apiPort,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: new URL(appOrigin).host,
            Origin: appOrigin,
            "Content-Type": "application/json",
            Cookie: cookie,
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (v) => {
            data += v;
          });
          res.on("end", () =>
            ok({
              status: res.statusCode!,
              body: data ? JSON.parse(data) : null,
              headers: res.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return {
    call,
    async login() {
      const r = await call("/api/login", { password });
      assert.equal(r.status, 200);
      cookie = r.headers["set-cookie"]![0].split(";")[0];
      return r;
    },
    async walletLogin(signer = testSigner(), legacyPassword?: string) {
      const challenge = await call("/api/auth/challenge", {});
      assert.equal(challenge.status, 201);
      const proof = {
        challengeId: challenge.body.id,
        publicKey: signer.publicKey,
        signature: signer.sign(challenge.body.message),
        ...(legacyPassword === undefined ? {} : { legacyPassword }),
      };
      const r = await call("/api/auth/verify", proof);
      assert.equal(r.status, 200);
      cookie = r.headers["set-cookie"]![0].split(";")[0];
      return { ...r, signer };
    },
  };
}
async function campaign(
  c: ReturnType<typeof client>,
  slots = 3,
  amount = "0.12345",
) {
  const r = await c.call("/api/campaigns", {
    title: "Synthetic staged campaign",
    description: "Generated test records only",
    amount,
    slots,
    expires: Date.now() + 3600000,
  });
  assert.equal(r.status, 201);
  return r.body.campaign;
}
async function invitation(c: ReturnType<typeof client>, id: string) {
  const r = await c.call(`/api/campaigns/${id}/invitations`, {});
  assert.equal(r.status, 201);
  assert.equal(new URL(r.body.url).origin, origin);
  return new URL(r.body.url).hash.slice(7);
}
async function proof(
  c: ReturnType<typeof client>,
  token: string,
  signer = testSigner(),
) {
  const r = await c.call("/api/challenge", { token });
  assert.equal(r.status, 201);
  return {
    challenge: r.body,
    body: {
      token,
      challengeId: r.body.id,
      publicKey: signer.publicKey,
      signature: signer.sign(r.body.message),
    },
  };
}

test("production requires only restricted pooled TLS and refuses administrative secrets or SQLite/payment downgrades", () => {
  // Reserved synthetic credentials/endpoint, never connected to a service.
  const fixture = new URL(
    "postgresql://synthetic:example-only@ep-synthetic-pooler.eu-central-1.aws.neon.tech/nimclaim?sslmode=require&channel_binding=require",
  );
  fixture.username = "nimclaim_app";
  fixture.hostname =
    "ep-royal-sunset-b9d4cl7u-pooler.c-7.eu-central-1.aws.neon.tech";
  const base = {
    NODE_ENV: "production",
    NIMCLAIM_STAGING: "1",
    APP_ORIGIN: origin,
    NETWORK: "testnet",
    SPENDING_ENABLED: "false",
    DATABASE_URL: fixture.toString(),
  };
  const config = postgresStagingConfig(base);
  assert.equal(
    postgresStagingConfig({
      ...base,
      APP_ORIGIN: undefined,
      RENDER: "true",
      RENDER_EXTERNAL_URL: origin,
    }).origin,
    origin,
  );
  assert.deepEqual(config.runtime.ssl, {
    rejectUnauthorized: true,
    servername: fixture.hostname,
  });
  assert.equal(config.runtime.max, 3);
  for (const patch of [
    { DATABASE_URL: "" },
    { DIRECT_DATABASE_URL: "forbidden" },
    { STAGING_ORGANISER_PASSWORD_HASH: hash },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { DATABASE_PATH: ":memory:" },
    { NETWORK: "mainnet" },
    { SPENDING_ENABLED: "true" },
    { RPC_URL: "https://rpc.example" },
    { SPENDING_NETWORK: "testnet" },
    { MAX_PAYMENT_LUNA: "1" },
    { APP_ORIGIN: origin + "/" },
    { DATABASE_URL: base.DATABASE_URL.replace("/nimclaim", "/other") },
    { DATABASE_URL: base.DATABASE_URL.replace("nimclaim_app", "owner") },
    { NODE_ENV: "development" },
  ])
    assert.throws(() => postgresStagingConfig({ ...base, ...patch }));
  for (const url of [
    base.DATABASE_URL.replace("require&", "disable&"),
    base.DATABASE_URL + "&sslrootcert=secret",
    base.DATABASE_URL.replace(".neon.tech", ".evil.example"),
    "postgres://secret:password@localhost/db",
  ])
    assert.throws(
      () => neonConnection(url, true),
      (err) => !String(err).includes("password@"),
    );
  assert.equal(safeNumber("9007199254740991"), 9007199254740991);
  assert.throws(() => safeNumber("9007199254740992"));
});

test("real migrations run twice, serialize across clients and preserve data/checksums", async (t) => {
  const { pool, name } = await database(t, false);
  const other = poolFor(name);
  await Promise.all([migrate(pool), migrate(other)]);
  await bootstrap(pool, hash);
  const before = (await pool.query("SELECT * FROM organiser")).rows;
  await migrate(pool);
  await assert.rejects(bootstrap(pool, hash), /never overwritten/);
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM schema_migrations")).rows[0].n,
    3,
  );
  assert.deepEqual((await pool.query("SELECT * FROM organiser")).rows, before);
  await assert.rejects(
    bootstrap(pool, passwordHash("different")),
    /never overwritten/,
  );
  assert.deepEqual((await pool.query("SELECT * FROM organiser")).rows, before);
});

test("failed multi-file migration rolls back DDL and recovers cleanly; unrelated database is untouched", async (t) => {
  const { pool } = await database(t, false);
  const dir = mkdtempSync(join(tmpdir(), "nimclaim-pg-migrations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(migrationDirectory, dir, { recursive: true });
  writeFileSync(
    join(dir, "004_failure.sql"),
    "CREATE TABLE should_rollback(id integer); SELECT missing_migration_function();",
  );
  await assert.rejects(migrate(pool, dir));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'",
      )
    ).rows[0].n,
    0,
  );
  await migrate(pool);
  await migrate(pool);
  await assert.rejects(migrate(pool, dir));
  assert.equal(
    (await pool.query("SELECT to_regclass('public.should_rollback') AS name"))
      .rows[0].name,
    null,
  );
  writeFileSync(
    join(dir, "004_failure.sql"),
    "CREATE TABLE recovered_migration(id integer);",
  );
  await migrate(pool, dir);
  await migrate(pool, dir);
  const checksums = (
    await pool.query("SELECT * FROM schema_migrations ORDER BY version")
  ).rows;
  writeFileSync(
    join(dir, "001_claims.sql"),
    readFileSync(join(dir, "001_claims.sql"), "utf8") +
      "\n-- edited applied migration\n",
  );
  await assert.rejects(migrate(pool, dir), /checksum/);
  assert.deepEqual(
    (await pool.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
    checksums,
  );
  const unrelated = await database(t, false);
  await unrelated.pool.query(
    "CREATE TABLE personal_records(value text); INSERT INTO personal_records VALUES ('synthetic-preserve')",
  );
  await assert.rejects(migrate(unrelated.pool), /unrelated/);
  assert.equal(
    (await unrelated.pool.query("SELECT value FROM personal_records")).rows[0]
      .value,
    "synthetic-preserve",
  );
});

test("two real API processes preserve auth, Origin, signatures, private routes and single-consumption claims", async (t) => {
  const { name, pool } = await database(t);
  const a = await worker(name),
    b = await worker(name);
  t.after(() => a.stop());
  t.after(() => b.stop());
  const x = client(a.port),
    y = client(b.port);
  assert.equal((await x.call("/api/campaigns")).status, 401);
  assert.equal(
    (
      await x.call(
        "/api/login",
        { password },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const login = await x.login();
  await y.login();
  assert.match(
    login.headers["set-cookie"]![0],
    /HttpOnly; SameSite=Strict.*Secure/,
  );
  assert.equal(
    (await x.call("/api/config", undefined, { Host: "evil.example" })).status,
    404,
  );
  for (const route of [
    "/api/debug",
    "/api/diagnostics",
    "/.env",
    "/api/config?debug=1",
  ])
    assert.equal((await x.call(route)).status, 404);
  const c = await campaign(x),
    token = await invitation(x, c.id),
    p = await proof(x, token);
  const binding = JSON.parse(p.challenge.message);
  assert.equal(binding.origin, origin);
  assert.equal(binding.network, "testnet");
  assert.equal(binding.amountLuna, 12345);
  const wrong = testSigner();
  assert.equal(
    (
      await x.call("/api/claim", {
        ...p.body,
        signature: wrong.sign(p.challenge.message),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await pool.query("SELECT used FROM challenges WHERE id=$1", [
        p.challenge.id,
      ])
    ).rows[0].used,
    0,
  );
  const results = await Promise.all([
    x.call("/api/claim", p.body),
    y.call("/api/claim", p.body),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const claim = results.find((r) => r.status === 201)!.body.claim;
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM claims")).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM events")).rows[0].n,
    1,
  );
  const decisions = await Promise.all([
    x.call(`/api/claims/${claim.id}/decision`, { decision: "payment-ready" }),
    y.call(`/api/claims/${claim.id}/decision`, { decision: "rejected" }),
  ]);
  assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM events")).rows[0].n,
    2,
  );
  for (const route of [
    `/api/claims/${claim.id}/payment/reserve`,
    `/api/payments/${claim.id}/dispatch`,
    `/api/campaigns/${c.id}/wallet/challenge`,
    `/api/payments/${claim.id}/reconcile`,
  ]) {
    assert.equal((await x.call(route, {})).status, 404);
    assert.equal((await client(a.backend).call(route, {})).status, 403);
  }
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM payment_attempts")).rows[0].n,
    0,
  );
  const data = (await x.call(`/api/campaigns/${c.id}`)).body;
  assert.equal(data.staging, true);
  assert.equal(data.paymentGate.enabled, false);
  assert.equal(data.paymentGate.senderBindingSupported, false);
  assert.equal(data.paymentGate.htlcVerificationSupported, false);
  assert.equal(JSON.stringify(data).includes(token), false);
});

test("derived Render origin binds gateway, config, cookies, invitations and signed claims without payment access", async (t) => {
  const { name, pool } = await database(t);
  const derived = stagingOrigin({
    RENDER: "true",
    RENDER_EXTERNAL_URL: "https://nimclaim-testnet-staging-64nl.onrender.com",
  });
  const a = await worker(name, derived);
  const x = client(a.port, derived);
  const config = await x.call("/api/config");
  assert.equal(config.body.origin, derived);
  assert.equal(config.body.network, "testnet");
  assert.equal(config.headers["access-control-allow-origin"], undefined);
  assert.equal(
    (
      await x.call("/api/config", undefined, {
        Host: "evil.example",
        "X-Forwarded-Host": new URL(derived).host,
        "X-Forwarded-Proto": "https",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await x.call(
        "/api/login",
        { password },
        {
          Origin: "https://evil.example",
          "X-Forwarded-Host": new URL(derived).host,
        },
      )
    ).status,
    403,
  );
  const login = await x.login();
  const cookie = login.headers["set-cookie"]![0];
  assert.match(cookie, /Path=\/api; HttpOnly; SameSite=Strict;.*Secure/);
  assert.doesNotMatch(cookie, /Domain=/i); // Host-only session for the derived host.
  assert.equal(
    (
      await x.call("/api/config", undefined, {
        "X-Forwarded-Host": "evil.example",
        "X-Forwarded-Proto": "http",
        Forwarded: "host=evil.example;proto=http",
      })
    ).body.origin,
    derived,
  );
  const c = await campaign(x);
  const invite = await x.call(`/api/campaigns/${c.id}/invitations`, {});
  assert.equal(invite.status, 201);
  assert.equal(new URL(invite.body.url).origin, derived);
  const token = new URL(invite.body.url).hash.slice(7);
  const signer = testSigner();
  const p = await proof(x, token, signer);
  const binding = JSON.parse(p.challenge.message);
  assert.equal(binding.origin, derived);
  assert.equal(binding.network, "testnet");
  assert.equal(
    (
      await x.call("/api/claim", {
        ...p.body,
        signature: signer.sign(JSON.stringify({ ...binding, origin })),
      })
    ).status,
    401,
  );
  // A correctly signed proof from this host is unusable at another exact origin.
  const other = "https://nimclaim-other-test.onrender.com";
  const b = await worker(name, other);
  assert.equal(
    (await client(b.port, other).call("/api/claim", p.body)).status,
    409,
  );
  assert.equal(
    (
      await pool.query("SELECT used FROM challenges WHERE id=$1", [
        p.challenge.id,
      ])
    ).rows[0].used,
    0,
  );
  const claim = await x.call("/api/claim", p.body);
  assert.equal(claim.status, 201);
  for (const route of [
    `/api/claims/${claim.body.claim.id}/payment/reserve`,
    `/api/payments/${claim.body.claim.id}/dispatch`,
    `/api/campaigns/${c.id}/wallet/challenge`,
    `/api/payments/${claim.body.claim.id}/reconcile`,
  ]) {
    assert.equal((await x.call(route, {})).status, 404);
    assert.equal(
      (await client(a.backend, derived).call(route, {})).status,
      403,
    );
  }
  assert.equal(
    (await x.call(`/api/campaigns/${c.id}`)).body.paymentGate.enabled,
    false,
  );
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM payment_attempts")).rows[0].n,
    0,
  );
});

test("cross-process campaign slot allocation, concurrent challenge refresh and unique wallet/campaign are serialized", async (t) => {
  const { name, pool } = await database(t);
  const a = await worker(name),
    b = await worker(name);
  t.after(() => a.stop());
  t.after(() => b.stop());
  const x = client(a.port),
    y = client(b.port);
  await x.login();
  await y.login();
  const single = await campaign(x, 1);
  const issued = await Promise.all([
    x.call(`/api/campaigns/${single.id}/invitations`, {}),
    y.call(`/api/campaigns/${single.id}/invitations`, {}),
  ]);
  assert.deepEqual(issued.map((r) => r.status).sort(), [201, 409]);
  const token = new URL(
    issued.find((r) => r.status === 201)!.body.url,
  ).hash.slice(7);
  const challenges = await Promise.all([
    x.call("/api/challenge", { token }),
    y.call("/api/challenge", { token }),
  ]);
  assert.deepEqual(
    challenges.map((r) => r.status),
    [201, 201],
  );
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM challenges WHERE used=0"))
      .rows[0].n,
    1,
  );
  const signer = testSigner(),
    latest = (await pool.query("SELECT * FROM challenges WHERE used=0"))
      .rows[0];
  const stale = challenges.find((r) => r.body.id !== latest.id)!.body;
  assert.equal(
    (
      await x.call("/api/claim", {
        token,
        challengeId: stale.id,
        publicKey: signer.publicKey,
        signature: signer.sign(stale.message),
      })
    ).status,
    409,
  );
  const c = await campaign(x, 2),
    ta = await invitation(x, c.id),
    tb = await invitation(x, c.id),
    pa = await proof(x, ta, signer),
    pb = await proof(y, tb, signer);
  const result = await Promise.all([
    x.call("/api/claim", pa.body),
    y.call("/api/claim", pb.body),
  ]);
  assert.deepEqual(result.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) AS n FROM claims WHERE campaign_id=$1",
        [c.id],
      )
    ).rows[0].n,
    1,
  );
  const loser = result[0].status === 409 ? pa : pb;
  assert.equal(
    (
      await pool.query("SELECT used FROM challenges WHERE id=$1", [
        loser.challenge.id,
      ])
    ).rows[0].used,
    0,
  );
});

test("killed process and complete replacement preserve organiser, hashed session, exact amount, invitation and approved claim", async (t) => {
  const { name, pool } = await database(t);
  const a = await worker(name);
  t.after(() => a.stop());
  const x = client(a.port);
  const originalLogin = await x.login();
  const c = await campaign(x, 1, "99999999.99999"),
    token = await invitation(x, c.id),
    p = await proof(x, token);
  const claimed = await x.call("/api/claim", p.body);
  assert.equal(claimed.status, 201);
  await x.call(`/api/claims/${claimed.body.claim.id}/decision`, {
    decision: "payment-ready",
  });
  const session = (await pool.query("SELECT hash FROM sessions")).rows[0].hash;
  assert.match(session, /^[a-f0-9]{64}$/);
  await a.stop("SIGKILL");
  const b = await worker(name);
  t.after(() => b.stop());
  const y = client(b.port);
  assert.equal(
    (
      await y.call("/api/session", undefined, {
        Cookie: originalLogin.headers["set-cookie"]![0].split(";")[0],
      })
    ).body.authenticated,
    true,
  );
  await y.login();
  assert.equal(
    (await y.call(`/api/campaigns/${c.id}`)).body.campaign.amount,
    9999999999999,
  );
  const record = (await y.call("/api/invitation", { token })).body.claim;
  assert.equal(record.status, "payment-ready");
  assert.deepEqual(
    record.history.map((r: any) => r.status),
    ["pending", "payment-ready"],
  );
  assert.equal((await y.call("/api/claim", p.body)).status, 409);
  assert.equal(
    (
      await pool.query("SELECT count(*) AS n FROM sessions WHERE hash=$1", [
        session,
      ])
    ).rows[0].n,
    1,
  );
  await assert.rejects(pool.query("SELECT 9007199254740992::safe_integer"));
  assert.equal(
    (await pool.query("SELECT 9007199254740991::safe_integer AS n")).rows[0].n,
    9007199254740991,
  );
});

test("durable security rate buckets survive process replacement and forwarded IP spoofing", async (t) => {
  const { name, pool } = await database(t);
  const a = await worker(name),
    b = await worker(name);
  t.after(() => a.stop());
  t.after(() => b.stop());
  const x = client(a.port),
    y = client(b.port);
  const calls = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? x : y).call(
        "/api/login",
        { password: "wrong" },
        { "X-Forwarded-For": `10.0.0.${i + 1}` },
      ),
    ),
  );
  assert.equal(calls.filter((r) => r.status === 401).length, 10);
  assert.equal(calls.filter((r) => r.status === 429).length, 2);
  await a.stop();
  const replacement = await worker(name);
  t.after(() => replacement.stop());
  assert.equal(
    (await client(replacement.port).call("/api/login", { password })).status,
    429,
  );
  assert.equal(
    (await pool.query("SELECT count FROM staging_rate WHERE key='login'"))
      .rows[0].count,
    13,
  );
  await pool.query(
    "INSERT INTO staging_rate VALUES ('api',180,$1) ON CONFLICT(key) DO UPDATE SET count=180,until=$1",
    [Date.now() + 60000],
  );
  assert.equal((await y.call("/api/config")).status, 429);
  assert.equal((await y.call("/healthz")).status, 200);
});

async function paymentFixture(pool: Pool) {
  const now = Date.now();
  await pool.query(
    "INSERT INTO campaigns VALUES ('c','Synthetic','Only test data',12345,2,$1,$2)",
    [now + 3600000, now],
  );
  for (const n of [1, 2]) {
    await pool.query("INSERT INTO invitations VALUES ($1,'c',$2,$3)", [
      "i" + n,
      "token" + n,
      now,
    ]);
    await pool.query("INSERT INTO challenges VALUES ($1,$2,'synthetic',$3,1)", [
      "h" + n,
      "i" + n,
      now + 300000,
    ]);
    await pool.query(
      "INSERT INTO claims VALUES ($1,$2,'c',$3,'key','signature',$4,'payment-ready',$5)",
      ["claim" + n, "i" + n, "address" + n, "h" + n, now],
    );
    await pool.query(
      "INSERT INTO events(claim_id,status,at) VALUES ($1,'payment-ready',$2)",
      ["claim" + n, now],
    );
    await pool.query(
      "INSERT INTO payment_intents VALUES ($1,$2,'c','sender',$3,12345,0,'testnet',123,$4,$5)",
      ["intent" + n, "claim" + n, "address" + n, now, now + 90000],
    );
    await pool.query(
      "INSERT INTO payment_attempts(id,intent_id,state,created,updated,reason,permit_hash) VALUES ($1,$2,'UNKNOWN',$3,$3,'Synthetic permanent lock','hashed-permit')",
      ["attempt" + n, "intent" + n, now],
    );
    await pool.query(
      "INSERT INTO payment_events(attempt_id,state,reason,at) VALUES ($1,'UNKNOWN','Synthetic permanent lock',$2)",
      ["attempt" + n, now],
    );
  }
}
test("Postgres enforces immutable records, append-only history, global hashes and permanent UNKNOWN locks", async (t) => {
  const { pool } = await database(t);
  await paymentFixture(pool);
  for (const sql of [
    "UPDATE campaigns SET title='changed'",
    "UPDATE claims SET address='changed'",
    "UPDATE claims SET status='pending'",
    "UPDATE payment_intents SET amount=1",
    "DELETE FROM payment_intents",
    "DELETE FROM payment_attempts",
    "UPDATE payment_attempts SET state='SUBMITTING'",
    "UPDATE payment_attempts SET intent_id='other'",
    "DELETE FROM events",
    "UPDATE payment_events SET state='CONFIRMED'",
    "TRUNCATE events",
    "TRUNCATE payment_events",
    "TRUNCATE payment_hashes",
    "TRUNCATE campaign_wallets",
    "TRUNCATE payment_attempts CASCADE",
    "TRUNCATE settings",
  ])
    await assert.rejects(pool.query(sql));
  await pool.query(
    "UPDATE payment_attempts SET candidate_hash=$1 WHERE id='attempt1'",
    ["a".repeat(64)],
  );
  await assert.rejects(
    pool.query(
      "UPDATE payment_attempts SET candidate_hash=$1 WHERE id='attempt2'",
      ["a".repeat(64)],
    ),
  );
  await pool.query("INSERT INTO payment_hashes VALUES ($1,'attempt1')", [
    "a".repeat(64),
  ]);
  await assert.rejects(
    pool.query("INSERT INTO payment_hashes VALUES ($1,'attempt2')", [
      "a".repeat(64),
    ]),
  );
  await assert.rejects(pool.query("DELETE FROM payment_hashes"));
  assert.deepEqual(
    (await pool.query("SELECT state FROM payment_attempts ORDER BY id")).rows,
    [{ state: "UNKNOWN" }, { state: "UNKNOWN" }],
  );
});

test("real pg_dump encrypted archive authenticates, restores into another database and preserves claims/sessions/UNKNOWN locks", async (t) => {
  const source = await database(t);
  await paymentFixture(source.pool);
  await source.pool.query(
    "INSERT INTO sessions VALUES ('synthetic-session-hash',$1)",
    [Date.now() + 3600000],
  );
  const restored = await database(t, false);
  const dir = mkdtempSync(join(tmpdir(), "nimclaim-pg-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32),
    archive = join(dir, "backup.enc");
  const container = process.env.NIMCLAIM_PG_TEST_CONTAINER!;
  await encryptedDump(
    "docker",
    [
      "exec",
      container,
      "pg_dump",
      "-U",
      "postgres",
      "--format=custom",
      "--no-owner",
      "--no-acl",
      source.name,
    ],
    process.env,
    key,
    archive,
  );
  assert.equal(statSync(archive).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(archive).includes(Buffer.from("synthetic-session-hash")),
    false,
  );
  await assert.rejects(
    restoreDump(
      "docker",
      [
        "exec",
        "-i",
        container,
        "pg_restore",
        "-U",
        "postgres",
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        "--dbname",
        restored.name,
      ],
      process.env,
      randomBytes(32),
      archive,
    ),
  );
  assert.equal(
    (
      await restored.pool.query(
        "SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'",
      )
    ).rows[0].n,
    0,
  );
  await restoreDump(
    "docker",
    [
      "exec",
      "-i",
      container,
      "pg_restore",
      "-U",
      "postgres",
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "--dbname",
      restored.name,
    ],
    process.env,
    key,
    archive,
  );
  await migrate(restored.pool);
  await verifySchema(restored.pool);
  await grantRuntime(restored.pool, restored.name);
  for (const table of [
    "organiser",
    "sessions",
    "campaigns",
    "invitations",
    "challenges",
    "claims",
    "events",
    "payment_intents",
    "payment_attempts",
    "payment_events",
    "schema_migrations",
  ]) {
    const order = table === "schema_migrations" ? "version" : "1";
    assert.deepEqual(
      (await restored.pool.query(`SELECT * FROM ${table} ORDER BY ${order}`))
        .rows,
      (await source.pool.query(`SELECT * FROM ${table} ORDER BY ${order}`))
        .rows,
    );
  }
  await assert.rejects(
    restored.pool.query("UPDATE payment_attempts SET state='SUBMITTING'"),
  );
  const api = await worker(restored.name);
  t.after(() => api.stop());
  const user = client(api.port);
  await user.login();
  assert.equal((await user.call("/api/campaigns")).body.campaigns.length, 1);
  assert.equal(
    (
      await restored.pool.query(
        "SELECT count(*) AS n FROM pg_constraint WHERE NOT convalidated",
      )
    ).rows[0].n,
    0,
  );
  const broken = join(dir, "tampered.enc"),
    bytes = readFileSync(archive);
  bytes[bytes.length - 17] ^= 1;
  writeFileSync(broken, bytes);
  await assert.rejects(
    restoreDump(
      "docker",
      [
        "exec",
        "-i",
        container,
        "pg_restore",
        "-U",
        "postgres",
        "--single-transaction",
        "--exit-on-error",
        "--dbname",
        restored.name,
      ],
      process.env,
      key,
      broken,
    ),
  );
});

test("failed startup never opens an HTTP listener or falls back to local SQLite", async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "ops/staging-start.ts"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        NIMCLAIM_STAGING: "1",
        APP_ORIGIN: origin,
        NETWORK: "testnet",
        SPENDING_ENABLED: "false",
        STAGING_ORGANISER_PASSWORD_HASH: hash,
      },
    },
  );
  let output = "";
  child.stdout.on("data", (v) => {
    output += v;
  });
  child.stderr.on("data", (v) => {
    output += v;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(output, /startup refused/);
  assert.doesNotMatch(output, /ready|postgresql:\/\/|password/);
});

test.after(async () => {
  await admin.end();
});

test("Postgres engine restart preserves data and locked attempts before another API replacement", async (t) => {
  const { name, pool } = await database(t);
  await paymentFixture(pool);
  const before = (
    await pool.query(
      "SELECT id,state,intent_id FROM payment_attempts ORDER BY id",
    )
  ).rows;
  execFileSync("docker", ["restart", process.env.NIMCLAIM_PG_TEST_CONTAINER!], {
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    try {
      execFileSync(
        "docker",
        [
          "exec",
          process.env.NIMCLAIM_PG_TEST_CONTAINER!,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
        ],
        { stdio: "ignore" },
      );
      break;
    } catch {
      if (i === 60) throw new Error("Postgres restart failed");
      await new Promise((ok) => setTimeout(ok, 250));
    }
  }
  // Engine restart invalidates old sockets. Reconnect explicitly instead of
  // silently retrying a business operation after an ambiguous connection loss.
  await admin.end();
  admin = createPool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "nimclaim_test",
    max: 2,
  });
  const reconnected = poolFor(name);
  assert.deepEqual(
    (
      await reconnected.query(
        "SELECT id,state,intent_id FROM payment_attempts ORDER BY id",
      )
    ).rows,
    before,
  );
  const api = await worker(name);
  t.after(() => api.stop());
  const user = client(api.port);
  await user.login();
  const campaignList = await user.call("/api/campaigns");
  assert.equal(campaignList.status, 200);
  assert.equal(campaignList.body.campaigns[0].claimed, 2);
  await assert.rejects(
    reconnected.query("UPDATE payment_attempts SET state='SUBMITTING'"),
  );
});

test("real Postgres claim checks reject raw or mutated signatures, extra address fields, stale origins and expiry without consuming proof", async (t) => {
  const { name, pool } = await database(t);
  const api = await worker(name);
  t.after(() => api.stop());
  const user = client(api.port);
  await user.login();
  const c = await campaign(user),
    token = await invitation(user, c.id),
    signer = testSigner(),
    p = await proof(user, token, signer);
  assert.equal(
    (await user.call("/api/claim", { ...p.body, address: signer.address }))
      .status,
    400,
  );
  assert.equal(
    (
      await user.call("/api/claim", {
        ...p.body,
        signature: signer.rawSign(p.challenge.message),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await user.call("/api/claim", {
        ...p.body,
        signature: signer.sign(
          p.challenge.message.replace(origin, "https://evil.example"),
        ),
      })
    ).status,
    401,
  );
  const { PostgresStore } = await import("../../server/postgres/store.js");
  await assert.rejects(
    new PostgresStore(pool, "https://another-stage.example").claim(p.body),
    /different origin/,
  );
  assert.equal(
    (
      await pool.query("SELECT used FROM challenges WHERE id=$1", [
        p.challenge.id,
      ])
    ).rows[0].used,
    0,
  );
  await pool.query("UPDATE challenges SET expires=$1 WHERE id=$2", [
    Date.now() - 1,
    p.challenge.id,
  ]);
  assert.equal((await user.call("/api/claim", p.body)).status, 409);
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM claims")).rows[0].n,
    0,
  );
  const fresh = await proof(user, token, signer);
  assert.equal((await user.call("/api/claim", fresh.body)).status, 201);
});

test("encrypted backup failure cleans partial files and cannot overwrite a completed archive", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nimclaim-backup-failure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32),
    archive = join(dir, "failed.enc");
  await assert.rejects(
    encryptedDump(
      "/no-such-nimclaim-test-executable",
      [],
      process.env,
      key,
      archive,
    ),
  );
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(archive), false);
  writeFileSync(archive, "preserve existing archive");
  await assert.rejects(
    encryptedDump(
      "/no-such-nimclaim-test-executable",
      [],
      process.env,
      key,
      archive,
    ),
  );
  assert.equal(readFileSync(archive, "utf8"), "preserve existing archive");
});

test("read-only startup rejects schema drift, missing migrations/network/organiser without repairing anything", async (t) => {
  const { pool, name } = await database(t);
  const runtime = runtimePool(name);
  await verifyRuntimeRole(runtime);
  await verifySchema(runtime);
  const { startPostgresStaging } =
    await import("../../server/postgres/staging.js");
  await assert.rejects(startPostgresStaging(pool, origin), /Restricted/);
  const original = (
    await pool.query("SELECT * FROM schema_migrations ORDER BY version")
  ).rows;
  for (const [change, restore] of [
    [
      "UPDATE schema_migrations SET checksum='wrong' WHERE version=3",
      `UPDATE schema_migrations SET checksum='${original[2].checksum}' WHERE version=3`,
    ],
    [
      "UPDATE schema_migrations SET version=4 WHERE version=3",
      "UPDATE schema_migrations SET version=3 WHERE version=4",
    ],
    [
      "ALTER TABLE sessions RENAME TO sessions_wrong",
      "ALTER TABLE sessions_wrong RENAME TO sessions",
    ],
    [
      "ALTER TABLE payment_attempts DISABLE TRIGGER lock_attempt",
      "ALTER TABLE payment_attempts ENABLE TRIGGER lock_attempt",
    ],
    [
      "ALTER FUNCTION guard_attempt() SECURITY DEFINER",
      "ALTER FUNCTION guard_attempt() SECURITY INVOKER",
    ],
    ["CREATE INDEX unexpected ON sessions(expires)", "DROP INDEX unexpected"],
  ]) {
    await pool.query(change);
    await assert.rejects(startPostgresStaging(runtime, origin));
    await pool.query(restore);
  }
  await pool.query(
    "ALTER TABLE settings DISABLE TRIGGER fixed_settings; UPDATE settings SET value='mainnet' WHERE key='network'; ALTER TABLE settings ENABLE TRIGGER fixed_settings",
  );
  await assert.rejects(verifySchema(runtime), /network/);
  await pool.query(
    "ALTER TABLE settings DISABLE TRIGGER fixed_settings; UPDATE settings SET value='testnet' WHERE key='network'; ALTER TABLE settings ENABLE TRIGGER fixed_settings",
  );
  await pool.query("DELETE FROM organiser");
  await assert.rejects(startPostgresStaging(runtime, origin), /organiser/);
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM organiser")).rows[0].n,
    0,
  );
  await bootstrap(pool, hash);
  await assert.rejects(bootstrap(pool, hash), /never overwritten/);
  await verifySchema(runtime);
  assert.deepEqual(
    (await pool.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
    original,
  );
  const empty = await database(t, false);
  await assert.rejects(verifySchema(empty.pool));
  assert.equal(
    (
      await empty.pool.query(
        "SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'",
      )
    ).rows[0].n,
    0,
  );
});

test("restricted role cannot issue DDL, create roles, bootstrap, migrate, delegate, or reset immutable payment locks", async (t) => {
  const { pool, name } = await database(t);
  await paymentFixture(pool);
  const runtime = runtimePool(name);
  await verifyRuntimeRole(runtime);
  for (const sql of [
    "CREATE TABLE public.forbidden(id integer)",
    "CREATE SCHEMA forbidden",
    "CREATE TEMP TABLE forbidden(id integer)",
    "ALTER TABLE campaigns ADD COLUMN forbidden text",
    "DROP TABLE sessions",
    "TRUNCATE events",
    "DELETE FROM sessions",
    "CREATE ROLE forbidden_role",
    "ALTER ROLE nimclaim_app SUPERUSER",
    "SET ROLE postgres",
    "GRANT postgres TO nimclaim_app",
    "ALTER TABLE payment_attempts DISABLE TRIGGER ALL",
    "SET session_replication_role=replica",
    "INSERT INTO organiser VALUES (1,'forbidden')",
    "UPDATE organiser SET password_hash='forbidden'",
    "UPDATE schema_migrations SET checksum='forbidden'",
    "UPDATE settings SET value='mainnet'",
    "UPDATE payment_intents SET amount=1",
    "DELETE FROM payment_attempts",
    "INSERT INTO payment_hashes VALUES ('forbidden','attempt1')",
    "UPDATE payment_attempts SET permit_hash='forbidden'",
    "UPDATE claims SET address='forbidden'",
    "UPDATE events SET status='forbidden'",
    "UPDATE payment_events SET state='CONFIRMED'",
    "SELECT nextval('events_id_seq')",
    "SELECT setval('events_id_seq',1)",
    "SELECT pg_read_file('/etc/passwd')",
  ])
    await assert.rejects(runtime.query(sql), { code: "42501" }, sql);
  // These writes have column grants; immutable triggers, rather than ACLs, reject them.
  await assert.rejects(runtime.query("UPDATE campaigns SET id='forbidden'"), {
    code: "23514",
  });
  await assert.rejects(
    runtime.query("UPDATE payment_attempts SET state='SUBMITTING'"),
    { code: "23514" },
  );
  await assert.rejects(runtime.query("UPDATE claims SET status='pending'"), {
    code: "23514",
  });
  await assert.rejects(migrate(runtime), { code: "42501" });
  const fresh = await database(t, false);
  await migrate(fresh.pool);
  await grantRuntime(fresh.pool, fresh.name);
  const unbootstrapped = runtimePool(fresh.name);
  await assert.rejects(bootstrap(unbootstrapped, hash), { code: "42501" });
  assert.equal(
    (await fresh.pool.query("SELECT count(*) AS n FROM organiser")).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) AS n FROM payment_attempts WHERE state='UNKNOWN'",
      )
    ).rows[0].n,
    2,
  );
});

test("runtime privilege verification rejects extra column grants, grant options and inherited administrative access", async (t) => {
  const { pool, name } = await database(t);
  const runtime = runtimePool(name);
  for (const [grant, revoke] of [
    [
      "GRANT DELETE ON sessions TO nimclaim_app",
      "REVOKE DELETE ON sessions FROM nimclaim_app",
    ],
    [
      "GRANT UPDATE (permit_hash) ON payment_attempts TO nimclaim_app",
      "REVOKE UPDATE (permit_hash) ON payment_attempts FROM nimclaim_app",
    ],
    [
      "GRANT CREATE ON SCHEMA public TO nimclaim_app",
      "REVOKE CREATE ON SCHEMA public FROM nimclaim_app",
    ],
    [
      "GRANT pg_read_all_data TO nimclaim_app",
      "REVOKE pg_read_all_data FROM nimclaim_app",
    ],
    [
      "GRANT SET ON PARAMETER session_replication_role TO nimclaim_app",
      "REVOKE SET ON PARAMETER session_replication_role FROM nimclaim_app",
    ],
    [
      "GRANT SELECT ON sessions TO nimclaim_app WITH GRANT OPTION",
      "REVOKE GRANT OPTION FOR SELECT ON sessions FROM nimclaim_app",
    ],
  ]) {
    await pool.query(grant);
    try {
      await assert.rejects(verifyRuntimeRole(runtime));
    } finally {
      await pool.query(revoke);
    }
    await verifyRuntimeRole(runtime);
  }
});

test("restricted runtime revokes sessions and replaces challenges without DELETE or sequence grants", async (t) => {
  const { pool, name } = await database(t);
  const api = await worker(name);
  const user = client(api.port);
  const login = await user.login();
  const oldCookie = login.headers["set-cookie"]![0].split(";")[0];
  const before = (await pool.query("SELECT hash FROM sessions")).rows[0].hash;
  assert.equal((await user.call("/api/logout", {})).status, 200);
  assert.equal(
    (await user.call("/api/session", undefined, { Cookie: oldCookie })).body
      .authenticated,
    false,
  );
  assert.equal(
    (await pool.query("SELECT expires FROM sessions WHERE hash=$1", [before]))
      .rows[0].expires,
    0,
  );
  await user.login();
  assert.equal(
    (
      await pool.query("SELECT count(*) AS n FROM sessions WHERE hash=$1", [
        before,
      ])
    ).rows[0].n,
    1,
  );
  const c = await campaign(user, 1);
  const token = await invitation(user, c.id);
  const old = await proof(user, token),
    fresh = await proof(user, token);
  assert.equal(
    (
      await pool.query("SELECT used FROM challenges WHERE id=$1", [
        old.challenge.id,
      ])
    ).rows[0].used,
    1,
  );
  assert.equal((await user.call("/api/claim", old.body)).status, 409);
  assert.equal((await user.call("/api/claim", fresh.body)).status, 201);
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM events")).rows[0].n,
    1,
  );
});

test("restricted runtime preserves stale SUBMITTING to UNKNOWN and append-only history without reservation privileges", async (t) => {
  const { pool, name } = await database(t);
  await paymentFixture(pool);
  // Owner creates the pre-existing crash fixture; runtime never reserves a payment.
  await pool.query(
    "ALTER TABLE payment_attempts DISABLE TRIGGER lock_attempt; UPDATE payment_attempts SET state='SUBMITTING' WHERE id='attempt1'; ALTER TABLE payment_attempts ENABLE TRIGGER lock_attempt",
  );
  await pool.query(
    "ALTER TABLE payment_intents DISABLE TRIGGER immutable_payment_intent; UPDATE payment_intents SET expires=0 WHERE id='intent1'; ALTER TABLE payment_intents ENABLE TRIGGER immutable_payment_intent",
  );
  const runtime = runtimePool(name);
  await verifyRuntimeRole(runtime);
  await verifySchema(runtime);
  const { PostgresStore } = await import("../../server/postgres/store.js");
  const store = new PostgresStore(runtime, origin);
  const claim = (await pool.query("SELECT * FROM claims WHERE id='claim1'"))
    .rows[0];
  assert.equal((await store.claimView(claim))!.payment!.state, "UNKNOWN");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) AS n FROM payment_events WHERE attempt_id='attempt1' AND state='UNKNOWN'",
      )
    ).rows[0].n,
    2,
  );
  await store.claimView(claim);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) AS n FROM payment_events WHERE attempt_id='attempt1'",
      )
    ).rows[0].n,
    2,
  );
  await assert.rejects(
    runtime.query(
      "UPDATE payment_attempts SET state='SUBMITTING' WHERE id='attempt1'",
    ),
    { code: "23514" },
  );
});

test("explicit admin configuration requires the approved direct TESTNET target and never accepts the runtime role", async () => {
  const { adminConfig } = await import("../../ops/staging-admin.js");
  const url = new URL(
    "postgresql://synthetic:example-only@ep-synthetic.eu-central-1.aws.neon.tech/nimclaim?sslmode=verify-full",
  );
  url.hostname = "ep-royal-sunset-b9d4cl7u.c-7.eu-central-1.aws.neon.tech";
  const env = {
    NETWORK: "testnet",
    SPENDING_ENABLED: "false",
    DIRECT_DATABASE_URL: url.toString(),
  };
  assert.equal(adminConfig(env).max, 1);
  for (const patch of [
    { DIRECT_DATABASE_URL: "" },
    { NETWORK: "mainnet" },
    { SPENDING_ENABLED: "true" },
    { DIRECT_DATABASE_URL: url.toString().replace("/nimclaim", "/other") },
    {
      DIRECT_DATABASE_URL: url
        .toString()
        .replace("synthetic:", "nimclaim_app:"),
    },
    {
      DIRECT_DATABASE_URL: url
        .toString()
        .replace("sunset-b9d4cl7u.", "sunset-b9d4cl7u-pooler."),
    },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  ])
    assert.throws(() => adminConfig({ ...env, ...patch }));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "ops/staging-admin.ts",
      "bootstrap",
      ".local/nonexistent-admin-test.env",
      ".local/nonexistent-admin-credentials.json",
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } },
  );
  let output = "";
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(output, /command refused/);
  assert.doesNotMatch(output, /postgresql:\/\/|password|example-only/);
});

test("runtime transaction-local settings do not leak between pooled clients and read-only verification performs no writes", async (t) => {
  const { pool, name } = await database(t);
  const runtime = runtimePool(name);
  const { transaction } = await import("../../server/postgres/db.js");
  const before = (await pool.query("SELECT * FROM organiser")).rows;
  const ledger = (
    await pool.query("SELECT * FROM schema_migrations ORDER BY version")
  ).rows;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      transaction(runtime, async (c) => {
        assert.equal(
          (await c.query("SHOW lock_timeout")).rows[0].lock_timeout,
          "5s",
        );
        assert.equal(
          (await c.query("SHOW search_path")).rows[0].search_path,
          "public, pg_catalog",
        );
        await c.query("SET TRANSACTION READ ONLY");
        assert.equal(
          (await c.query("SHOW transaction_read_only")).rows[0]
            .transaction_read_only,
          "on",
        );
      }),
    ),
  );
  const c = await runtime.connect();
  try {
    assert.equal(
      (await c.query("SHOW lock_timeout")).rows[0].lock_timeout,
      "0",
    );
    assert.equal(
      (await c.query("SHOW transaction_read_only")).rows[0]
        .transaction_read_only,
      "off",
    );
  } finally {
    c.release();
  }
  await verifyRuntimeRole(runtime);
  await verifySchema(runtime);
  assert.deepEqual((await pool.query("SELECT * FROM organiser")).rows, before);
  assert.deepEqual(
    (await pool.query("SELECT * FROM schema_migrations ORDER BY version")).rows,
    ledger,
  );
});

test("MAINNET tenant migration preserves legacy campaigns, invitations, claims and history", async (t) => {
  const { mainnetIdentity } = await import("../../server/postgres/mainnet.js");
  const db = await database(t, false);
  const legacyDirectory = mkdtempSync(join(tmpdir(), "nimclaim-mainnet-v3-"));
  try {
    for (const file of [
      "001_claims.sql",
      "002_payments.sql",
      "003_limits.sql",
    ])
      cpSync(
        join(mainnetIdentity.directory, file),
        join(legacyDirectory, file),
      );
    await migrate(db.pool, legacyDirectory, mainnetIdentity.deployment);
    await bootstrap(db.pool, hash, mainnetIdentity);

    const campaignId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const invitationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const challengeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const claimId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const sessionHash = "f".repeat(64);
    const now = Date.now();
    await db.pool.query(
      "INSERT INTO sessions (hash,expires) VALUES ($1,$2)",
      [sessionHash, now + 3_600_000],
    );
    await db.pool.query(
      "INSERT INTO campaigns VALUES ($1,'Legacy campaign','Existing details',12345,2,$2,$3)",
      [campaignId, now + 86_400_000, now],
    );
    await db.pool.query(
      "INSERT INTO invitations VALUES ($1,$2,$3,$4)",
      [invitationId, campaignId, "a".repeat(64), now],
    );
    await db.pool.query(
      "INSERT INTO challenges VALUES ($1,$2,$3,$4,1)",
      [challengeId, invitationId, "legacy signed challenge", now + 60_000],
    );
    await db.pool.query(
      "INSERT INTO claims VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)",
      [
        claimId,
        invitationId,
        campaignId,
        "NQ00 LEGACY ADDRESS",
        "1".repeat(64),
        "2".repeat(128),
        challengeId,
        now,
      ],
    );
    await db.pool.query(
      "INSERT INTO events (claim_id,status,at) VALUES ($1,'pending',$2)",
      [claimId, now],
    );

    await migrate(
      db.pool,
      mainnetIdentity.directory,
      mainnetIdentity.deployment,
    );
    const legacy = (
      await db.pool.query(
        "SELECT id FROM organisers WHERE legacy=true AND wallet_address IS NULL",
      )
    ).rows[0];
    assert.ok(legacy);
    assert.deepEqual(
      (
        await db.pool.query(
          "SELECT id,organiser_id,title FROM campaigns WHERE id=$1",
          [campaignId],
        )
      ).rows[0],
      {
        id: campaignId,
        organiser_id: legacy.id,
        title: "Legacy campaign",
      },
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT token_hash FROM invitations WHERE id=$1",
          [invitationId],
        )
      ).rows[0].token_hash,
      "a".repeat(64),
    );
    assert.equal(
      (
        await db.pool.query("SELECT id,status FROM claims WHERE id=$1", [
          claimId,
        ])
      ).rows[0].status,
      "pending",
    );
    assert.equal(
      (
        await db.pool.query("SELECT count(*) AS n FROM events WHERE claim_id=$1", [
          claimId,
        ])
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await db.pool.query("SELECT expires FROM sessions WHERE hash=$1", [
          sessionHash,
        ])
      ).rows[0].expires,
      0,
    );
  } finally {
    rmSync(legacyDirectory, { recursive: true, force: true });
  }
});

async function mainnetDatabase(t: { after: Function }) {
  const { mainnetIdentity } = await import("../../server/postgres/mainnet.js");
  const db = await database(t, false);
  await migrate(db.pool, mainnetIdentity.directory, mainnetIdentity.deployment);
  await bootstrap(db.pool, hash, mainnetIdentity);
  await db.pool.query(
    readFileSync("ops/nimclaim-mainnet-grants.sql", "utf8").replaceAll(
      "nimclaim_mainnet",
      db.name,
    ),
  );
  return db;
}
test("MAINNET real Postgres signs and persists claims and organiser binding across processes; payouts stay blocked", async (t) => {
  const { pool, name } = await mainnetDatabase(t);
  const appOrigin = "https://nimclaim-mainnet.onrender.com";
  const api = await worker(name, appOrigin, true);
  const organiser = client(api.port, appOrigin);
  const publicClient = client(api.port, appOrigin);
  const config = (await organiser.call("/api/config")).body;
  assert.equal(config.network, "mainnet");
  assert.equal(config.staging, false);
  assert.equal(config.claimsOnly, true);
  assert.equal(
    (await organiser.call("/api/login", { password })).status,
    404,
  );
  const owner = testSigner();
  const login = await organiser.walletLogin(owner, password);
  assert.match(
    login.headers["set-cookie"]![0],
    /^nimclaim_mainnet_session=.*; Secure$/,
  );
  assert.equal(login.body.organiser.walletAddress, owner.address);
  const c = await campaign(organiser, 2);
  const challengePath = `/api/campaigns/${c.id}/wallet/challenge`;
  assert.equal((await publicClient.call(challengePath, {})).status, 401);
  assert.equal(
    (
      await organiser.call(
        challengePath,
        {},
        { Origin: "https://other.invalid" },
      )
    ).status,
    403,
  );
  const binding = (await organiser.call(challengePath, {})).body;
  assert.equal(JSON.parse(binding.message).network, "mainnet");
  const walletProof = {
    challengeId: binding.id,
    publicKey: owner.publicKey,
    signature: owner.sign(binding.message),
  };
  const otherSession = client(api.port, appOrigin);
  const otherOwner = testSigner();
  await otherSession.walletLogin(otherOwner);
  assert.deepEqual(
    (await otherSession.call("/api/campaigns")).body.campaigns,
    [],
  );
  assert.equal(
    (await otherSession.call(`/api/campaigns/${c.id}`)).status,
    404,
  );
  assert.equal(
    (
      await otherSession.call(
        `/api/campaigns/${c.id}/invitations`,
        {},
      )
    ).status,
    404,
  );
  assert.equal(
    (await otherSession.call(`/api/campaigns/${c.id}/wallet`, walletProof))
      .status,
    404,
  );
  assert.equal(
    (
      await organiser.call(`/api/campaigns/${c.id}/wallet`, {
        ...walletProof,
        signature: "0".repeat(128),
      })
    ).status,
    401,
  );
  assert.equal(
    (await organiser.call(`/api/campaigns/${c.id}/wallet`, walletProof)).status,
    201,
  );
  assert.equal(
    (await organiser.call(`/api/campaigns/${c.id}/wallet`, walletProof)).status,
    409,
  );
  const invitationResult = await organiser.call(
    `/api/campaigns/${c.id}/invitations`,
    {},
  );
  assert.equal(invitationResult.status, 201);
  assert.equal(new URL(invitationResult.body.url).origin, appOrigin);
  const token = new URL(invitationResult.body.url).hash.slice(7);
  const stale = await proof(publicClient, token);
  const fresh = await proof(publicClient, token);
  assert.equal(JSON.parse(fresh.challenge.message).network, "mainnet");
  assert.equal((await publicClient.call("/api/claim", stale.body)).status, 409);
  const result = await publicClient.call("/api/claim", fresh.body);
  assert.equal(result.status, 201);
  assert.equal((await publicClient.call("/api/claim", fresh.body)).status, 409);
  const claimId = result.body.claim.id;
  assert.equal(
    (
      await otherSession.call(`/api/claims/${claimId}/decision`, {
        decision: "payment-ready",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await organiser.call(`/api/claims/${claimId}/decision`, {
        decision: "payment-ready",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await organiser.call(`/api/claims/${claimId}/decision`, {
        decision: "rejected",
      })
    ).status,
    409,
  );
  for (const port of [api.port, api.backend]) {
    const caller = client(port, appOrigin);
    await caller.walletLogin(testSigner());
    const attempt = await caller.call(
      `/api/claims/${claimId}/payment/reserve`,
      {},
    );
    assert.ok([403, 404].includes(attempt.status));
    assert.ok(
      [403, 404].includes(
        (
          await caller.call(`/api/payments/${claimId}/reconcile`, {
            hash: "a".repeat(64),
          })
        ).status,
      ),
    );
  }
  await api.stop();
  const restarted = await worker(name, appOrigin, true);
  const existing = client(restarted.port, appOrigin);
  assert.equal(
    (
      await existing.call("/api/session", undefined, {
        Cookie: login.headers["set-cookie"]![0].split(";")[0],
      })
    ).body.authenticated,
    true,
  );
  await existing.walletLogin(owner);
  const detail = (await existing.call(`/api/campaigns/${c.id}`)).body;
  assert.equal(detail.wallet.address, owner.address);
  assert.equal(detail.claims[0].status, "payment-ready");
  assert.equal(detail.claims[0].payment, null);
  assert.equal(detail.paymentGate.enabled, false);
  assert.equal(detail.claimsOnly, true);
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM payment_attempts")).rows[0].n,
    0,
  );
  const runtime = runtimePool(name);
  await verifyRuntimeRole(runtime, true);
  await assert.rejects(verifyRuntimeRole(runtime)); // production grants cannot silently enter staging
  for (const sql of [
    "INSERT INTO payment_hashes VALUES ('fake','fake')",
    "SELECT * FROM payment_attempts",
    "UPDATE settings SET value='testnet'",
    "DELETE FROM campaign_wallets",
    "UPDATE claims SET address='fake'",
    "UPDATE campaign_wallets SET address='fake'",
  ])
    await assert.rejects(runtime.query(sql), { code: "42501" });
});

test("MAINNET startup refuses TESTNET identities and staging refuses MAINNET; origin/network signature replay fails", async (t) => {
  const { mainnetIdentity, startPostgresMainnet } =
    await import("../../server/postgres/mainnet.js");
  const { startPostgresStaging } =
    await import("../../server/postgres/staging.js");
  const staging = await database(t);
  await assert.rejects(verifySchema(staging.pool, true, mainnetIdentity));
  await assert.rejects(startPostgresMainnet(runtimePool(staging.name), origin));
  const { pool, name } = await mainnetDatabase(t);
  await assert.rejects(startPostgresStaging(runtimePool(name), origin));
  await assert.rejects(migrate(pool));
  await assert.rejects(bootstrap(pool, hash));
  const { PostgresStore } = await import("../../server/postgres/store.js");
  const runtime = runtimePool(name);
  const store = new PostgresStore(
    runtime,
    "https://nimclaim-mainnet.onrender.com",
    "mainnet",
  );
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const legacyOrganiserId = (
    await pool.query("SELECT id FROM organisers WHERE legacy=true")
  ).rows[0].id;
  await pool.query(
    "INSERT INTO campaigns (id,title,description,amount,slots,expires,created,organiser_id) VALUES ($1,'Synthetic','Test',1,1,$2,$3,$4)",
    [id, Date.now() + 3600000, Date.now(), legacyOrganiserId],
  );
  const token = new URL((await store.issue(id, legacyOrganiserId)).url).hash.slice(7);
  const signer = testSigner();
  const challenge = await store.challenge(token);
  const input = {
    token,
    challengeId: challenge.id,
    publicKey: signer.publicKey,
    signature: signer.sign(challenge.message),
  };
  await assert.rejects(
    new PostgresStore(runtime, store.origin, "testnet").claim(input),
    /network/,
  );
  await assert.rejects(
    new PostgresStore(runtime, "https://other.invalid", "mainnet").claim(input),
    /origin/,
  );
  assert.equal((await store.claim(input)).address, signer.address);
});
