import { mkdirSync, writeFileSync } from "node:fs";
import { passwordHash, randomToken } from "../server/crypto.js";
// Owner runs this later, once. Never reuse existing local organiser credentials.
process.umask(0o077);
mkdirSync(".local/staging", { recursive: true, mode: 0o700 });
const password = randomToken();
writeFileSync(
  ".local/staging/credentials.json",
  JSON.stringify(
    { password, STAGING_ORGANISER_PASSWORD_HASH: passwordHash(password) },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Fresh credentials saved to ignored .local/staging/credentials.json. Store the password securely; use this file only for the explicit local bootstrap command. Never upload the password, hash or file to Render.",
);
