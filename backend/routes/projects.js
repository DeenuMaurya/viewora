const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { nanoid } = require("nanoid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimit");
const config = require("../config");

const router = express.Router();

const UPLOAD_DIR = config.uploadDir;
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

const MAX_PROJECTS_PER_USER = config.maxProjectsPerUser;
const MAX_STORAGE_BYTES_PER_USER = config.maxStorageBytes;
const MAX_PROJECT_NAME_LENGTH = 100;
const MAX_THUMBNAIL_BYTES = config.maxThumbnailBytes;
const THUMBNAIL_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const PROJECT_SORT_ORDERS = {
  newest: "created_at DESC, id DESC",
  oldest: "created_at ASC, id ASC",
  name: "name COLLATE NOCASE ASC, id DESC"
};
const uploadRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `user:${req.userId}`
});
const downloadRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `user:${req.userId}`
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxModelBytes }, // configurable hard cap - tune per storage budget
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".glb") {
      return cb(new Error("Only self-contained .glb files are supported"));
    }
    cb(null, true);
  }
});

const thumbnailUpload = multer({
  storage,
  limits: { fileSize: MAX_THUMBNAIL_BYTES },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!THUMBNAIL_EXTENSIONS.has(extension)) {
      return cb(new Error("Thumbnail must be a PNG, JPG, or WebP image"));
    }
    return cb(null, true);
  }
});

function removeUploadedFile(file) {
  if (file?.path) fs.unlink(file.path, () => {});
}

function validateGlbUpload(req, res, next) {
  if (!req.file) return next();

  try {
    const header = Buffer.alloc(12);
    const fileDescriptor = fs.openSync(req.file.path, "r");
    const bytesRead = fs.readSync(fileDescriptor, header, 0, header.length, 0);
    fs.closeSync(fileDescriptor);
    const hasGlbMagic = bytesRead === 12 && header.toString("ascii", 0, 4) === "glTF";
    const isVersionTwo = hasGlbMagic && header.readUInt32LE(4) === 2;
    const declaredLength = hasGlbMagic ? header.readUInt32LE(8) : 0;

    if (!isVersionTwo || declaredLength !== req.file.size) {
      removeUploadedFile(req.file);
      return res.status(400).json({ error: "Upload a valid GLB 2.0 model file" });
    }
  } catch (error) {
    removeUploadedFile(req.file);
    return res.status(400).json({ error: "The uploaded model could not be validated" });
  }

  return next();
}

function isValidThumbnail(file) {
  const extension = path.extname(file.filename).toLowerCase();
  if (!THUMBNAIL_EXTENSIONS.has(extension)) return false;

  const header = Buffer.alloc(12);
  const fileDescriptor = fs.openSync(file.path, "r");
  let bytesRead;
  try {
    bytesRead = fs.readSync(fileDescriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fileDescriptor);
  }

  const isPng =
    bytesRead >= 8 &&
    header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isWebp =
    bytesRead === 12 &&
    header.toString("ascii", 0, 4) === "RIFF" &&
    header.toString("ascii", 8, 12) === "WEBP";
  return (
    (extension === ".png" && isPng) ||
    ([".jpg", ".jpeg"].includes(extension) && isJpeg) ||
    (extension === ".webp" && isWebp)
  );
}

function validateThumbnailUpload(req, res, next) {
  if (!req.file) return res.status(400).json({ error: "Thumbnail image chahiye" });

  try {
    if (!isValidThumbnail(req.file)) {
      removeUploadedFile(req.file);
      return res.status(400).json({ error: "Upload a valid PNG, JPG, or WebP thumbnail" });
    }
  } catch (error) {
    removeUploadedFile(req.file);
    return res.status(400).json({ error: "The thumbnail could not be validated" });
  }

  return next();
}

function getProjectUsage(userId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS project_count, COALESCE(SUM(model_size_bytes + thumbnail_size_bytes), 0) AS storage_bytes FROM projects WHERE user_id = ?"
    )
    .get(userId);
}

function checkProjectQuota(req, res, next) {
  const usage = getProjectUsage(req.userId);

  if (usage.project_count >= MAX_PROJECTS_PER_USER) {
    return res.status(429).json({ error: "Project limit reached for this account" });
  }

  req.projectUsage = usage;
  return next();
}

