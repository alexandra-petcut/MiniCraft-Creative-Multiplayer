const { authenticateToken } = require("./auth");
const {
  createAnimal,
  deleteAnimal,
  getAnimal,
  listAnimals,
  updateAnimalPosition
} = require("./services/animalService");
const { createDirectMessage } = require("./services/directMessageService");
const { getWorldForUser, listBlocks, saveBlockChange } = require("./services/worldService");

const sessions = new Map();
const animalRuntimes = new Map();
const ANIMAL_TICK_MS = 100;
const ANIMAL_SPEED = 1.4;
const ANIMAL_BROADCAST_MS = 120;
const ANIMAL_PERSIST_MS = 1000;
const CHAT_MESSAGE_MAX_LENGTH = 200;
let nextChatMessageId = 1;

function roomName(worldId) {
  return `world:${worldId}`;
}

function userRoomName(userId) {
  return `user:${userId}`;
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

function createChatMessage(worldId, user, text) {
  return {
    id: nextChatMessageId++,
    worldId,
    user,
    text,
    sentAt: new Date().toISOString()
  };
}

function publicAnimal(animal) {
  return {
    id: animal.id,
    worldId: animal.worldId,
    animalType: animal.animalType,
    position: {
      x: animal.x,
      y: animal.y,
      z: animal.z
    },
    yaw: animal.yaw || 0,
    animation: animal.animation || "idle"
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function ensureAnimalRuntime(animal) {
  const existing = animalRuntimes.get(animal.id);
  if (existing) return existing;

  const runtime = {
    id: animal.id,
    worldId: animal.worldId,
    animalType: animal.animalType,
    x: animal.x,
    y: animal.y,
    z: animal.z,
    yaw: animal.yaw || 0,
    targetX: animal.x,
    targetZ: animal.z,
    animation: "idle",
    nextDecisionAt: Date.now() + randomBetween(600, 1800),
    lastBroadcastAt: 0,
    lastPersistAt: 0
  };

  animalRuntimes.set(animal.id, runtime);
  return runtime;
}

function chooseAnimalMove(runtime, now) {
  if (Math.random() < 0.35) {
    runtime.targetX = runtime.x;
    runtime.targetZ = runtime.z;
    runtime.animation = "idle";
    runtime.nextDecisionAt = now + randomBetween(800, 2600);
    return;
  }

  const directions = [
    { x: 1, z: 0, yaw: Math.PI / 2 },
    { x: -1, z: 0, yaw: -Math.PI / 2 },
    { x: 0, z: 1, yaw: 0 },
    { x: 0, z: -1, yaw: Math.PI }
  ];
  const direction = directions[Math.floor(Math.random() * directions.length)];
  const distance = randomBetween(1.5, 5.5);

  runtime.targetX = clamp(runtime.x + direction.x * distance, 1, 98);
  runtime.targetZ = clamp(runtime.z + direction.z * distance, 1, 98);
  runtime.yaw = direction.yaw;
  runtime.animation = "walk";
  runtime.nextDecisionAt = now + randomBetween(1200, 3200);
}

function updateAnimalRuntime(runtime, deltaSeconds, now) {
  const dx = runtime.targetX - runtime.x;
  const dz = runtime.targetZ - runtime.z;
  const distance = Math.hypot(dx, dz);

  if (distance < 0.04) {
    runtime.x = runtime.targetX;
    runtime.z = runtime.targetZ;
    runtime.animation = "idle";

    if (now >= runtime.nextDecisionAt) {
      chooseAnimalMove(runtime, now);
    }

    return;
  }

  const step = Math.min(distance, ANIMAL_SPEED * deltaSeconds);
  runtime.x += (dx / distance) * step;
  runtime.z += (dz / distance) * step;
  runtime.animation = "walk";
}

function roomHasListeners(io, worldId) {
  return Boolean(io.sockets.adapter.rooms.get(roomName(worldId))?.size);
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
  let lastAnimalTick = Date.now();
  const animalInterval = setInterval(() => {
    const now = Date.now();
    const deltaSeconds = Math.min((now - lastAnimalTick) / 1000, 0.25);
    lastAnimalTick = now;

    for (const runtime of animalRuntimes.values()) {
      if (!roomHasListeners(io, runtime.worldId)) continue;

      updateAnimalRuntime(runtime, deltaSeconds, now);

      if (now - runtime.lastBroadcastAt >= ANIMAL_BROADCAST_MS) {
        runtime.lastBroadcastAt = now;
        io.to(roomName(runtime.worldId)).emit("animal:moved", { animal: publicAnimal(runtime) });
      }

      if (now - runtime.lastPersistAt >= ANIMAL_PERSIST_MS) {
        runtime.lastPersistAt = now;
        updateAnimalPosition(runtime.id, runtime);
      }
    }
  }, ANIMAL_TICK_MS);
  animalInterval.unref?.();

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
    socket.join(userRoomName(socket.user.id));

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
          animals: listAnimals(world.id).map((animal) => publicAnimal(ensureAnimalRuntime(animal))),
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

    socket.on("chat:send", (payload, ack) => {
      const session = sessions.get(socket.id);
      if (!session) {
        return reply(ack, { ok: false, error: "Join a world before sending chat messages." });
      }

      const text = String(payload?.text || "").trim().slice(0, CHAT_MESSAGE_MAX_LENGTH);
      if (!text) {
        return reply(ack, { ok: false, error: "Message cannot be empty." });
      }

      const message = createChatMessage(session.worldId, socket.user, text);
      io.to(roomName(session.worldId)).emit("chat:message", { message });

      return reply(ack, { ok: true, message });
    });

    socket.on("dm:send", (payload, ack) => {
      try {
        const receiverId = Number(payload?.receiverId);
        const message = createDirectMessage(socket.user.id, receiverId, payload);

        io.to(userRoomName(socket.user.id)).to(userRoomName(receiverId)).emit("dm:message", { message });

        return reply(ack, { ok: true, message });
      } catch (error) {
        return reply(ack, { ok: false, error: error.message });
      }
    });

    socket.on("animal:spawn", (payload, ack) => {
      try {
        const session = sessions.get(socket.id);
        const worldId = Number(payload?.worldId || session?.worldId);

        if (!session || session.worldId !== worldId) {
          return reply(ack, { ok: false, error: "Join the world before spawning animals." });
        }

        const world = getWorldForUser(worldId, socket.user.id);
        if (!world) {
          return reply(ack, { ok: false, error: "World not found or not joined." });
        }

        const animal = createAnimal(world.id, socket.user.id, payload);
        const runtime = ensureAnimalRuntime(animal);
        io.to(roomName(world.id)).emit("animal:spawned", { animal: publicAnimal(runtime) });

        return reply(ack, { ok: true, animal: publicAnimal(runtime) });
      } catch (error) {
        return reply(ack, { ok: false, error: error.message });
      }
    });

    socket.on("animal:action", (payload, ack) => {
      try {
        const session = sessions.get(socket.id);
        const worldId = Number(payload?.worldId || session?.worldId);
        const animalId = Number(payload?.animalId);
        const action = payload?.action;

        if (!session || session.worldId !== worldId) {
          return reply(ack, { ok: false, error: "Join the world before interacting with animals." });
        }

        const world = getWorldForUser(worldId, socket.user.id);
        if (!world) {
          return reply(ack, { ok: false, error: "World not found or not joined." });
        }

        const animal = getAnimal(world.id, animalId);
        if (!animal) {
          return reply(ack, { ok: false, error: "Animal not found." });
        }

        if (action === "happy") {
          io.to(roomName(world.id)).emit("animal:action", { animalId, action: "happy" });
          return reply(ack, { ok: true });
        }

        if (action === "die") {
          deleteAnimal(world.id, animalId);
          animalRuntimes.delete(animalId);
          io.to(roomName(world.id)).emit("animal:action", { animalId, action: "die" });
          return reply(ack, { ok: true });
        }

        return reply(ack, { ok: false, error: "Unsupported animal action." });
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
