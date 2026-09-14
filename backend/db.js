const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const { databasePath, uploadDir } = require("./config");

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
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
    model_size_bytes INTEGER NOT NULL DEFAULT 0,
    thumbnail_filename TEXT,
    thumbnail_size_bytes INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    share_token TEXT UNIQUE NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 1,
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
const roomColumns = db
  .prepare("PRAGMA table_info(rooms)")
  .all()
  .map((c) => c.name);
["rx", "ry", "rz"].forEach((col) => {
  if (!roomColumns.includes(col)) {
    db.exec(`ALTER TABLE rooms ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
  }
});

// Where the visitor spawns when the walkthrough opens. Deliberately nullable
// rather than defaulting to 0 — NULL means "the author never chose one", which
// keeps the old fallback (first room, else the model centre). A 0 default would
// be indistinguishable from a real start position at the origin.
const projectColumns = db
  .prepare("PRAGMA table_info(projects)")
  .all()
  .map((c) => c.name);
["start_x", "start_y", "start_z", "start_rx", "start_ry", "start_rz"].forEach((col) => {
  if (!projectColumns.includes(col)) {
    db.exec(`ALTER TABLE projects ADD COLUMN ${col} REAL`);
  }
});
if (!projectColumns.includes("model_size_bytes")) {
  db.exec("ALTER TABLE projects ADD COLUMN model_size_bytes INTEGER NOT NULL DEFAULT 0");

  // Existing projects predate this column. Fill their sizes from the local
  // upload directory so their first quota check is accurate too.
  const updateModelSize = db.prepare("UPDATE projects SET model_size_bytes = ? WHERE id = ?");
  const projectsWithoutSizes = db
    .prepare("SELECT id, model_filename FROM projects WHERE model_size_bytes = 0")
    .all();
  for (const project of projectsWithoutSizes) {
    const filePath = path.join(uploadDir, project.model_filename);
    try {
      updateModelSize.run(fs.statSync(filePath).size, project.id);
    } catch (error) {
      // A missing legacy upload remains at zero bytes and is still safe to read.
    }
  }
}
if (!projectColumns.includes("is_public")) {
  // Existing share links should continue working until their owner makes a
  // deliberate visibility change, so migrated projects begin as public.
  db.exec("ALTER TABLE projects ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1");
}
if (!projectColumns.includes("thumbnail_filename")) {
  db.exec("ALTER TABLE projects ADD COLUMN thumbnail_filename TEXT");
}
if (!projectColumns.includes("thumbnail_size_bytes")) {
  db.exec("ALTER TABLE projects ADD COLUMN thumbnail_size_bytes INTEGER NOT NULL DEFAULT 0");

  // Include cover images from existing projects in quota accounting too.
  const updateThumbnailSize = db.prepare("UPDATE projects SET thumbnail_size_bytes = ? WHERE id = ?");
  const projectsWithThumbnails = db
    .prepare("SELECT id, thumbnail_filename FROM projects WHERE thumbnail_filename IS NOT NULL")
    .all();
  for (const project of projectsWithThumbnails) {
    const filePath = path.join(uploadDir, project.thumbnail_filename);
    try {
      updateThumbnailSize.run(fs.statSync(filePath).size, project.id);
    } catch (error) {
      // Missing legacy thumbnails remain at zero bytes and are not served.
    }
  }
}
if (!projectColumns.includes("view_count")) {
  db.exec("ALTER TABLE projects ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0");
}

// Record schema milestones so future migrations can be introduced without
// relying on an implicit order in application startup code.
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
db.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)").run(
  "2026-09-14-project-view-count"
);

const userColumns = db
  .prepare("PRAGMA table_info(users)")
  .all()
  .map((c) => c.name);
if (!userColumns.includes("full_name")) {
  db.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
}
if (!userColumns.includes("mobile")) {
  db.exec("ALTER TABLE users ADD COLUMN mobile TEXT NOT NULL DEFAULT ''");
}

module.exports = db;