// ---- Create project (upload model) ----
router.post(
  "/",
  requireAuth,
  uploadRateLimit,
  checkProjectQuota,
  upload.single("model"),
  validateGlbUpload,
  (req, res) => {
    const { name } = req.body || {};
    if (!req.file) return res.status(400).json({ error: "Model file chahiye" });
    if (!name || !name.trim() || name.trim().length > MAX_PROJECT_NAME_LENGTH) {
      removeUploadedFile(req.file);
      return res.status(400).json({ error: "Project name must be 1-100 characters" });
    }
    if (req.projectUsage.storage_bytes + req.file.size > MAX_STORAGE_BYTES_PER_USER) {
      removeUploadedFile(req.file);
      return res.status(413).json({ error: "Storage limit reached for this account" });
    }

    const shareToken = nanoid(12); // unguessable public id, separate from the numeric id
    const info = db
      .prepare(
        "INSERT INTO projects (user_id, name, model_filename, model_size_bytes, share_token) VALUES (?, ?, ?, ?, ?)"
      )
      .run(req.userId, name.trim(), req.file.filename, req.file.size, shareToken);

    res.json({
      id: info.lastInsertRowid,
      name: name.trim(),
      shareToken,
      shareUrl: `/view/${shareToken}`
    });
  }
);

// ---- List my projects ----
router.get("/", requireAuth, (req, res) => {
  const query =
    typeof req.query.query === "string" ? req.query.query.trim().slice(0, MAX_PROJECT_NAME_LENGTH) : "";
  const visibility = req.query.visibility;
  const sort =
    typeof req.query.sort === "string" && PROJECT_SORT_ORDERS[req.query.sort] ? req.query.sort : "newest";
  const conditions = ["user_id = ?"];
  const values = [req.userId];

  if (visibility === "public") conditions.push("is_public = 1");
  if (visibility === "private") conditions.push("is_public = 0");
  if (query) {
    // instr performs a literal, case-insensitive substring search. It avoids
    // treating user-entered % and _ characters as SQL LIKE wildcards.
    conditions.push("instr(lower(name), lower(?)) > 0");
    values.push(query);
  }

  const rows = db
    .prepare(
      `SELECT id, name, share_token, is_public, thumbnail_filename, created_at FROM projects WHERE ${conditions.join(" AND ")} ORDER BY ${PROJECT_SORT_ORDERS[sort]}`
    )
    .all(...values);
  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      shareToken: r.share_token,
      isPublic: Boolean(r.is_public),
      thumbnailUrl: r.thumbnail_filename ? `/api/projects/${r.id}/thumbnail` : null,
      createdAt: r.created_at
    }))
  );
});

function getOwnedProject(projectId, userId) {
  return db.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId);
}

