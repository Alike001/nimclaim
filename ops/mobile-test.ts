import { spawn, execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  readdirSync,
  readlinkSync,
  rmSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { DatabaseSync, backup } from "node:sqlite";
import https from "node:https";
import { mobileCaddyfile } from "./mobile-config.js";
const root = resolve("."),
  directory = resolve(".local/mobile"),
  statePath = resolve(directory, "state.json");
const caddy = resolve(".local/bin/caddy");
const delay = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type State = {
  origin: string;
  bindIp: string;
  phoneIp: string;
  apiPid: number;
  caddyPid: number;
  caFile: string;
  configFile: string;
};
function owned(pid: number, kind: "api" | "caddy") {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return kind === "api"
      ? args.includes(resolve("server/index.ts")) &&
          readFileSync(`/proc/${pid}/environ`, "utf8")
            .split("\0")
            .includes("NIMCLAIM_MOBILE_TEST=1")
      : args.includes(caddy) && args.includes(resolve(directory, "Caddyfile"));
  } catch {
    return false;
  }
}
function stop(state: State) {
  for (const [pid, kind] of [
    [state.caddyPid, "caddy"],
    [state.apiPid, "api"],
  ] as const)
    if (owned(pid, kind)) process.kill(pid, "SIGTERM");
}
function tlsJson(url: string, ca: Buffer) {
  return new Promise<any>((ok, reject) => {
    const req = https.get(url, { ca, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) throw new Error("HTTPS request rejected");
          ok(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("HTTPS timeout")));
    req.on("error", reject);
  });
}
async function status(state: State) {
  if (!owned(state.apiPid, "api") || !owned(state.caddyPid, "caddy"))
    throw new Error(
      "A private test process is not running. Use mobile:stop before starting again.",
    );
  const info = await tlsJson(
    `${state.origin}/api/config`,
    readFileSync(state.caFile),
  );
  if (
    info.network !== "testnet" ||
    info.payments?.enabled !== false ||
    info.mobileTest !== true ||
    info.origin !== state.origin
  )
    throw new Error("Private test safety/health check failed.");
  console.log(`Private HTTPS healthy: ${state.origin}/#diagnostics`);
  console.log(
    "API TESTNET verified; native payment gate disabled. Phone provider and CA trust still require owner verification.",
  );
  console.log(`Public CA certificate: ${state.caFile}`);
  console.log(
    `Public CA SHA-256 fingerprint: ${new X509Certificate(readFileSync(state.caFile)).fingerprint256}`,
  );
}
async function main() {
  const action = process.argv[2] ?? "status";
  if (action === "status" || action === "stop") {
    if (!existsSync(statePath))
      throw new Error("No private mobile setup state exists.");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
    if (action === "status") await status(state);
    else {
      stop(state);
      rmSync(statePath);
      console.log(
        "Stopped only the recorded private mobile test processes. Desktop development services were left alone.",
      );
    }
    return;
  }
  if (action !== "start")
    throw new Error(
      "Use start --bind-ip PRIVATE_IP --phone-ip PRIVATE_IP, status, or stop.",
    );
  if (existsSync(statePath))
    throw new Error(
      "Private setup state already exists. Use mobile:status or mobile:stop; do not duplicate listeners.",
    );
  const args = process.argv.slice(3),
    bindIp = args[args.indexOf("--bind-ip") + 1],
    phoneIp = args[args.indexOf("--phone-ip") + 1];
  if (!args.includes("--bind-ip") || !args.includes("--phone-ip"))
    throw new Error("Both --bind-ip and --phone-ip are required.");
  const config = mobileCaddyfile(bindIp, phoneIp);
  const iface = Object.entries(networkInterfaces()).find(([, items]) =>
    items?.some(
      (i) => i.family === "IPv4" && i.address === bindIp && !i.internal,
    ),
  );
  if (!iface || /^(docker|br-|veth)/.test(iface[0]))
    throw new Error(
      "The chosen laptop IP must belong to the intended active private LAN interface, not Docker.",
    );
  if (!existsSync(caddy))
    throw new Error(
      "Local Caddy binary missing at .local/bin/caddy. Install a checksum-verified official release there first.",
    );
  if (!existsSync(resolve("dist/index.html")))
    throw new Error("Run npm run build before starting the private test.");
  if (existsSync(".env")) process.loadEnvFile(".env"); // Values are never printed or changed.
  const database = resolve(
    process.env.DATABASE_PATH ?? "./data/nimclaim.sqlite",
  );
  const db = new DatabaseSync(database, { readOnly: true });
  let before: string;
  try {
    if (
      (
        db
          .prepare("SELECT value FROM settings WHERE key='network'")
          .get() as any
      )?.value !== "testnet" ||
      (process.env.NETWORK ?? "testnet") !== "testnet"
    )
      throw new Error(
        "Existing installation must already be TESTNET. No network or data will be changed.",
      );
    if (!db.prepare("SELECT id FROM organiser WHERE id=1").get())
      throw new Error(
        "Existing organiser credentials are required; this command never runs setup.",
      );
    // Verify this is the database already opened by the live API; do not create a parallel empty installation.
    const listener = execFileSync("ss", ["-ltnp", "sport = :3001"], {
      encoding: "utf8",
    });
    const pid = /pid=(\d+)/.exec(listener)?.[1];
    const paths = pid
      ? readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
          try {
            return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
          } catch {
            return [];
          }
        })
      : [];
    if (!paths.includes(database))
      throw new Error(
        "Cannot verify that the running API uses the configured database. Resolve this before mobile testing.",
      );
    const info = await (
      await fetch("http://127.0.0.1:3001/api/config", {
        signal: AbortSignal.timeout(5000),
      })
    ).json();
    if (info.network !== "testnet" || info.payments?.enabled !== false)
      throw new Error(
        "Existing API must be healthy on TESTNET with spending disabled.",
      );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const snapshot = () =>
      JSON.stringify({
        credential: db
          .prepare("SELECT password_hash FROM organiser WHERE id=1")
          .get(),
        attempts: db
          .prepare("SELECT * FROM payment_attempts ORDER BY id")
          .all(),
      });
    before = snapshot();
    const backupFile = resolve(directory, `backup-${Date.now()}.sqlite`);
    await backup(db, backupFile);
    chmodSync(backupFile, 0o600);
    console.log(
      "Consistent protected SQLite backup created; existing credentials and payment attempts are preserved.",
    );
    const origin = `https://${bindIp}:8443`,
      configFile = resolve(directory, "Caddyfile");
    writeFileSync(configFile, config, { mode: 0o600 });
    const env = {
      ...process.env,
      XDG_DATA_HOME: resolve(".local/caddy/data"),
      XDG_CONFIG_HOME: resolve(".local/caddy/config"),
    };
    execFileSync(
      caddy,
      ["validate", "--config", configFile, "--adapter", "caddyfile"],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    for (const port of [3002, 8443]) {
      const found = execFileSync("ss", ["-ltnH", `sport = :${port}`], {
        encoding: "utf8",
      }).trim();
      if (found)
        throw new Error(
          "A required private test port is occupied. Existing listeners will not be stopped.",
        );
    }
    const handles: number[] = [];
    function launch(
      executable: string,
      argv: string[],
      childEnv: NodeJS.ProcessEnv,
      log: string,
    ) {
      const fd = openSync(resolve(directory, log), "a", 0o600);
      handles.push(fd);
      const child = spawn(executable, argv, {
        cwd: root,
        env: childEnv,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      return child.pid!;
    }
    const state: State = {
      origin,
      bindIp,
      phoneIp,
      configFile,
      apiPid: 0,
      caddyPid: 0,
      caFile: resolve(directory, "nimclaim-test-ca.crt"),
    };
    try {
      state.apiPid = launch(
        process.execPath,
        ["--import", "tsx", resolve("server/index.ts")],
        {
          ...env,
          NODE_ENV: "production",
          APP_ORIGIN: origin,
          HOST: "127.0.0.1",
          PORT: "3002",
          DATABASE_PATH: database,
          NETWORK: "testnet",
          SPENDING_ENABLED: "false",
          SPENDING_NETWORK: "",
          MAX_PAYMENT_LUNA: "0",
          RPC_URL: "",
          RPC_AUTHORIZATION: "",
          NIMCLAIM_MOBILE_TEST: "1",
        },
        "api.log",
      );
      for (let n = 0; ; n++) {
        try {
          const r = await fetch("http://127.0.0.1:3002/api/config", {
            signal: AbortSignal.timeout(1000),
          });
          if (r.ok) break;
        } catch {}
        if (n >= 40)
          throw new Error(
            "Private API startup failed; inspect its local log without sharing secrets.",
          );
        await delay(250);
      }
      state.caddyPid = launch(
        caddy,
        ["run", "--config", configFile, "--adapter", "caddyfile"],
        env,
        "https.log",
      );
      const publicRoot = resolve(
        ".local/caddy/data/caddy/pki/authorities/local/root.crt",
      );
      for (let n = 0; !existsSync(publicRoot); n++) {
        if (n >= 40)
          throw new Error("Local certificate authority creation failed.");
        await delay(250);
      }
      copyFileSync(publicRoot, state.caFile);
      chmodSync(state.caFile, 0o644);
      for (let n = 0; ; n++) {
        try {
          await tlsJson(`${origin}/api/config`, readFileSync(state.caFile));
          break;
        } catch {}
        if (n >= 40)
          throw new Error("Private HTTPS could not be verified with its CA.");
        await delay(250);
      }
      if (snapshot() !== before)
        throw new Error(
          "Existing credentials or payment attempts changed unexpectedly; stopping private setup.",
        );
      writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
      await status(state);
    } catch (e) {
      stop(state);
      throw e;
    } finally {
      for (const fd of handles) closeSync(fd);
    }
  } finally {
    db.close();
  }
}
main().catch((error) => {
  // Never print arbitrary filesystem/process/env content or captured Caddy logs.
  const known = error instanceof Error ? error.message : "";
  const safe =
    /^(Use |No private|A private|Private |Both |Distinct |The chosen|Local Caddy|Run npm|Existing |Cannot verify|A required|Consistent |Local certificate)/.test(
      known,
    );
  console.error(
    safe
      ? known
      : "Private mobile setup failed. Check local service health, file permissions and the protected local logs; do not publish their contents.",
  );
  process.exitCode = 1;
});
