const path = require("path");

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const BACKEND_DIR = __dirname;

// Keeping runtime paths and limits in one module makes local development,
// production deployments, and isolated test databases use the same settings.
module.exports = {
  backendDir: BACKEND_DIR,
  frontendDir: path.join(BACKEND_DIR, "..", "frontend", "public"),
  databasePath: path.resolve(process.env.DATABASE_PATH || path.join(BACKEND_DIR, "data", "app.db")),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || path.join(BACKEND_DIR, "uploads")),
  maxModelBytes: readPositiveInteger(process.env.MAX_MODEL_BYTES, 300 * 1024 * 1024),
  maxThumbnailBytes: readPositiveInteger(process.env.MAX_THUMBNAIL_BYTES, 5 * 1024 * 1024),
  maxProjectsPerUser: readPositiveInteger(process.env.MAX_PROJECTS_PER_USER, 20),
  maxStorageBytesPerUser: readPositiveInteger(process.env.MAX_STORAGE_BYTES_PER_USER, 1024 * 1024 * 1024)
};
