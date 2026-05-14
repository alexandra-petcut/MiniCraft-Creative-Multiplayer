const express = require("express");
const { db } = require("../db");
const {
  createToken,
  hashPassword,
  requireAuth,
  toPublicUser,
  verifyPassword
} = require("../auth");

const router = express.Router();

router.post("/register", async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const displayName = String(req.body.displayName || username).trim();

    if (username.length < 3) {
      return res.status(400).json({ error: "Username must have at least 3 characters." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must have at least 6 characters." });
    }

    const passwordHash = await hashPassword(password);

    let result;
    try {
      result = db
        .prepare("INSERT INTO users (username, passwordHash, displayName) VALUES (?, ?, ?)")
        .run(username, passwordHash, displayName || username);
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return res.status(409).json({ error: "Username is already taken." });
      }

      throw error;
    }

    const user = db
      .prepare("SELECT id, username, displayName, createdAt FROM users WHERE id = ?")
      .get(result.lastInsertRowid);

    return res.status(201).json({
      token: createToken(user),
      user: toPublicUser(user)
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    return res.json({
      token: createToken(user),
      user: toPublicUser(user)
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: toPublicUser(req.user) });
});

module.exports = router;

