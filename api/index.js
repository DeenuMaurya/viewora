// Vercel serverless entry point. The Express app continues to serve both the
// API and the browser pages, so existing relative `/api/...` calls keep
// working after deployment.
module.exports = require("../backend/server");
