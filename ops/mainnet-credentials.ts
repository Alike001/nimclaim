import { mkdirSync, writeFileSync } from "node:fs";
import { passwordHash, randomToken } from "../server/crypto.js";
// Owner runs this later, once. Never reuse existing local organiser credentials.
process.umask(0o077);
mkdirSync(".local/mainnet", { recursive: true, mode: 0o700 });
const password = randomToken();
writeFileSync(
  ".local/mainnet/credentials.json",
  JSON.stringify(
    { password, PRODUCTION_ORGANISER_PASSWORD_HASH: passwordHash(password) },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Fresh MAINNET credentials saved to ignored .local/mainnet/credentials.json. Store the password securely; use this file only for the explicit local bootstrap command. Never upload the password, hash or file to Render.",
);
