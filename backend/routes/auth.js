const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^[0-9]{7,15}$/; // digits only — strip spaces/dashes/+ on the client before sending

function issueTokenCookie(res, userId) {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.cookie("token", token, {
    httpOnly: true,               // JS on the page can't read this — blocks XSS token theft
    secure: process.env.NODE_ENV === "production", // HTTPS-only in production
    sameSite: "lax",               // basic CSRF protection
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

router.post("/register", async (req, res) => {
  const { fullName, email, mobile, password } = req.body || {};

  if (!fullName || !fullName.trim()) {
    return res.status(400).json({ error: "Full name chahiye" });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Valid email chahiye" });
  }
  if (!mobile || !MOBILE_RE.test(mobile)) {
    return res.status(400).json({ error: "Valid mobile number chahiye (sirf digits, 7-15)" });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password kam se kam 8 characters ka ho" });
  }

  const existingEmail = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existingEmail) {
    return res.status(409).json({ error: "Is email se account already hai" });
  }
  const existingMobile = db.prepare("SELECT id FROM users WHERE mobile = ?").get(mobile);
  if (existingMobile) {
    return res.status(409).json({ error: "Is mobile number se account already hai" });
  }

  // Cost factor 12 — deliberately slow (~100-300ms) to resist brute-force
  // guessing, but not so slow it hurts UX. 10 is the bcryptjs default and
  // is fine too; 12 is a reasonable modern floor.
  const passwordHash = await bcrypt.hash(password, 12);
  const info = db
    .prepare("INSERT INTO users (email, password_hash, full_name, mobile) VALUES (?, ?, ?, ?)")
    .run(email, passwordHash, fullName.trim(), mobile);

  issueTokenCookie(res, info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, email, fullName: fullName.trim() });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email aur password dono chahiye" });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  // Deliberately vague error for both "no such user" and "wrong password" —
  // a specific "no account with this email" message lets an attacker
  // enumerate which emails are registered.
  const genericError = { error: "Email ya password galat hai" };
  if (!user) return res.status(401).json(genericError);

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json(genericError);

  issueTokenCookie(res, user.id);
  res.json({ id: user.id, email: user.email });
});

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, full_name, mobile, created_at FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

module.exports = router;
