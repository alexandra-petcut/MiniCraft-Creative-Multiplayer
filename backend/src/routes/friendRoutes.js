const express = require("express");
const { db, transaction } = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();

router.use(requireAuth);

router.get("/", (req, res) => {
  const friends = db
    .prepare(
      `
        SELECT u.id, u.username, u.displayName, f.createdAt AS friendsSince
        FROM friends f
        JOIN users u ON u.id = f.friendId
        WHERE f.userId = ?
        ORDER BY u.username ASC
      `
    )
    .all(req.user.id);

  res.json({ friends });
});

router.post("/", (req, res) => {
  const username = String(req.body.username || "").trim();
  const friendId = req.body.friendId ? Number(req.body.friendId) : null;

  const friend = username
    ? db
        .prepare("SELECT id, username, displayName, createdAt FROM users WHERE username = ?")
        .get(username)
    : db
        .prepare("SELECT id, username, displayName, createdAt FROM users WHERE id = ?")
        .get(friendId);

  if (!friend) {
    return res.status(404).json({ error: "User not found." });
  }

  if (friend.id === req.user.id) {
    return res.status(400).json({ error: "You cannot add yourself as a friend." });
  }

  transaction(() => {
    db.prepare("INSERT OR IGNORE INTO friends (userId, friendId) VALUES (?, ?)").run(req.user.id, friend.id);
    db.prepare("INSERT OR IGNORE INTO friends (userId, friendId) VALUES (?, ?)").run(friend.id, req.user.id);
  });

  res.status(201).json({ friend });
});

router.delete("/:friendId", (req, res) => {
  const friendId = Number(req.params.friendId);

  transaction(() => {
    db.prepare("DELETE FROM friends WHERE userId = ? AND friendId = ?").run(req.user.id, friendId);
    db.prepare("DELETE FROM friends WHERE userId = ? AND friendId = ?").run(friendId, req.user.id);
  });

  res.status(204).send();
});

module.exports = router;
