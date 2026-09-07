const jwt = require("jsonwebtoken");

// Reads the httpOnly "token" cookie, verifies it, and attaches req.userId.
// httpOnly cookies (not localStorage) are used deliberately — JS running on
// the page can't read them, which blocks a whole class of XSS-based
// session-theft attacks. This is the standard reason to prefer cookies
// over localStorage for auth tokens.
function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Not logged in" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

// Like requireAuth but doesn't fail if there's no token — just leaves
// req.userId undefined. Useful for routes that behave differently for
// logged-in vs anonymous visitors without blocking anonymous access.
function optionalAuth(req, res, next) {
  const token = req.cookies?.token;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = payload.userId;
    } catch (err) {
      // invalid token — just treat as logged out, don't error
    }
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
