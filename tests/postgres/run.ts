import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
const name = `nimclaim-pg-test-${randomBytes(6).toString("hex")}`;
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const reservedPort = (reservation.address() as { port: number }).port;
await new Promise<void>((ok) => reservation.close(() => ok()));
let started = false;
try {
  execFileSync(
    "docker",
    [
      "run",
      "--pull=never",
      "--detach",
      "--name",
      name,
      "--label",
      "nimclaim.disposable-test=true",
      "--publish",
      `127.0.0.1:${reservedPort}:5432`,
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      "POSTGRES_DB=nimclaim_test",
      "postgres:17-alpine",
    ],
    { stdio: "pipe" },
  );
  started = true;
  for (let i = 0; ; i++) {
    try {
      execFileSync(
        "docker",
        ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
        {
          stdio: "ignore",
        },
      );
      break;
    } catch {
      if (i === 60) throw new Error("Disposable Postgres did not start");
      await new Promise((ok) => setTimeout(ok, 250));
    }
  }
  const port = execFileSync("docker", ["port", name, "5432/tcp"], {
    encoding: "utf8",
  })
    .trim()
    .split(":")
    .pop()!;
  console.log(
    "Real disposable PostgreSQL 17 integration; loopback only, synthetic data",
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--test", "tests/postgres/integration.test.ts"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NIMCLAIM_PG_TEST_PORT: port,
        NIMCLAIM_PG_TEST_CONTAINER: name,
      },
    },
  );
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} catch {
  console.error(
    "Postgres integration failed: Docker and local postgres:17-alpine image are required",
  );
  process.exitCode = 1;
} finally {
  if (started)
    execFileSync("docker", ["rm", "--force", "--volumes", name], {
      stdio: "ignore",
    });
}
