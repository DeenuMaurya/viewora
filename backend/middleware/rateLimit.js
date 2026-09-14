function createRateLimiter({ windowMs, max, keyGenerator = (req) => req.ip || "unknown" }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = keyGenerator(req);
    const current = hits.get(key);

    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }

    current.count += 1;
    return next();
  };
}

module.exports = { createRateLimiter };
