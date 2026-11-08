import { openDb } from "./db.js";
import { passwordHash, randomToken } from "./crypto.js";
const db = openDb(process.env.DATABASE_PATH ?? "./data/nimclaim.sqlite");
if (db.prepare("SELECT id FROM organiser").get()) {
  console.error(
    "Organiser already configured. Setup does not overwrite credentials.",
  );
  db.close();
  process.exitCode = 1;
} else {
  const password = randomToken();
  db.prepare("INSERT INTO organiser VALUES (1, ?)").run(passwordHash(password));
  db.close();
  console.log(
    `Organiser password (shown once; save in your password manager):\n${password}`,
  );
}