function getModelPath(project) {
  const filename = path.basename(project.model_filename);
  if (filename !== project.model_filename) return null;

  const extension = path.extname(filename).toLowerCase();
  if (extension !== ".glb" && extension !== ".gltf") return null;

  const filePath = path.join(UPLOAD_DIR, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

function resolveThumbnailPath(filename) {
  if (!filename || typeof filename !== "string") return null;
  const safeFilename = path.basename(filename);
  if (safeFilename !== filename || !THUMBNAIL_EXTENSIONS.has(path.extname(safeFilename).toLowerCase()))
    return null;
  return path.join(UPLOAD_DIR, safeFilename);
}

function getThumbnailPath(project) {
  const filePath = resolveThumbnailPath(project.thumbnail_filename);
  return filePath && fs.existsSync(filePath) ? filePath : null;
}

function copyProjectAsset(sourcePath) {
  const extension = path.extname(sourcePath).toLowerCase();
  const filename = `${nanoid()}${extension}`;
  const destinationPath = path.join(UPLOAD_DIR, filename);
  fs.copyFileSync(sourcePath, destinationPath);
  return { filename, path: destinationPath, size: fs.statSync(destinationPath).size };
}

function removeCopiedAssets(assets) {
  assets.forEach((asset) => {
    if (asset?.path) fs.unlink(asset.path, () => {});
  });
}

function duplicateProjectName(name) {
  return `Copy of ${name}`.slice(0, MAX_PROJECT_NAME_LENGTH);
}

function modelUrl(project, routePrefix) {
  return `${routePrefix}/model${path.extname(project.model_filename).toLowerCase()}`;
}

function sendProjectModel(res, project, requestedExtension) {
  const modelExtension = path.extname(project.model_filename).toLowerCase();
  if (requestedExtension.toLowerCase() !== modelExtension.slice(1)) {
    return res.status(404).json({ error: "Model file nahi mila" });
  }

  const filePath = getModelPath(project);
  if (!filePath) return res.status(404).json({ error: "Model file nahi mila" });

  res.type(modelExtension === ".glb" ? "model/gltf-binary" : "model/gltf+json");
  return res.sendFile(filePath);
}

function sendProjectThumbnail(res, project) {
  const filePath = getThumbnailPath(project);
  if (!filePath) return res.status(404).json({ error: "Thumbnail nahi mila" });

  const extension = path.extname(filePath).toLowerCase();
  const contentType = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[extension];
  res.set("Cache-Control", "private, max-age=3600");
  res.type(contentType);
  return res.sendFile(filePath);
}

function projectDownloadName(project) {
  const safeName = project.name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .trim()
    .slice(0, 80);
  return `${safeName || "viewora-project"}.glb`;
}

function serializeProject(project, modelUrl) {
  const rooms = db
    .prepare("SELECT label, x, y, z, rx, ry, rz FROM rooms WHERE project_id = ?")
    .all(project.id);
  const hasStart = project.start_x !== null && project.start_y !== null && project.start_z !== null;
  const start = hasStart
    ? {
        x: project.start_x,
        y: project.start_y,
        z: project.start_z,
        rx: project.start_rx || 0,
        ry: project.start_ry || 0,
        rz: project.start_rz || 0
      }
    : null;

  return {
    name: project.name,
    modelUrl,
    rooms,
    start
  };
}

function bytesForHumans(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

// ---- Owner-only: compact project facts for the dashboard ----
router.get("/:id/details", requireAuth, (req, res) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  const roomCount = db
    .prepare("SELECT COUNT(*) AS count FROM rooms WHERE project_id = ?")
    .get(project.id).count;
  const modelPath = getModelPath(project);
  const thumbnailPath = getThumbnailPath(project);
  const storageBytes = (project.model_size_bytes || 0) + (project.thumbnail_size_bytes || 0);
  return res.json({
    id: project.id,
    name: project.name,
    createdAt: project.created_at,
    isPublic: Boolean(project.is_public),
    shareUrl: `/view/${project.share_token}`,
    views: project.view_count || 0,
    roomCount,
    modelSizeBytes: project.model_size_bytes || 0,
    thumbnailSizeBytes: project.thumbnail_size_bytes || 0,
    storageBytes,
    storageLabel: bytesForHumans(storageBytes),
    modelAvailable: Boolean(modelPath),
    thumbnailAvailable: Boolean(thumbnailPath)
  });
});

// ---- Owner-only: data used by the editor ----
router.get("/:id/editor", requireAuth, (req, res) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) {
    return res.status(404).json({ error: "Project nahi mila" });
  }

  res.json(serializeProject(project, modelUrl(project, `/api/projects/${project.id}`)));
});

// ---- Owner-only: download an original GLB backup ----
router.get("/:id/download", requireAuth, downloadRateLimit, (req, res) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  const modelPath = getModelPath(project);
  if (!modelPath || path.extname(modelPath).toLowerCase() !== ".glb") {
    return res.status(404).json({ error: "A downloadable GLB model is not available" });
  }

  res.type("model/gltf-binary");
  res.attachment(projectDownloadName(project));
  return res.sendFile(modelPath);
});

// ---- Owner-only: dashboard cover image ----
router.get("/:id/thumbnail", requireAuth, (req, res) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });
  return sendProjectThumbnail(res, project);
});

function attachOwnedProject(req, res, next) {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });
  req.project = project;
  return next();
}

// ---- Owner-only: add or replace a dashboard cover image ----
router.post(
  "/:id/thumbnail",
  requireAuth,
  attachOwnedProject,
  thumbnailUpload.single("thumbnail"),
  validateThumbnailUpload,
  (req, res, next) => {
    const oldThumbnailPath = resolveThumbnailPath(req.project.thumbnail_filename);
    try {
      const usage = db
        .prepare(
          "SELECT COALESCE(SUM(model_size_bytes + thumbnail_size_bytes), 0) AS storage_bytes FROM projects WHERE user_id = ?"
        )
        .get(req.userId);
      const replacedSize = req.project.thumbnail_size_bytes || 0;
      if (usage.storage_bytes - replacedSize + req.file.size > MAX_STORAGE_BYTES_PER_USER) {
        removeUploadedFile(req.file);
        return res.status(413).json({ error: "Storage limit reached for this account" });
      }

      db.prepare("UPDATE projects SET thumbnail_filename = ?, thumbnail_size_bytes = ? WHERE id = ?").run(
        req.file.filename,
        req.file.size,
        req.project.id
      );
      if (oldThumbnailPath && oldThumbnailPath !== req.file.path) fs.unlink(oldThumbnailPath, () => {});
      return res.json({ thumbnailUrl: `/api/projects/${req.project.id}/thumbnail` });
    } catch (error) {
      removeUploadedFile(req.file);
      return next(error);
    }
  }
);

