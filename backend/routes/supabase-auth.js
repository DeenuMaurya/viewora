const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getSupabase, requireSupabase } = require("../supabase");
const { requireAuth } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimit");

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^[0-9]{7,15}$/;
const authRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

function issueTokenCookie(res, userId) {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

router.post("/register", authRateLimit, async (req, res, next) => {
  const { fullName, email, mobile, password } = req.body || {};
  if (!fullName || !fullName.trim()) return res.status(400).json({ error: "Full name chahiye" });
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: "Valid email chahiye" });
  if (!mobile || !MOBILE_RE.test(mobile))
    return res.status(400).json({ error: "Valid mobile number chahiye (sirf digits, 7-15)" });
  if (!password || password.length < 8)
    return res.status(400).json({ error: "Password kam se kam 8 characters ka ho" });

  try {
    const supabase = getSupabase();
    const normalizedEmail = email.trim().toLowerCase();
    const [emailResult, mobileResult] = await Promise.all([
      supabase.from("users").select("id").eq("email", normalizedEmail).maybeSingle(),
      supabase.from("users").select("id").eq("mobile", mobile).maybeSingle()
    ]);
    if (emailResult.error) throw new Error(emailResult.error.message);
    if (mobileResult.error) throw new Error(mobileResult.error.message);
    if (emailResult.data) return res.status(409).json({ error: "Is email se account already hai" });
    if (mobileResult.data) return res.status(409).json({ error: "Is mobile se account already hai" });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = requireSupabase(
      await supabase
        .from("users")
        .insert({ email: normalizedEmail, password_hash: passwordHash, full_name: fullName.trim(), mobile })
        .select("id, email, full_name")
        .single()
    );
    issueTokenCookie(res, user.id);
    return res.json({ id: user.id, email: user.email, fullName: user.full_name });
  } catch (error) {
    return next(error);
  }
});

router.post("/login", authRateLimit, async (req, res, next) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email aur password dono chahiye" });
  try {
    const supabase = getSupabase();
    const user = requireSupabase(
      await supabase.from("users").select("*").eq("email", email.trim().toLowerCase()).maybeSingle()
    );
    const genericError = { error: "Email ya password galat hai" };
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json(genericError);
    issueTokenCookie(res, user.id);
    return res.json({ id: user.id, email: user.email });
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = requireSupabase(
      await getSupabase()
        .from("users")
        .select("id, email, full_name, mobile, created_at")
        .eq("id", req.userId)
        .maybeSingle()
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(user);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
