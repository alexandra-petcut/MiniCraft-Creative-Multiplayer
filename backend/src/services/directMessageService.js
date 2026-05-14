const { db } = require("../db");

const DIRECT_MESSAGE_MAX_LENGTH = 200;
const DIRECT_MESSAGE_HISTORY_LIMIT = 100;

function isFriend(userId, friendId) {
  return Boolean(
    db.prepare("SELECT id FROM friends WHERE userId = ? AND friendId = ?").get(userId, friendId)
  );
}

function getUser(userId) {
  return db.prepare("SELECT id, username, displayName FROM users WHERE id = ?").get(userId);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    senderId: message.senderId,
    receiverId: message.receiverId,
    text: message.text,
    createdAt: message.createdAt,
    sender: {
      id: message.senderId,
      username: message.senderUsername,
      displayName: message.senderDisplayName
    },
    receiver: {
      id: message.receiverId,
      username: message.receiverUsername,
      displayName: message.receiverDisplayName
    }
  };
}

function getPendingFriendRequestBetween(userId, otherUserId) {
  return db
    .prepare(
      `
        SELECT id, requesterId, receiverId, createdAt
        FROM friend_requests
        WHERE
          (requesterId = ? AND receiverId = ?)
          OR
          (requesterId = ? AND receiverId = ?)
        LIMIT 1
      `
    )
    .get(userId, otherUserId, otherUserId, userId);
}

function publicRelationship(access) {
  return {
    kind: access.kind,
    canSend: access.canSend,
    request: access.request || null
  };
}

function getChatAccess(userId, friendId) {
  const friend = getUser(friendId);
  if (!friend) {
    const error = new Error("User not found.");
    error.status = 404;
    throw error;
  }

  if (isFriend(userId, friendId)) {
    return {
      kind: "friend",
      canSend: true,
      friend
    };
  }

  const request = getPendingFriendRequestBetween(userId, friendId);
  if (request) {
    const outgoing = request.requesterId === userId;
    return {
      kind: outgoing ? "outgoing_request" : "incoming_request",
      canSend: outgoing,
      friend,
      request
    };
  }

  const error = new Error("Send a friend request before messaging this user.");
  error.status = 403;
  throw error;
}

function requireFriend(userId, friendId) {
  const access = getChatAccess(userId, friendId);
  if (access.kind !== "friend") {
    const error = new Error("You can only use this action with friends.");
    error.status = 403;
    throw error;
  }

  return access.friend;
}

function listDirectMessages(userId, friendId) {
  const access = getChatAccess(userId, friendId);

  const messages = db
    .prepare(
      `
        SELECT
          dm.*,
          sender.username AS senderUsername,
          sender.displayName AS senderDisplayName,
          receiver.username AS receiverUsername,
          receiver.displayName AS receiverDisplayName
        FROM direct_messages dm
        JOIN users sender ON sender.id = dm.senderId
        JOIN users receiver ON receiver.id = dm.receiverId
        WHERE
          (dm.senderId = ? AND dm.receiverId = ?)
          OR
          (dm.senderId = ? AND dm.receiverId = ?)
        ORDER BY dm.createdAt DESC, dm.id DESC
        LIMIT ?
      `
    )
    .all(userId, friendId, friendId, userId, DIRECT_MESSAGE_HISTORY_LIMIT)
    .reverse()
    .map(publicMessage);

  return {
    relationship: publicRelationship(access),
    messages
  };
}

function getLatestDirectMessage(userId, friendId) {
  const message = db
    .prepare(
      `
        SELECT
          dm.*,
          sender.username AS senderUsername,
          sender.displayName AS senderDisplayName,
          receiver.username AS receiverUsername,
          receiver.displayName AS receiverDisplayName
        FROM direct_messages dm
        JOIN users sender ON sender.id = dm.senderId
        JOIN users receiver ON receiver.id = dm.receiverId
        WHERE
          (dm.senderId = ? AND dm.receiverId = ?)
          OR
          (dm.senderId = ? AND dm.receiverId = ?)
        ORDER BY dm.createdAt DESC, dm.id DESC
        LIMIT 1
      `
    )
    .get(userId, friendId, friendId, userId);

  return message ? publicMessage(message) : null;
}

