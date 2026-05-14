const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "dev-minicraft-secret";
const TOKEN_TTL = "7d";

function toPublicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt
  };
}

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function findUserById(id) {
  return db.prepare("SELECT id, username, displayName, createdAt FROM users WHERE id = ?").get(id);
}

function authenticateToken(token) {
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return findUserById(payload.id);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const user = authenticateToken(token);

  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.user = user;
  return next();
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = {
  authenticateToken,
  createToken,
  hashPassword,
  requireAuth,
  toPublicUser,
  verifyPassword
};

