// Explicit operator command, excluded from the normal offline test suite.
// Errors/assertions are intentionally never serialized: they can contain SQL values.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import type { Pool } from "pg";
import {
  approvedConnections,
  isolatedConfig,
  verifyConnection,
} from "../../ops/neon-target.js";
import {
  createPool,
  migrate,
  migrationDirectory,
  transaction,
  bootstrap,
} from "../../server/postgres/db.js";
import { PostgresStore } from "../../server/postgres/store.js";
import { passwordHash, digest } from "../../server/crypto.js";
import { testSigner } from "../helpers.js";

const origin = "https://nimclaim-verify.invalid";
const password = randomBytes(24).toString("hex");
const pools: Pool[] = [];
type Worker = { port: number; stop(signal?: NodeJS.Signals): Promise<void> };
const workers: Worker[] = [];
let phase = "private configuration";
function pass(label: string) {
  console.log(`PASS ${label}`);
}
const files = ["001_claims.sql", "002_payments.sql", "003_limits.sql"];
function reviewedPlan() {
  assert.deepEqual(readdirSync(migrationDirectory).sort(), files);
  return files.map((name, index) => {
    const sql = readFileSync(`${migrationDirectory}/${name}`, "utf8");
    assert.equal(
      sql,
      execFileSync(
        "git",
        ["show", `08b65e4:server/postgres/migrations/${name}`],
        { encoding: "utf8" },
      ),
    );
    return {
      version: index + 1,
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    };
  });
}
async function publicSnapshot(pool: Pool) {
  return (
    await pool.query(
      "SELECT version,checksum,applied_at FROM public.schema_migrations ORDER BY version",
    )
  ).rows;
}
async function worker(schema: string): Promise<Worker> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/postgres/neon-worker.ts"],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH, NIMCLAIM_VERIFY_SCHEMA: schema },
    },
  );
  const ended = once(child, "exit");
  let timer: NodeJS.Timeout | undefined;
  try {
    const ready = await Promise.race([
      once(child, "message").then(([r]) => r as { port: number }),
      ended.then(() => {
        throw new Error("Worker exited");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Worker timeout")), 30000);
      }),
    ]);
    const handle = {
      port: ready.port,
      async stop(signal: NodeJS.Signals = "SIGTERM") {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
          await ended;
        }
      },
    };
    workers.push(handle);
    return handle;
  } catch {
    child.kill("SIGKILL");
    await ended;
    throw new Error("Worker failed");
  } finally {
    clearTimeout(timer);
  }
}
async function call(port: number, path: string, body?: unknown, cookie = "") {
  return new Promise<{ status: number; body: any; cookie: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: new URL(origin).host,
            Origin: origin,
            "Content-Type": "application/json",
            Cookie: cookie,
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (b) => {
            raw += b;
          });
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode!,
                body: raw ? JSON.parse(raw) : null,
                cookie: res.headers["set-cookie"]?.[0].split(";")[0] ?? "",
              });
            } catch {
              reject(new Error("Invalid response"));
            }
          });
        },
      );
      req.setTimeout(30000, () => req.destroy(new Error("HTTP timeout")));
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    },
  );
}

