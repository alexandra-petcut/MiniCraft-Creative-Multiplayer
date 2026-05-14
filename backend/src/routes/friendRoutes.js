const express = require("express");
const { db, transaction } = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();

router.use(requireAuth);

function isFriend(userId, friendId) {
  return Boolean(
    db.prepare("SELECT id FROM friends WHERE userId = ? AND friendId = ?").get(userId, friendId)
  );
}

function getUserById(userId) {
  return db.prepare("SELECT id, username, displayName, createdAt FROM users WHERE id = ?").get(userId);
}

function getUserFromInput(input) {
  const username = String(input.username || "").trim();
  const friendId = input.friendId ? Number(input.friendId) : null;

  if (username) {
    return db
      .prepare("SELECT id, username, displayName, createdAt FROM users WHERE username = ?")
      .get(username);
  }

  return db
    .prepare("SELECT id, username, displayName, createdAt FROM users WHERE id = ?")
    .get(friendId);
}

function getPendingRequest(requesterId, receiverId) {
  return db
    .prepare("SELECT id, requesterId, receiverId, createdAt FROM friend_requests WHERE requesterId = ? AND receiverId = ?")
    .get(requesterId, receiverId);
}

function getRequestById(requestId) {
  return db
    .prepare("SELECT id, requesterId, receiverId, createdAt FROM friend_requests WHERE id = ?")
    .get(requestId);
}

function createFriendship(userId, friendId) {
  db.prepare("INSERT OR IGNORE INTO friends (userId, friendId) VALUES (?, ?)").run(userId, friendId);
  db.prepare("INSERT OR IGNORE INTO friends (userId, friendId) VALUES (?, ?)").run(friendId, userId);
  db.prepare(
    `
      DELETE FROM friend_requests
      WHERE
        (requesterId = ? AND receiverId = ?)
        OR
        (requesterId = ? AND receiverId = ?)
    `
  ).run(userId, friendId, friendId, userId);
}

function notifyFriendUsers(req, userIds) {
  const io = req.app.get("io");
  if (!io) return;

  for (const userId of new Set(userIds.map((id) => Number(id)).filter(Boolean))) {
    io.to(`user:${userId}`).emit("friends:updated");
  }
}

function publicRequest(request, user, direction) {
  return {
    id: request.id,
    requesterId: request.requesterId,
    receiverId: request.receiverId,
    createdAt: request.createdAt,
    direction,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName
    }
  };
}

function listIncomingRequests(userId) {
  return db
    .prepare(
      `
        SELECT
          fr.id,
          fr.requesterId,
          fr.receiverId,
          fr.createdAt,
          u.id AS userId,
          u.username,
          u.displayName
        FROM friend_requests fr
        JOIN users u ON u.id = fr.requesterId
        WHERE fr.receiverId = ?
        ORDER BY fr.createdAt DESC, fr.id DESC
      `
    )
    .all(userId)
    .map((row) =>
      publicRequest(
        row,
        { id: row.userId, username: row.username, displayName: row.displayName },
        "incoming"
      )
    );
}

function listOutgoingRequests(userId) {
  return db
    .prepare(
      `
        SELECT
          fr.id,
          fr.requesterId,
          fr.receiverId,
          fr.createdAt,
          u.id AS userId,
          u.username,
          u.displayName
        FROM friend_requests fr
        JOIN users u ON u.id = fr.receiverId
        WHERE fr.requesterId = ?
        ORDER BY fr.createdAt DESC, fr.id DESC
      `
    )
    .all(userId)
    .map((row) =>
      publicRequest(
        row,
        { id: row.userId, username: row.username, displayName: row.displayName },
        "outgoing"
      )
    );
}

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

  res.json({
    friends,
    incomingRequests: listIncomingRequests(req.user.id),
    outgoingRequests: listOutgoingRequests(req.user.id)
  });
});

router.post("/", (req, res) => {
  const friend = getUserFromInput(req.body);

  if (!friend) {
    return res.status(404).json({ error: "User not found." });
  }

  if (friend.id === req.user.id) {
    return res.status(400).json({ error: "You cannot add yourself as a friend." });
  }

  if (isFriend(req.user.id, friend.id)) {
    return res.status(200).json({ friend, alreadyFriends: true });
  }

  const reverseRequest = getPendingRequest(friend.id, req.user.id);
  if (reverseRequest) {
    transaction(() => createFriendship(req.user.id, friend.id));
    notifyFriendUsers(req, [req.user.id, friend.id]);
    return res.status(200).json({ friend, accepted: true });
  }

  const existingRequest = getPendingRequest(req.user.id, friend.id);
  if (existingRequest) {
    return res.status(200).json({
      request: publicRequest(existingRequest, friend, "outgoing"),
      alreadyRequested: true
    });
  }

  const request = transaction(() => {
    const result = db
      .prepare("INSERT INTO friend_requests (requesterId, receiverId) VALUES (?, ?)")
      .run(req.user.id, friend.id);
    return getRequestById(result.lastInsertRowid);
  });

  notifyFriendUsers(req, [req.user.id, friend.id]);
  res.status(201).json({ request: publicRequest(request, friend, "outgoing") });
});

router.patch("/requests/:requestId/accept", (req, res) => {
  const request = getRequestById(Number(req.params.requestId));

  if (!request) {
    return res.status(404).json({ error: "Friend request not found." });
  }

  if (request.receiverId !== req.user.id) {
    return res.status(403).json({ error: "Only the receiver can accept this request." });
  }

  const friend = getUserById(request.requesterId);
  transaction(() => createFriendship(req.user.id, request.requesterId));

  notifyFriendUsers(req, [req.user.id, request.requesterId]);
  res.json({ friend });
});

router.delete("/requests/:requestId", (req, res) => {
  const request = getRequestById(Number(req.params.requestId));

  if (!request) {
    return res.status(404).json({ error: "Friend request not found." });
  }

  if (request.receiverId !== req.user.id && request.requesterId !== req.user.id) {
    return res.status(403).json({ error: "You cannot change this request." });
  }

  db.prepare("DELETE FROM friend_requests WHERE id = ?").run(request.id);
  notifyFriendUsers(req, [request.receiverId, request.requesterId]);
  res.status(204).send();
});

router.delete("/:friendId", (req, res) => {
  const friendId = Number(req.params.friendId);

  transaction(() => {
    db.prepare("DELETE FROM friends WHERE userId = ? AND friendId = ?").run(req.user.id, friendId);
    db.prepare("DELETE FROM friends WHERE userId = ? AND friendId = ?").run(friendId, req.user.id);
  });

  notifyFriendUsers(req, [req.user.id, friendId]);
  res.status(204).send();
});

module.exports = router;
