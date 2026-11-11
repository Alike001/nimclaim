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
  "Fresh MAINNET legacy-link credentials saved to ignored .local/mainnet/credentials.json. Store the password securely; the hash is used for one-time bootstrap and the password can link the original workspace to its owner's wallet once. Never upload the password, hash or file to Render.",
);
