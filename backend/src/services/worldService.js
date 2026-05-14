const crypto = require("crypto");
const { db } = require("../db");
const { STORAGE_BLOCK_TYPES } = require("../config/blockTypes");

const WORLD_SIZE = 100;

function generateInviteCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function createUniqueInviteCode() {
  let code = generateInviteCode();

  while (db.prepare("SELECT id FROM worlds WHERE inviteCode = ?").get(code)) {
    code = generateInviteCode();
  }

  return code;
}

function parseInteger(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) {
    return Number(value);
  }
  return null;
}

function validateCoordinates(input) {
  const x = parseInteger(input.x);
  const y = parseInteger(input.y);
  const z = parseInteger(input.z);

  if (x === null || y === null || z === null) {
    return { ok: false, error: "Coordinates must be integers." };
  }

  const insideBounds =
    x >= 0 &&
    x < WORLD_SIZE &&
    y >= 0 &&
    y < WORLD_SIZE &&
    z >= 0 &&
    z < WORLD_SIZE;

  if (!insideBounds) {
    return { ok: false, error: "Coordinates must be inside the 100x100x100 world." };
  }

  return { ok: true, value: { x, y, z } };
}

function validateBlockType(blockType) {
  if (!STORAGE_BLOCK_TYPES.includes(blockType)) {
    return { ok: false, error: `Unsupported block type: ${blockType}` };
  }

  return { ok: true, value: blockType };
}

function getWorldForUser(worldId, userId) {
  return db
    .prepare(
      `
        SELECT
          w.*,
          wm.role,
          u.username AS ownerUsername,
          u.displayName AS ownerDisplayName,
          (
            SELECT COUNT(*)
            FROM world_members member_count
            WHERE member_count.worldId = w.id
          ) AS memberCount
        FROM worlds w
        JOIN world_members wm ON wm.worldId = w.id
        JOIN users u ON u.id = w.ownerId
        WHERE w.id = ? AND wm.userId = ?
      `
    )
    .get(worldId, userId);
}

function listBlocks(worldId) {
  return db
    .prepare(
      `
        SELECT
          b.*,
          placed.username AS placedByUsername,
          updated.username AS updatedByUsername
        FROM world_blocks b
        JOIN users placed ON placed.id = b.placedByUserId
        JOIN users updated ON updated.id = b.updatedByUserId
        WHERE b.worldId = ?
        ORDER BY b.updatedAt DESC, b.id DESC
      `
    )
    .all(worldId);
}

function getBlock(worldId, blockId) {
  return db.prepare("SELECT * FROM world_blocks WHERE worldId = ? AND id = ?").get(worldId, blockId);
}

function saveBlockChange(worldId, userId, input) {
  const coordinates = validateCoordinates(input);
  if (!coordinates.ok) {
    const error = new Error(coordinates.error);
    error.status = 400;
    throw error;
  }

  const block = validateBlockType(input.blockType);
  if (!block.ok) {
    const error = new Error(block.error);
    error.status = 400;
    throw error;
  }

  const { x, y, z } = coordinates.value;
  const existing = db
    .prepare("SELECT * FROM world_blocks WHERE worldId = ? AND x = ? AND y = ? AND z = ?")
    .get(worldId, x, y, z);

  if (existing) {
    db.prepare(
      `
        UPDATE world_blocks
        SET blockType = ?, updatedByUserId = ?, updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(block.value, userId, existing.id);

    return db.prepare("SELECT * FROM world_blocks WHERE id = ?").get(existing.id);
  }

  const result = db
    .prepare(
      `
        INSERT INTO world_blocks (worldId, x, y, z, blockType, placedByUserId, updatedByUserId)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(worldId, x, y, z, block.value, userId, userId);

  return db.prepare("SELECT * FROM world_blocks WHERE id = ?").get(result.lastInsertRowid);
}

function updateBlockById(worldId, blockId, userId, input) {
  const coordinates = validateCoordinates(input);
  if (!coordinates.ok) {
    const error = new Error(coordinates.error);
    error.status = 400;
    throw error;
  }

  const block = validateBlockType(input.blockType);
  if (!block.ok) {
    const error = new Error(block.error);
    error.status = 400;
    throw error;
  }

  const existing = getBlock(worldId, blockId);
  if (!existing) {
    const error = new Error("Block record not found.");
    error.status = 404;
    throw error;
  }

  const { x, y, z } = coordinates.value;

  try {
    db.prepare(
      `
        UPDATE world_blocks
        SET x = ?, y = ?, z = ?, blockType = ?, updatedByUserId = ?, updatedAt = CURRENT_TIMESTAMP
        WHERE id = ? AND worldId = ?
      `
    ).run(x, y, z, block.value, userId, blockId, worldId);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      const conflict = new Error("Another block record already exists at those coordinates.");
      conflict.status = 409;
      throw conflict;
    }

    throw error;
  }

  return getBlock(worldId, blockId);
}

module.exports = {
  WORLD_SIZE,
  createUniqueInviteCode,
  getBlock,
  getWorldForUser,
  listBlocks,
  saveBlockChange,
  updateBlockById,
  validateBlockType,
  validateCoordinates
};

