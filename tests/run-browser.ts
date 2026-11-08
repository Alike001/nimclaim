import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(
  new URL("../node_modules/@playwright/test/cli.js", import.meta.url),
);
let failed = false;
for (const project of ["desktop-chromium", "mobile-chromium"]) {
  const output = project === "desktop-chromium" ? "desktop" : "mobile";
  const result = spawnSync(
    process.execPath,
    [cli, "test", `--project=${project}`, `--output=test-results/${output}`],
    { stdio: "inherit" },
  );
  if (result.status !== 0) failed = true;
  console.log(`${project}: ${result.status === 0 ? "PASS" : "FAIL"}`);
}
process.exitCode = failed ? 1 : 0;
