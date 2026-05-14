const { ANIMAL_TYPES } = require("../config/animalTypes");
const { db } = require("../db");
const { WORLD_SIZE } = require("./worldService");

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function validateAnimalType(animalType) {
  if (!ANIMAL_TYPES.includes(animalType)) {
    return { ok: false, error: `Unsupported animal type: ${animalType}` };
  }

  return { ok: true, value: animalType };
}

function validateAnimalPosition(input) {
  const x = toNumber(input.x);
  const y = toNumber(input.y);
  const z = toNumber(input.z);
  const yaw = toNumber(input.yaw ?? 0) ?? 0;

  if (x === null || y === null || z === null) {
    return { ok: false, error: "Animal position must include numeric x, y, and z." };
  }

  const insideBounds =
    x >= 0 &&
    x < WORLD_SIZE &&
    y >= 0 &&
    y < WORLD_SIZE &&
    z >= 0 &&
    z < WORLD_SIZE;

  if (!insideBounds) {
    return { ok: false, error: "Animal position must be inside the 100x100x100 world." };
  }

  return { ok: true, value: { x, y, z, yaw } };
}

function listAnimals(worldId) {
  return db
    .prepare(
      `
        SELECT a.*, u.username AS spawnedByUsername
        FROM world_animals a
        JOIN users u ON u.id = a.spawnedByUserId
        WHERE a.worldId = ?
        ORDER BY a.id ASC
      `
    )
    .all(worldId);
}

function getAnimal(worldId, animalId) {
  return db.prepare("SELECT * FROM world_animals WHERE worldId = ? AND id = ?").get(worldId, animalId);
}

function createAnimal(worldId, userId, input) {
  const animalType = validateAnimalType(input.animalType);
  if (!animalType.ok) {
    const error = new Error(animalType.error);
    error.status = 400;
    throw error;
  }

  const position = validateAnimalPosition(input);
  if (!position.ok) {
    const error = new Error(position.error);
    error.status = 400;
    throw error;
  }

  const { x, y, z, yaw } = position.value;
  const result = db
    .prepare(
      `
        INSERT INTO world_animals (worldId, animalType, x, y, z, yaw, spawnedByUserId)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(worldId, animalType.value, x, y, z, yaw, userId);

  return db.prepare("SELECT * FROM world_animals WHERE id = ?").get(result.lastInsertRowid);
}

function updateAnimalPosition(animalId, position) {
  db.prepare(
    `
      UPDATE world_animals
      SET x = ?, y = ?, z = ?, yaw = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(position.x, position.y, position.z, position.yaw, animalId);
}

function deleteAnimal(worldId, animalId) {
  db.prepare("DELETE FROM world_animals WHERE worldId = ? AND id = ?").run(worldId, animalId);
}

module.exports = {
  ANIMAL_TYPES,
  createAnimal,
  deleteAnimal,
  getAnimal,
  listAnimals,
  updateAnimalPosition,
  validateAnimalPosition,
  validateAnimalType
};

