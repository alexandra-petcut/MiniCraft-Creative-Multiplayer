const express = require("express");
const { db, transaction } = require("../db");
const { requireAuth } = require("../auth");
const { createUniqueInviteCode, getWorldForUser, WORLD_SIZE } = require("../services/worldService");

const router = express.Router();

router.use(requireAuth);

router.get("/", (req, res) => {
  const worlds = db
    .prepare(
      `
        SELECT
          w.*,
          wm.role,
          owner.username AS ownerUsername,
          owner.displayName AS ownerDisplayName,
          (
            SELECT COUNT(*)
            FROM world_members member_count
            WHERE member_count.worldId = w.id
          ) AS memberCount
        FROM world_members wm
        JOIN worlds w ON w.id = wm.worldId
        JOIN users owner ON owner.id = w.ownerId
        WHERE wm.userId = ?
        ORDER BY w.createdAt DESC
      `
    )
    .all(req.user.id);

  res.json({ worlds });
});

router.post("/", (req, res) => {
  const name = String(req.body.name || "").trim();

  if (name.length < 3) {
    return res.status(400).json({ error: "World name must have at least 3 characters." });
  }

  const worldId = transaction(() => {
    const result = db
      .prepare(
        `
          INSERT INTO worlds (name, ownerId, inviteCode, sizeX, sizeY, sizeZ)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(name, req.user.id, createUniqueInviteCode(), WORLD_SIZE, WORLD_SIZE, WORLD_SIZE);

    db.prepare("INSERT INTO world_members (worldId, userId, role) VALUES (?, ?, 'owner')").run(
      result.lastInsertRowid,
      req.user.id
    );

    return result.lastInsertRowid;
  });
  const world = getWorldForUser(worldId, req.user.id);

  res.status(201).json({ world });
});

router.post("/join/:inviteCode", (req, res) => {
  const inviteCode = String(req.params.inviteCode || "").trim().toUpperCase();
  const world = db.prepare("SELECT * FROM worlds WHERE inviteCode = ?").get(inviteCode);

  if (!world) {
    return res.status(404).json({ error: "World invite code not found." });
  }

  db.prepare("INSERT OR IGNORE INTO world_members (worldId, userId, role) VALUES (?, ?, 'member')").run(
    world.id,
    req.user.id
  );

  res.status(201).json({ world: getWorldForUser(world.id, req.user.id) });
});

router.get("/:worldId", (req, res) => {
  const world = getWorldForUser(Number(req.params.worldId), req.user.id);

  if (!world) {
    return res.status(404).json({ error: "World not found or not joined." });
  }

  res.json({ world });
});

router.patch("/:worldId", (req, res) => {
  const world = getWorldForUser(Number(req.params.worldId), req.user.id);

  if (!world) {
    return res.status(404).json({ error: "World not found or not joined." });
  }

  if (world.ownerId !== req.user.id) {
    return res.status(403).json({ error: "Only the world owner can rename it." });
  }

  const name = String(req.body.name || "").trim();
  if (name.length < 3) {
    return res.status(400).json({ error: "World name must have at least 3 characters." });
  }

  db.prepare("UPDATE worlds SET name = ? WHERE id = ?").run(name, world.id);

  res.json({ world: getWorldForUser(world.id, req.user.id) });
});

router.delete("/:worldId", (req, res) => {
  const world = getWorldForUser(Number(req.params.worldId), req.user.id);

  if (!world) {
    return res.status(404).json({ error: "World not found or not joined." });
  }

  if (world.ownerId !== req.user.id) {
    return res.status(403).json({ error: "Only the world owner can delete it." });
  }

  db.prepare("DELETE FROM worlds WHERE id = ?").run(world.id);

  res.status(204).send();
});

module.exports = router;
