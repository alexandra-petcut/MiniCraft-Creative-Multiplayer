const { authenticateToken } = require("./auth");
const { getWorldForUser, listBlocks, saveBlockChange } = require("./services/worldService");

const sessions = new Map();

function roomName(worldId) {
  return `world:${worldId}`;
}

function reply(ack, payload) {
  if (typeof ack === "function") {
    ack(payload);
  }
}

function publicPlayer(socketId, session) {
  return {
    socketId,
    user: session.user,
    position: session.position,
    rotation: session.rotation,
    animation: session.animation || "idle"
  };
}

function normalizeMovementAnimation(animation) {
  return animation === "run" ? "run" : "idle";
}

function leaveCurrentWorld(io, socket) {
  const session = sessions.get(socket.id);
  if (!session) return;

  socket.leave(roomName(session.worldId));
  sessions.delete(socket.id);

  socket.to(roomName(session.worldId)).emit("player:left", {
    socketId: socket.id,
    user: session.user
  });
}

function configureSockets(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = authenticateToken(token);

    if (!user) {
      return next(new Error("Unauthorized"));
    }

    socket.user = user;
    return next();
  });

  io.on("connection", (socket) => {
    socket.on("world:join", (payload, ack) => {
      try {
        const worldId = Number(payload?.worldId);
        const world = getWorldForUser(worldId, socket.user.id);

        if (!world) {
          return reply(ack, { ok: false, error: "World not found or not joined." });
        }

        leaveCurrentWorld(io, socket);

        const nextSession = {
          worldId: world.id,
          user: socket.user,
          position: payload?.position || { x: 50, y: 6, z: 50 },
          rotation: payload?.rotation || { x: 0, y: 0, z: 0 },
          animation: normalizeMovementAnimation(payload?.animation)
        };

        const players = [...sessions.entries()]
          .filter(([, session]) => session.worldId === world.id)
          .map(([socketId, session]) => publicPlayer(socketId, session));

        sessions.set(socket.id, nextSession);
        socket.join(roomName(world.id));

        socket.to(roomName(world.id)).emit("player:joined", publicPlayer(socket.id, nextSession));

        return reply(ack, {
          ok: true,
          world,
          blocks: listBlocks(world.id),
          players
        });
      } catch (error) {
        return reply(ack, { ok: false, error: error.message });
      }
    });

    socket.on("player:move", (payload) => {
      const session = sessions.get(socket.id);
      if (!session) return;

      session.position = payload?.position || session.position;
      session.rotation = payload?.rotation || session.rotation;
      session.animation = normalizeMovementAnimation(payload?.animation);

      socket.to(roomName(session.worldId)).emit("player:moved", publicPlayer(socket.id, session));
    });

    socket.on("player:action", (payload) => {
      const session = sessions.get(socket.id);
      if (!session) return;

      if (payload?.action !== "punch") return;

      socket.to(roomName(session.worldId)).emit("player:action", {
        socketId: socket.id,
        user: session.user,
        action: "punch"
      });
    });

    socket.on("block:change", (payload, ack) => {
      try {
        const session = sessions.get(socket.id);
        const worldId = Number(payload?.worldId || session?.worldId);

        if (!session || session.worldId !== worldId) {
          return reply(ack, { ok: false, error: "Join the world before editing blocks." });
        }

        const world = getWorldForUser(worldId, socket.user.id);
        if (!world) {
          return reply(ack, { ok: false, error: "World not found or not joined." });
        }

        const block = saveBlockChange(world.id, socket.user.id, payload);
        io.to(roomName(world.id)).emit("block:changed", { block });

        return reply(ack, { ok: true, block });
      } catch (error) {
        return reply(ack, { ok: false, error: error.message });
      }
    });

    socket.on("world:leave", () => {
      leaveCurrentWorld(io, socket);
    });

    socket.on("disconnect", () => {
      leaveCurrentWorld(io, socket);
    });
  });
}

module.exports = configureSockets;