// ---- Owner-only: remove a dashboard cover image ----
router.delete("/:id/thumbnail", requireAuth, attachOwnedProject, (req, res) => {
  const thumbnailPath = resolveThumbnailPath(req.project.thumbnail_filename);
  db.prepare("UPDATE projects SET thumbnail_filename = NULL, thumbnail_size_bytes = 0 WHERE id = ?").run(
    req.project.id
  );
  if (thumbnailPath) fs.unlink(thumbnailPath, () => {});
  return res.json({ ok: true });
});

// ---- Owner-only: load the model for the editor ----
router.get("/:id/model.:extension", requireAuth, (req, res) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });
  return sendProjectModel(res, project, req.params.extension);
});

// ---- Update project name or visibility (ownership enforced) ----
router.patch("/:id", requireAuth, (req, res) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  const body = req.body || {};
  const updates = [];
  const values = [];

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.trim().length > MAX_PROJECT_NAME_LENGTH
    ) {
      return res.status(400).json({ error: "Project name must be 1-100 characters" });
    }
    updates.push("name = ?");
    values.push(body.name.trim());
  }

  if (Object.prototype.hasOwnProperty.call(body, "isPublic")) {
    if (typeof body.isPublic !== "boolean") {
      return res.status(400).json({ error: "isPublic must be true or false" });
    }
    updates.push("is_public = ?");
    values.push(body.isPublic ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "No project changes supplied" });
  }

  values.push(project.id);
  db.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  const updated = getOwnedProject(project.id, req.userId);
  return res.json({
    id: updated.id,
    name: updated.name,
    shareToken: updated.share_token,
    isPublic: Boolean(updated.is_public)
  });
});

