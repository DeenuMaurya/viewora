const fs = require("fs");
const path = require("path");
const db = require("../db");
const { backendDir } = require("../config");

const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(backendDir, "backups"));
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = path.join(backupDir, `viewora-${timestamp}.db`);

async function main() {
  fs.mkdirSync(backupDir, { recursive: true });
  await db.backup(destination);
  console.log(`Database backup created: ${destination}`);
  db.close();
}

main().catch((error) => {
  console.error("Database backup failed:", error);
  db.close();
  process.exitCode = 1;
});
