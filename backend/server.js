const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const { frontendDir: FRONTEND_DIR } = require("./config");

const jwtSecret = process.env.JWT_SECRET?.trim();
const unsafeJwtSecret =
  !jwtSecret || jwtSecret.length < 32 || /dev-only|replace-this|change-me/i.test(jwtSecret);

if (unsafeJwtSecret) {
  console.error(
    "JWT_SECRET must be a unique random value with at least 32 characters. Copy backend/.env.example to backend/.env and set it before starting the server."
  );
  process.exit(1);
}

const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.info(
      JSON.stringify({
        level: "info",
        requestId,
        method: req.method,
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100
      })
    );
  });
  next();
});

// ---- API routes ----
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);

// ---- Frontend (static pages) ----
app.use(express.static(FRONTEND_DIR));

// Public viewer route: /view/:token loads viewer.html, which then fetches
// the actual project data client-side from /api/projects/public/:token.
app.get("/view/:token", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "viewer.html"));
});

// Keep API failures machine-readable instead of returning Express's default HTML page.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(
    JSON.stringify({
      level: "error",
      requestId: req.requestId,
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    })
  );
  res.status(500).json({ error: "Unexpected server error", requestId: req.requestId });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server chal raha hai: http://localhost:${PORT}`);
  });
}

module.exports = app;