function listDirectMessageConversations(userId) {
  const friends = db
    .prepare(
      `
        SELECT u.id, u.username, u.displayName
        FROM friends f
        JOIN users u ON u.id = f.friendId
        WHERE f.userId = ?
        ORDER BY u.username ASC
      `
    )
    .all(userId);

  return friends
    .map((friend) => ({
      friend,
      latestMessage: getLatestDirectMessage(userId, friend.id)
    }))
    .sort((left, right) => {
      const leftTime = left.latestMessage ? Date.parse(left.latestMessage.createdAt) : 0;
      const rightTime = right.latestMessage ? Date.parse(right.latestMessage.createdAt) : 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return left.friend.username.localeCompare(right.friend.username);
    });
}

function listDirectMessageRequestConversations(userId) {
  const requests = db
    .prepare(
      `
        SELECT
          fr.id,
          fr.requesterId,
          fr.receiverId,
          fr.createdAt,
          requester.username AS requesterUsername,
          requester.displayName AS requesterDisplayName,
          receiver.username AS receiverUsername,
          receiver.displayName AS receiverDisplayName
        FROM friend_requests fr
        JOIN users requester ON requester.id = fr.requesterId
        JOIN users receiver ON receiver.id = fr.receiverId
        WHERE fr.requesterId = ? OR fr.receiverId = ?
      `
    )
    .all(userId, userId);

  return requests
    .map((request) => {
      const outgoing = request.requesterId === userId;
      const otherUser = outgoing
        ? {
            id: request.receiverId,
            username: request.receiverUsername,
            displayName: request.receiverDisplayName
          }
        : {
            id: request.requesterId,
            username: request.requesterUsername,
            displayName: request.requesterDisplayName
          };

      return {
        request: {
          id: request.id,
          requesterId: request.requesterId,
          receiverId: request.receiverId,
          createdAt: request.createdAt
        },
        user: publicUser(otherUser),
        direction: outgoing ? "outgoing" : "incoming",
        canSend: outgoing,
        latestMessage: getLatestDirectMessage(userId, otherUser.id)
      };
    })
    .sort((left, right) => {
      const leftTime = left.latestMessage ? Date.parse(left.latestMessage.createdAt) : Date.parse(left.request.createdAt);
      const rightTime = right.latestMessage
        ? Date.parse(right.latestMessage.createdAt)
        : Date.parse(right.request.createdAt);
      if (leftTime !== rightTime) return rightTime - leftTime;
      return left.user.username.localeCompare(right.user.username);
    });
}

function createDirectMessage(senderId, receiverId, input) {
  const access = getChatAccess(senderId, receiverId);
  if (!access.canSend) {
    const error = new Error("Accept the friend request before replying.");
    error.status = 403;
    throw error;
  }

  const text = String(input?.text || "").trim().slice(0, DIRECT_MESSAGE_MAX_LENGTH);
  if (!text) {
    const error = new Error("Message cannot be empty.");
    error.status = 400;
    throw error;
  }

  const result = db
    .prepare("INSERT INTO direct_messages (senderId, receiverId, text) VALUES (?, ?, ?)")
    .run(senderId, receiverId, text);

  const message = db
    .prepare(
      `
        SELECT
          dm.*,
          sender.username AS senderUsername,
          sender.displayName AS senderDisplayName,
          receiver.username AS receiverUsername,
          receiver.displayName AS receiverDisplayName
        FROM direct_messages dm
        JOIN users sender ON sender.id = dm.senderId
        JOIN users receiver ON receiver.id = dm.receiverId
        WHERE dm.id = ?
      `
    )
    .get(result.lastInsertRowid);

  return publicMessage(message);
}

module.exports = {
  DIRECT_MESSAGE_MAX_LENGTH,
  createDirectMessage,
  listDirectMessageConversations,
  listDirectMessageRequestConversations,
  listDirectMessages,
  requireFriend
};