// ---- Owner-only: duplicate a walkthrough as a private draft ----
router.post("/:id/duplicate", requireAuth, uploadRateLimit, (req, res, next) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  const modelPath = getModelPath(project);
  if (!modelPath || path.extname(modelPath).toLowerCase() !== ".glb") {
    return res.status(400).json({ error: "Only projects with an available GLB model can be duplicated" });
  }

  const thumbnailPath = getThumbnailPath(project);
  const modelSize = fs.statSync(modelPath).size;
  const thumbnailSize = thumbnailPath ? fs.statSync(thumbnailPath).size : 0;
  const usage = getProjectUsage(req.userId);

  if (usage.project_count >= MAX_PROJECTS_PER_USER) {
    return res.status(429).json({ error: "Project limit reached for this account" });
  }
  if (usage.storage_bytes + modelSize + thumbnailSize > MAX_STORAGE_BYTES_PER_USER) {
    return res.status(413).json({ error: "Storage limit reached for this account" });
  }

  const copiedAssets = [];
  try {
    const copiedModel = copyProjectAsset(modelPath);
    copiedAssets.push(copiedModel);
    const copiedThumbnail = thumbnailPath ? copyProjectAsset(thumbnailPath) : null;
    if (copiedThumbnail) copiedAssets.push(copiedThumbnail);

    const createDuplicate = db.transaction(() => {
      const shareToken = nanoid(12);
      const info = db
        .prepare(
          `
        INSERT INTO projects (
          user_id, name, model_filename, model_size_bytes, thumbnail_filename,
          thumbnail_size_bytes, share_token, is_public,
          start_x, start_y, start_z, start_rx, start_ry, start_rz
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          req.userId,
          duplicateProjectName(project.name),
          copiedModel.filename,
          copiedModel.size,
          copiedThumbnail?.filename || null,
          copiedThumbnail?.size || 0,
          shareToken,
          project.start_x,
          project.start_y,
          project.start_z,
          project.start_rx,
          project.start_ry,
          project.start_rz
        );
      const duplicateId = info.lastInsertRowid;
      const rooms = db
        .prepare("SELECT label, x, y, z, rx, ry, rz FROM rooms WHERE project_id = ?")
        .all(project.id);
      const insertRoom = db.prepare(
        "INSERT INTO rooms (project_id, label, x, y, z, rx, ry, rz) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      rooms.forEach((room) => {
        insertRoom.run(duplicateId, room.label, room.x, room.y, room.z, room.rx, room.ry, room.rz);
      });
      return { id: duplicateId, shareToken, roomCount: rooms.length };
    });

    const duplicate = createDuplicate();
    return res.status(201).json({
      id: duplicate.id,
      name: duplicateProjectName(project.name),
      isPublic: false,
      shareToken: duplicate.shareToken,
      roomCount: duplicate.roomCount,
      thumbnailUrl: copiedThumbnail ? `/api/projects/${duplicate.id}/thumbnail` : null
    });
  } catch (error) {
    removeCopiedAssets(copiedAssets);
    return next(error);
  }
});

// ---- Replace a public share link (ownership enforced) ----
router.post("/:id/share-token", requireAuth, (req, res) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  const shareToken = nanoid(12);
  db.prepare("UPDATE projects SET share_token = ? WHERE id = ?").run(shareToken, project.id);
  return res.json({ shareToken, shareUrl: `/view/${shareToken}` });
});

// ---- Delete a project (ownership enforced) ----
async function removeStoredFile(filePath) {
  if (!filePath) return "not_applicable";
  try {
    await fs.promises.unlink(filePath);
    return "removed";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    console.error(
      JSON.stringify({ level: "warn", event: "asset_cleanup_failed", filePath, code: error.code })
    );
    return "failed";
  }
}

router.delete("/:id", requireAuth, async (req, res) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  db.prepare("DELETE FROM projects WHERE id = ?").run(project.id); // rooms cascade-delete via FK
  const filePath = getModelPath(project);
  const thumbnailPath = resolveThumbnailPath(project.thumbnail_filename);
  const cleanup = {
    model: await removeStoredFile(filePath),
    thumbnail: await removeStoredFile(thumbnailPath)
  };
  const cleanupFailed = Object.values(cleanup).includes("failed");

  res.json({
    ok: true,
    cleanup,
    warning: cleanupFailed
      ? "Project record was removed, but one or more stored files need manual cleanup."
      : undefined
  });
});

// ---- Replace all rooms for a project (ownership enforced) ----
router.put("/:id/rooms", requireAuth, (req, res) => {
  const project = getOwnedProject(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  const rooms = Array.isArray(req.body?.rooms) ? req.body.rooms : [];
  const optionalNumber = (v) => v === undefined || Number.isFinite(v);
  const valid = rooms.every(
    (r) =>
      typeof r.label === "string" &&
      r.label.trim() &&
      Number.isFinite(r.x) &&
      Number.isFinite(r.y) &&
      Number.isFinite(r.z) &&
      optionalNumber(r.rx) &&
      optionalNumber(r.ry) &&
      optionalNumber(r.rz)
  );
  if (!valid) return res.status(400).json({ error: "Rooms data galat format mein hai" });

  // The player start position rides along with the rooms save so the editor
  // has a single "Save changes" action. `start: null` clears it; omitting the
  // key entirely leaves whatever is stored untouched.
  const hasStart = Object.prototype.hasOwnProperty.call(req.body || {}, "start");
  const start = req.body?.start;
  if (hasStart && start !== null) {
    const validStart =
      start &&
      typeof start === "object" &&
      Number.isFinite(start.x) &&
      Number.isFinite(start.y) &&
      Number.isFinite(start.z) &&
      optionalNumber(start.rx) &&
      optionalNumber(start.ry) &&
      optionalNumber(start.rz);
    if (!validStart) return res.status(400).json({ error: "Start position galat format mein hai" });
  }

  // Simple replace-all sync, wrapped in a transaction so a crash mid-way
  // can't leave the project with half its rooms deleted and half not yet
  // re-inserted.
  const replaceAll = db.transaction((projectId, roomList) => {
    db.prepare("DELETE FROM rooms WHERE project_id = ?").run(projectId);
    const insert = db.prepare(
      "INSERT INTO rooms (project_id, label, x, y, z, rx, ry, rz) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const r of roomList)
      insert.run(projectId, r.label.trim(), r.x, r.y, r.z, r.rx || 0, r.ry || 0, r.rz || 0);

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
  const project = db
    .prepare("SELECT * FROM projects WHERE share_token = ? AND is_public = 1")
    .get(req.params.token);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });

  db.prepare("UPDATE projects SET view_count = view_count + 1 WHERE id = ?").run(project.id);
  res.json(serializeProject(project, modelUrl(project, `/api/projects/public/${project.share_token}`)));
});

// ---- Public: model bytes for a valid public share link ----
router.get("/public/:token/model.:extension", (req, res) => {
  const project = db
    .prepare("SELECT * FROM projects WHERE share_token = ? AND is_public = 1")
    .get(req.params.token);
  if (!project) return res.status(404).json({ error: "Project nahi mila" });
  return sendProjectModel(res, project, req.params.extension);
});

// Multer errors otherwise become Express's default HTML error page.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error:
        err.field === "thumbnail" ? "Thumbnail must be 5MB or smaller" : "Model file must be 300MB or smaller"
    });
  }
  if (err) return res.status(400).json({ error: err.message || "Upload failed" });
  return next();
});

module.exports = router;
