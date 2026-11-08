import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { openDb } from "../../server/db.js";
import { passwordHash } from "../../server/crypto.js";

test(
  "npm run dev:api loads its env file, serves the real API and survives a watched restart on Node 24",
  { timeout: 25_000 },
  async (t) => {
    const root = resolve(".");
    const directory = mkdtempSync(resolve("data-test-dev-startup-"));
    // Run the exact package script with real source/dependencies in an isolated cwd.
    // Neither Node's env-file loader nor SQLite can open the user's .env or database.
    const script = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ).scripts["dev:api"];
    cpSync(resolve(root, "server"), resolve(directory, "server"), {
      recursive: true,
    });
    cpSync(resolve(root, "shared"), resolve(directory, "shared"), {
      recursive: true,
    });
    symlinkSync(
      resolve(root, "node_modules"),
      resolve(directory, "node_modules"),
      "dir",
    );
    writeFileSync(
      resolve(directory, "package.json"),
      JSON.stringify({ type: "module", scripts: { "dev:api": script } }),
    );
    mkdirSync(resolve(directory, "data"));
    const database = resolve(directory, "data/smoke.sqlite");
    const db = openDb(database);
    db.prepare("INSERT INTO organiser VALUES (1,?)").run(
      passwordHash("isolated-dev-smoke-password"),
    );
    db.close();
    const origin = "http://dev-smoke.invalid";
    writeFileSync(
      resolve(directory, ".env"),
      `APP_ORIGIN=${origin}\nNETWORK=testnet\nHOST=127.0.0.1\nPORT=0\nDATABASE_PATH=./data/smoke.sqlite\nSPENDING_ENABLED=false\nMAX_PAYMENT_LUNA=0\nPAYMENT_FEE_LUNA=0\n`,
    );
    const env = {
      ...process.env,
      NODE_ENV: "development",
      NODE_OPTIONS: "",
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    };
    for (const name of [
      "APP_ORIGIN",
      "NETWORK",
      "HOST",
      "PORT",
      "DATABASE_PATH",
      "SPENDING_ENABLED",
      "SPENDING_NETWORK",
      "MAX_PAYMENT_LUNA",
      "PAYMENT_FEE_LUNA",
      "RPC_URL",
      "RPC_AUTHORIZATION",
    ])
      delete (env as Record<string, string | undefined>)[name];
    const child = spawn("npm", ["run", "dev:api"], {
      cwd: directory,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ports: number[] = [];
    let output = "",
      errors = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk.toString();
      const matches = [...output.matchAll(/NimClaim API port (\d+);/g)];
      for (const match of matches.slice(ports.length))
        ports.push(Number(match[1]));
    });
    child.stderr!.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const closed = once(child, "close");
    t.after(async () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        /* Already stopped. */
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 2000);
      await closed;
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
    });
    async function started(count: number) {
      const deadline = Date.now() + 10_000;
      while (ports.length < count) {
        if (child.exitCode !== null)
          assert.fail(`Development startup exited: ${errors}`);
        if (Date.now() > deadline)
          assert.fail(`Development startup/restart timed out: ${errors}`);
        await new Promise((ok) => setTimeout(ok, 50));
      }
      return `http://127.0.0.1:${ports[count - 1]}`;
    }
    let base = await started(1);
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.origin, origin);
    assert.equal(config.network, "testnet");
    assert.equal(config.payments.enabled, false);
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "isolated-dev-smoke-password" }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await fetch(`${base}/api/campaigns`)).status, 401);
    const campaign = await fetch(`${base}/api/campaigns`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Watch restart smoke",
        description: "Isolated development lifecycle test",
        amount: "1",
        slots: 1,
        expires: Date.now() + 3600_000,
      }),
    });
    assert.equal(campaign.status, 201);
    const id = (await campaign.json()).campaign.id;
    // Edit only the disposable entry point, never the actual working tree.
    appendFileSync(
      resolve(directory, "server/index.ts"),
      "\n// Trigger isolated development watch restart.\n",
    );
    base = await started(2);
    const restored = await fetch(`${base}/api/campaigns/${id}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).campaign.title, "Watch restart smoke");
    assert.equal(
      (await (await fetch(`${base}/api/config`)).json()).payments.enabled,
      false,
    );
  },
);
