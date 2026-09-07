const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");
const FRONTEND_DIR = path.join(__dirname, "..", "frontend", "public");

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.includes("dev-only")) {
  console.warn(
    "\nWARNING: JWT_SECRET abhi bhi dev-only default hai. Deploy karne se PEHLE backend/.env mein ek lamba random secret set karo (e.g. `openssl rand -hex 32`), warna koi bhi login tokens forge kar sakta hai.\n"
  );
}

const app = express();

app.use(express.json());
app.use(cookieParser());

// ---- API routes ----
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);

// ---- Uploaded model files ----
// Served directly by Express here for simplicity. At real scale, move this
// to a CDN/object storage (R2/S3) - serving 30MB+ files from your Node
// process ties up server resources per request.
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ---- Frontend (static pages) ----
app.use(express.static(FRONTEND_DIR));

// Public viewer route: /view/:token loads viewer.html, which then fetches
// the actual project data client-side from /api/projects/public/:token.
app.get("/view/:token", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "viewer.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server chal raha hai: http://localhost:${PORT}`);
});
