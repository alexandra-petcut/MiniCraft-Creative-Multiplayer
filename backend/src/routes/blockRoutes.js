const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../auth");
const {
  getBlock,
  getWorldForUser,
  listBlocks,
  saveBlockChange,
  updateBlockById
} = require("../services/worldService");

const router = express.Router({ mergeParams: true });

router.use(requireAuth);

function requireWorldMember(req, res, next) {
  const worldId = Number(req.params.worldId);
  const world = getWorldForUser(worldId, req.user.id);

  if (!world) {
    return res.status(404).json({ error: "World not found or not joined." });
  }

  req.world = world;
  return next();
}

router.use(requireWorldMember);

router.get("/", (req, res) => {
  res.json({ blocks: listBlocks(req.world.id) });
});

router.post("/", (req, res, next) => {
  try {
    const block = saveBlockChange(req.world.id, req.user.id, req.body);
    return res.status(201).json({ block });
  } catch (error) {
    return next(error);
  }
});

router.put("/:blockId", (req, res, next) => {
  try {
    const block = updateBlockById(req.world.id, Number(req.params.blockId), req.user.id, req.body);
    return res.json({ block });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:blockId", (req, res) => {
  const block = getBlock(req.world.id, Number(req.params.blockId));

  if (!block) {
    return res.status(404).json({ error: "Block record not found." });
  }

  db.prepare("DELETE FROM world_blocks WHERE id = ? AND worldId = ?").run(block.id, req.world.id);

  return res.status(204).send();
});

module.exports = router;

