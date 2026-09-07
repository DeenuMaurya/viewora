const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "data", "app.db"));
db.pragma("journal_mode = WAL");

// ---- Schema ----
// users:    one row per account. password_hash — NEVER store plain passwords.
// projects: one row per uploaded walkthrough. share_token is the public,
//           unguessable id used in shareable links (separate from the
//           numeric id so links can't be enumerated by counting up).
// rooms:    named points inside a project (Kitchen, Hall, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL DEFAULT '',
    mobile TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    model_filename TEXT NOT NULL,
    share_token TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    start_x REAL,
    start_y REAL,
    start_z REAL,
    start_rx REAL,
    start_ry REAL,
    start_rz REAL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    z REAL NOT NULL,
    rx REAL NOT NULL DEFAULT 0,
    ry REAL NOT NULL DEFAULT 0,
    rz REAL NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
  CREATE INDEX IF NOT EXISTS idx_rooms_project ON rooms(project_id);
`);

// Migration safety net: if an older database from before the rotation
// columns existed is reused, add them instead of crashing. rx/ry/rz are
// pitch/yaw/roll in radians; ry (yaw) came first, rx and rz were added later.
const roomColumns = db.prepare("PRAGMA table_info(rooms)").all().map(c => c.name);
["rx", "ry", "rz"].forEach(col => {
  if (!roomColumns.includes(col)) {
    db.exec(`ALTER TABLE rooms ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
  }
});

// Where the visitor spawns when the walkthrough opens. Deliberately nullable
// rather than defaulting to 0 — NULL means "the author never chose one", which
// keeps the old fallback (first room, else the model centre). A 0 default would
// be indistinguishable from a real start position at the origin.
const projectColumns = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
["start_x", "start_y", "start_z", "start_rx", "start_ry", "start_rz"].forEach(col => {
  if (!projectColumns.includes(col)) {
    db.exec(`ALTER TABLE projects ADD COLUMN ${col} REAL`);
  }
});

const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userColumns.includes("full_name")) {
  db.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
}
if (!userColumns.includes("mobile")) {
  db.exec("ALTER TABLE users ADD COLUMN mobile TEXT NOT NULL DEFAULT ''");
}

module.exports = db;
