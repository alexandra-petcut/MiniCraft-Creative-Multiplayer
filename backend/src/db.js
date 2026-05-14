const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const defaultDataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(defaultDataDir, { recursive: true });

const configuredPath = process.env.DATABASE_PATH || path.join(defaultDataDir, "minicraft.sqlite");
const databasePath = path.isAbsolute(configuredPath)
  ? configuredPath
  : path.join(__dirname, "..", configuredPath);

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passwordHash TEXT NOT NULL,
    displayName TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    friendId INTEGER NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(userId, friendId),
    CHECK(userId <> friendId),
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(friendId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS worlds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ownerId INTEGER NOT NULL,
    inviteCode TEXT NOT NULL UNIQUE,
    sizeX INTEGER NOT NULL DEFAULT 100,
    sizeY INTEGER NOT NULL DEFAULT 100,
    sizeZ INTEGER NOT NULL DEFAULT 100,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(ownerId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS world_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worldId INTEGER NOT NULL,
    userId INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joinedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(worldId, userId),
    FOREIGN KEY(worldId) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS world_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worldId INTEGER NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    z INTEGER NOT NULL,
    blockType TEXT NOT NULL,
    placedByUserId INTEGER NOT NULL,
    updatedByUserId INTEGER NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(worldId, x, y, z),
    FOREIGN KEY(worldId) REFERENCES worlds(id) ON DELETE CASCADE,
    FOREIGN KEY(placedByUserId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(updatedByUserId) REFERENCES users(id) ON DELETE CASCADE
  );
`);

function transaction(callback) {
  db.exec("BEGIN IMMEDIATE;");

  try {
    const result = callback();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

module.exports = { db, databasePath, transaction };
