const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { nanoid } = require("nanoid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- Multer config ----
// Disk storage (not memory storage) so a 30-50MB upload doesn't sit in RAM.
// Filenames are randomised (nanoid), not derived from the user's original
// filename — this avoids path-traversal tricks (e.g. "../../server.js")
// and filename collisions between different users' uploads.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${nanoid()}${ext}`);
  }
});

const ALLOWED_EXTENSIONS = new Set([".glb", ".gltf"]);

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB hard cap - tune per your storage budget
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error("Sirf .glb ya .gltf files allowed hain"));
    }
    cb(null, true);
  }
});

// ---- Create project (upload model) ----
router.post("/", requireAuth, upload.single("model"), (req, res) => {
  const { name } = req.body || {};
  if (!req.file) return res.status(400).json({ error: "Model file chahiye" });
  if (!name || !name.trim()) {
    fs.unlink(req.file.path, () => {}); // clean up the orphaned upload
    return res.status(400).json({ error: "Project ka naam chahiye" });
  }

  const shareToken = nanoid(12); // unguessable public id, separate from the numeric id
  const info = db
    .prepare("INSERT INTO projects (user_id, name, model_filename, share_token) VALUES (?, ?, ?, ?)")
    .run(req.userId, name.trim(), req.file.filename, shareToken);

  res.json({
    id: info.lastInsertRowid,
    name: name.trim(),
    shareToken,
    shareUrl: `/view/${shareToken}`
  });
});

// ---- List my projects ----
router.get("/", requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT id, name, share_token, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.userId);
  res.json(rows.map(r => ({ id: r.id, name: r.name, shareToken: r.share_token, createdAt: r.created_at })));
});

// ---- Delete a project (ownership enforced) ----
router.delete("/:id", requireAuth, (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  // This check is the single most important line in this file — without
  // it, any logged-in user could delete any other user's project just by
  // guessing a numeric id.
  if (project.user_id !== req.userId) {
    return res.status(403).json({ error: "Ye project tumhara nahi hai" });
  }

  db.prepare("DELETE FROM projects WHERE id = ?").run(project.id); // rooms cascade-delete via FK
  const filePath = path.join(UPLOAD_DIR, project.model_filename);
  fs.unlink(filePath, () => {}); // best-effort — don't fail the request if this errors

  res.json({ ok: true });
});

// ---- Replace all rooms for a project (ownership enforced) ----
router.put("/:id/rooms", requireAuth, (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });
  if (project.user_id !== req.userId) {
    return res.status(403).json({ error: "Ye project tumhara nahi hai" });
  }

  const rooms = Array.isArray(req.body?.rooms) ? req.body.rooms : [];
  const optionalNumber = (v) => v === undefined || Number.isFinite(v);
  const valid = rooms.every(r =>
    typeof r.label === "string" && r.label.trim() &&
    Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z) &&
    optionalNumber(r.rx) && optionalNumber(r.ry) && optionalNumber(r.rz)
  );
  if (!valid) return res.status(400).json({ error: "Rooms data galat format mein hai" });

  // The player start position rides along with the rooms save so the editor
  // has a single "Save changes" action. `start: null` clears it; omitting the
  // key entirely leaves whatever is stored untouched.
  const hasStart = Object.prototype.hasOwnProperty.call(req.body || {}, "start");
  const start = req.body?.start;
  if (hasStart && start !== null) {
    const validStart = start && typeof start === "object" &&
      Number.isFinite(start.x) && Number.isFinite(start.y) && Number.isFinite(start.z) &&
      optionalNumber(start.rx) && optionalNumber(start.ry) && optionalNumber(start.rz);
    if (!validStart) return res.status(400).json({ error: "Start position galat format mein hai" });
  }

  // Simple replace-all sync, wrapped in a transaction so a crash mid-way
  // can't leave the project with half its rooms deleted and half not yet
  // re-inserted.
  const replaceAll = db.transaction((projectId, roomList) => {
    db.prepare("DELETE FROM rooms WHERE project_id = ?").run(projectId);
    const insert = db.prepare("INSERT INTO rooms (project_id, label, x, y, z, rx, ry, rz) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const r of roomList) insert.run(projectId, r.label.trim(), r.x, r.y, r.z, r.rx || 0, r.ry || 0, r.rz || 0);

    if (!hasStart) return;
    const update = db.prepare(
      "UPDATE projects SET start_x = ?, start_y = ?, start_z = ?, start_rx = ?, start_ry = ?, start_rz = ? WHERE id = ?"
    );
    if (start === null) update.run(null, null, null, null, null, null, projectId);
    else update.run(start.x, start.y, start.z, start.rx || 0, start.ry || 0, start.rz || 0, projectId);
  });
  replaceAll(project.id, rooms);

  res.json({ ok: true, count: rooms.length });
});

// ---- Public: get a project by its share token (no auth — this is the viewer endpoint) ----
router.get("/public/:token", (req, res) => {
  const project = db.prepare("SELECT * FROM projects WHERE share_token = ?").get(req.params.token);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  const rooms = db.prepare("SELECT label, x, y, z, rx, ry, rz FROM rooms WHERE project_id = ?").all(project.id);

  // null when the author never set one, so the client can fall back rather
  // than spawning at a meaningless (0,0,0).
  const hasStart = project.start_x !== null && project.start_y !== null && project.start_z !== null;
  const start = hasStart ? {
    x: project.start_x, y: project.start_y, z: project.start_z,
    rx: project.start_rx || 0, ry: project.start_ry || 0, rz: project.start_rz || 0
  } : null;

  res.json({
    name: project.name,
    modelUrl: `/uploads/${project.model_filename}`,
    rooms,
    start
  });
});

module.exports = router;