try {
  process.umask(0o077);
  const config = approvedConnections();
  const direct = createPool(config.direct),
    runtime = createPool(config.runtime);
  pools.push(direct, runtime);
  phase = "direct and pooled verified TLS";
  await verifyConnection(direct, config.direct);
  await verifyConnection(runtime, config.runtime);
  pass(
    "direct + pooled certificate chain and hostname; wrong hostname rejected; database nimclaim",
  );
  phase = "reviewed migration plan";
  const plan = reviewedPlan();
  console.log(
    "PLAN unchanged migrations from 08b65e4:",
    plan.map((p) => `${p.version}:${p.checksum}`).join(" "),
  );
  const mode = process.argv[2];
  assert.ok(mode === "initialize" || mode === "test");
  if (mode === "initialize") {
    phase = "empty database preflight";
    await transaction(direct, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(786324109)");
      const objects =
        await c.query(`SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'`);
      const routines =
        await c.query(`SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
        AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`);
      const types =
        await c.query(`SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
        AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')`);
      const namespaces = await c.query(
        "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'",
      );
      assert.equal(objects.rowCount, 0);
      assert.equal(routines.rowCount, 0);
      assert.equal(types.rowCount, 0);
      assert.equal(namespaces.rowCount, 0);
      pass("empty application schema, functions, types and namespaces");
      // Migrate on this same checked-out connection and transaction so the empty
      // preflight and application DDL share the advisory lock without a race.
      await c.query(
        "CREATE TABLE schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const item of plan) {
        await c.query(item.sql);
        await c.query(
          "INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)",
          [item.version, item.checksum],
        );
      }
    });
    phase = "public migration idempotency";
    const before = await publicSnapshot(direct);
    await migrate(direct);
    await migrate(direct);
    assert.deepEqual(await publicSnapshot(direct), before);
    assert.deepEqual(
      before.map(({ version, checksum }) => ({ version, checksum })),
      plan.map(({ version, checksum }) => ({ version, checksum })),
    );
    const tables = (
      await direct.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows;
    assert.equal(tables.length, 16);
    assert.equal(
      (await direct.query("SELECT count(*) AS n FROM public.campaigns")).rows[0]
        .n,
      0,
    );
    assert.equal(
      (await direct.query("SELECT count(*) AS n FROM public.organiser")).rows[0]
        .n,
      0,
    );
    pass(
      "3 public migrations committed; checksums/timestamps unchanged on two reruns; no campaign or organiser seeded",
    );
    console.log("SCHEMA", tables.map((r) => r.tablename).join(","));
  } else {
    phase = "public migration validation";
    const before = await publicSnapshot(direct);
    assert.deepEqual(
      before.map(({ version, checksum }) => ({ version, checksum })),
      plan.map(({ version, checksum }) => ({ version, checksum })),
    );
    const schema = `nimclaim_verify_${randomBytes(8).toString("hex")}`;
    phase = "isolated synthetic schema initialization";
    console.log("ISOLATED_SCHEMA", schema);
    await transaction(direct, async (c) => {
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET LOCAL search_path TO ${schema}`);
      for (const item of plan) await c.query(item.sql);
    });
    const pool = createPool(isolatedConfig(config.direct, schema));
    pools.push(pool);
    assert.equal(
      (await pool.query("SELECT current_schema() AS name")).rows[0].name,
      schema,
    );
    await bootstrap(pool, passwordHash(password));
    const store = new PostgresStore(pool, origin);
    const a = await worker(schema),
      b = await worker(schema);
    const login = await call(a.port, "/api/login", { password });
    assert.equal(login.status, 200);
    const cookie = login.cookie;
    phase = "transactional campaign capacity";
    const created = await call(
      a.port,
      "/api/campaigns",
      {
        title: "Isolated synthetic verification",
        description: "No real recipients, wallets or payouts",
        amount: "0.12345",
        slots: 1,
        expires: Date.now() + 3600000,
      },
      cookie,
    );
    assert.equal(created.status, 201);
    const campaign = created.body.campaign;
    const issues = await Promise.all(
      [a, b].map((w) =>
        call(w.port, `/api/campaigns/${campaign.id}/invitations`, {}, cookie),
      ),
    );
    assert.deepEqual(issues.map((r) => r.status).sort(), [201, 409]);
    const token = new URL(
      issues.find((r) => r.status === 201)!.body.url,
    ).hash.slice(7);
    await assert.rejects(
      pool.query("INSERT INTO invitations VALUES ('duplicate',$1,$2,$3)", [
        campaign.id,
        digest(token),
        Date.now(),
      ]),
      { code: "23505" },
    );
    pass("two processes serialize slot allocation; token uniqueness enforced");
    phase = "single-use challenges and claims";
    const signer = testSigner();
    const challenge = (await call(a.port, "/api/challenge", { token })).body;
    const input = {
      token,
      challengeId: challenge.id,
      publicKey: signer.publicKey,
      signature: signer.sign(challenge.message),
    };
    const claims = await Promise.all(
      [a, b].map((w) => call(w.port, "/api/claim", input)),
    );
    assert.deepEqual(claims.map((r) => r.status).sort(), [201, 409]);
    const claim = claims.find((r) => r.status === 201)!.body.claim;
    assert.equal(
      (
        await pool.query("SELECT used FROM challenges WHERE id=$1", [
          challenge.id,
        ])
      ).rows[0].used,
      1,
    );
    assert.equal(
      (await pool.query("SELECT count(*) AS n FROM claims")).rows[0].n,
      1,
    );
    assert.equal(
      (
        await call(
          a.port,
          `/api/claims/${claim.id}/decision`,
          { decision: "payment-ready" },
          cookie,
        )
      ).status,
      200,
    );
    pass(
      "cryptographically verified synthetic claim consumed once under concurrent requests",
    );
    phase = "wallet/campaign uniqueness";
    // Separate invitations for the same signer: loser must retain an unused proof.
    const c2 = (
      await call(
        a.port,
        "/api/campaigns",
        {
          title: "Synthetic uniqueness",
          description: "Isolated only",
          amount: "0.1",
          slots: 2,
          expires: Date.now() + 3600000,
        },
        cookie,
      )
    ).body.campaign;
    const proofs: Array<{
      token: string;
      challengeId: string;
      publicKey: string;
      signature: string;
    }> = [];
    for (const w of [a, b]) {
      const inv = await call(
        w.port,
        `/api/campaigns/${c2.id}/invitations`,
        {},
        cookie,
      );
      const t = new URL(inv.body.url).hash.slice(7);
      const p = (await call(w.port, "/api/challenge", { token: t })).body;
      proofs.push({
        token: t,
        challengeId: p.id,
        publicKey: signer.publicKey,
        signature: signer.sign(p.message),
      });
    }
    const unique = await Promise.all(
      [a, b].map((w, i) => call(w.port, "/api/claim", proofs[i])),
    );
    assert.deepEqual(unique.map((r) => r.status).sort(), [201, 409]);
    const loser = proofs[unique.findIndex((r) => r.status === 409)];
    assert.equal(
      (
        await pool.query("SELECT used FROM challenges WHERE id=$1", [
          loser.challengeId,
        ])
      ).rows[0].used,
      0,
    );
    pass("campaign/address uniqueness rolls back losing challenge consumption");
    phase = "expiry and rate persistence fixtures";
    const expiredToken = randomBytes(32).toString("hex");
    const expired = (
      await pool.query(
        "INSERT INTO campaigns VALUES ('expired','Synthetic expiry','Isolated',1,1,$1,$2) RETURNING *",
        [Date.now() - 1000, Date.now() - 2000],
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO invitations VALUES ('expired-inv',$1,$2,$3)",
      [expired.id, digest(expiredToken), Date.now()],
    );
    await pool.query(
      "INSERT INTO challenges VALUES ('expired-ch','expired-inv','synthetic',$1,1)",
      [Date.now() - 1],
    );
    await pool.query(
      "INSERT INTO claims VALUES ('expired-claim','expired-inv','expired','synthetic-expiry','key','signature','expired-ch','pending',$1)",
      [Date.now()],
    );
    await store.expire();
    await assert.rejects(store.challenge(expiredToken));
    // Establish an explicit synthetic window: earlier HTTP steps can take over
    // a minute on a remote database, legitimately expiring their login bucket.
    await pool.query(
      "INSERT INTO staging_rate VALUES ('login',0,(extract(epoch FROM clock_timestamp())*1000)::bigint+600000) ON CONFLICT(key) DO UPDATE SET count=0,until=EXCLUDED.until",
    );
    const loginRates = await Promise.allSettled(
      Array.from({ length: 12 }, () => store.rate(true)),
    );
    assert.equal(loginRates.filter((r) => r.status === "fulfilled").length, 10);
    assert.equal(
      loginRates.filter(
        (r) => r.status === "rejected" && r.reason?.status === 429,
      ).length,
      2,
    );
    await pool.query(
      "INSERT INTO staging_rate VALUES ('api',180,$1) ON CONFLICT(key) DO UPDATE SET count=180,until=$1",
      [Date.now() + 600000],
    );
    phase = "permanent payment lock fixtures";
    await pool.query(
      "INSERT INTO payment_intents VALUES ('intent',$1,$2,'synthetic-sender','synthetic-recipient',1,0,'testnet',0,$3,$4)",
      [claim.id, campaign.id, Date.now(), Date.now() + 3600000],
    );
    await pool.query(
      "INSERT INTO payment_attempts(id,intent_id,state,created,updated,reason,permit_hash) VALUES ('attempt','intent','UNKNOWN',$1,$1,'Synthetic verification only','synthetic-permit')",
      [Date.now()],
    );
    await pool.query(
      "INSERT INTO payment_events(attempt_id,state,reason,at) VALUES ('attempt','UNKNOWN','Synthetic verification only',$1)",
      [Date.now()],
    );
    await pool.query(
      "INSERT INTO payment_hashes VALUES ('synthetic-hash','attempt')",
    );
    const protectedSql = [
      "UPDATE payment_attempts SET state='SUBMITTING'",
      "DELETE FROM payment_attempts",
      "UPDATE payment_intents SET amount=2",
      "DELETE FROM events",
      "UPDATE payment_events SET state='CONFIRMED'",
      "DELETE FROM payment_hashes",
      "TRUNCATE payment_events",
      "UPDATE claims SET address='changed'",
    ];
    for (const sql of protectedSql)
      await assert.rejects(pool.query(sql), { code: "23514" });
    pass(
      "UNKNOWN locks, immutable intents/claim identity and append-only events/hashes",
    );
    phase = "process shutdown and restart";
    await a.stop("SIGKILL");
    await b.stop();
    const replacement = await worker(schema);
    // Pooled read proves durable data across distinct connections; transaction-local schema only.
    await transaction(runtime, async (c) => {
      await c.query(`SET LOCAL search_path TO ${schema}`);
      assert.equal(
        (
          await c.query("SELECT count(*) AS n FROM sessions WHERE hash=$1", [
            digest(cookie.split("=")[1]),
          ])
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await c.query("SELECT status FROM claims WHERE id=$1", [claim.id]))
          .rows[0].status,
        "payment-ready",
      );
      assert.equal(
        (await c.query("SELECT status FROM claims WHERE id='expired-claim'"))
          .rows[0].status,
        "expired",
      );
      assert.equal(
        (
          await c.query(
            "SELECT count(*) AS n FROM events WHERE claim_id='expired-claim' AND status='expired'",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await c.query("SELECT state FROM payment_attempts WHERE id='attempt'"))
          .rows[0].state,
        "UNKNOWN",
      );
    });
    assert.equal((await call(replacement.port, "/api/config")).status, 429);
    assert.equal(
      (await call(replacement.port, "/api/login", { password })).status,
      429,
    );
    assert.equal((await call(replacement.port, "/healthz")).status, 200);
    // Only the isolated test bucket is expired to permit HTTP session/status checks.
    await pool.query("UPDATE staging_rate SET until=0 WHERE key='api'");
    assert.equal(
      (await call(replacement.port, "/api/session", undefined, cookie)).body
        .authenticated,
      true,
    );
    const restored = await call(replacement.port, "/api/invitation", { token });
    assert.equal(restored.body.claim.status, "payment-ready");
    assert.deepEqual(
      restored.body.claim.history.map((e: { status: string }) => e.status),
      ["pending", "payment-ready"],
    );
    assert.equal(
      (await call(replacement.port, "/api/claim", input)).status,
      409,
    );
    for (const path of [
      `/api/claims/${claim.id}/payment/reserve`,
      `/api/payments/attempt/dispatch`,
    ])
      assert.equal(
        (await call(replacement.port, path, {}, cookie)).status,
        404,
      );
    for (const sql of protectedSql)
      await assert.rejects(pool.query(sql), { code: "23514" });
    await pool.query("UPDATE sessions SET expires=0 WHERE hash=$1", [
      digest(cookie.split("=")[1]),
    ]);
    assert.equal(
      (await call(replacement.port, "/api/session", undefined, cookie)).body
        .authenticated,
      false,
    );
    pass(
      "SIGKILL + full replacement preserve sessions, exact amount, claim status/history, expiry, rate limits and UNKNOWN locks; expired session rejected",
    );
    assert.equal(restored.body.campaign.amount, 12345);
    assert.deepEqual(await publicSnapshot(direct), before);
    for (const table of [
      "campaigns",
      "claims",
      "sessions",
      "payment_attempts",
      "organiser",
      "staging_rate",
    ])
      assert.equal(
        (await direct.query(`SELECT count(*) AS n FROM public.${table}`))
          .rows[0].n,
        0,
      );
    pass(
      "public application tables remain empty; migration ledger unchanged; no wallet or RPC operations",
    );
    console.log(
      "Synthetic schema retained for review; no DROP, cleanup or public test records.",
    );
  }
} catch {
  console.error(
    `FAIL ${phase}; details suppressed to protect credentials and SQL values`,
  );
  process.exitCode = 1;
} finally {
  for (const w of workers) await w.stop();
  for (const p of pools) await p.end();
}
