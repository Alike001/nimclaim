import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("browser runner executes mobile after desktop failure and preserves failure exit status", () => {
  const directory = mkdtempSync(join(tmpdir(), "nimclaim-browser-runner-"));
  try {
    mkdirSync(join(directory, "tests"));
    mkdirSync(join(directory, "node_modules/@playwright/test"), {
      recursive: true,
    });
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(directory, "node_modules/@playwright/test/package.json"),
      '{"type":"module"}',
    );
    cpSync(
      resolve("tests/run-browser.ts"),
      join(directory, "tests/run-browser.ts"),
    );
    const log = join(directory, "projects.jsonl");
    writeFileSync(
      join(directory, "node_modules/@playwright/test/cli.js"),
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
      process.exit(process.argv.includes('--project=desktop-chromium') ? 1 : 0);
    `,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        join(directory, "tests/run-browser.ts"),
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      ["test", "--project=desktop-chromium", "--output=test-results/desktop"],
      ["test", "--project=mobile-chromium", "--output=test-results/mobile"],
    ]);
    assert.match(result.stdout, /desktop-chromium: FAIL/);
    assert.match(result.stdout, /mobile-chromium: PASS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
