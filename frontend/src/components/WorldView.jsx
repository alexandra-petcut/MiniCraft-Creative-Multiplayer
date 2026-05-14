import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import characterModelUrl from "../../assets/Male Character 1.fbx?url";
import { API_URL } from "../api/client";
import { BLOCK_TYPES } from "../data/blockTypes";
import { BLOCK_TEXTURES } from "../data/blockTextures";

const WORLD_SIZE = 100;
const PLAYER_HEIGHT = 1.7;
const AVATAR_HEIGHT = 1.8;
const AVATAR_YAW_OFFSET = Math.PI;
const MOVEMENT_ANIMATIONS = new Set(["idle", "run"]);
const MOVE_BROADCAST_INTERVAL_MS = 50;
const REMOTE_POSITION_LERP_SPEED = 16;
const REMOTE_ROTATION_LERP_SPEED = 18;

function keyFor(x, y, z) {
  return `${x},${y},${z}`;
}

function blockKey(block) {
  return keyFor(block.x, block.y, block.z);
}

function insideWorld(x, y, z) {
  return x >= 0 && x < WORLD_SIZE && y >= 0 && y < WORLD_SIZE && z >= 0 && z < WORLD_SIZE;
}

export default function WorldView({ api, token, user, worldId, onExit }) {
  const mountRef = useRef(null);
  const socketRef = useRef(null);
  const worldGroupRef = useRef(null);
  const playersGroupRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const changedBlocksRef = useRef(new Map());
  const playerMeshesRef = useRef(new Map());
  const playerMixersRef = useRef(new Map());
  const selectedRef = useRef(BLOCK_TYPES[0].id);
  const keysRef = useRef(new Set());
  const yawRef = useRef(0);
  const pitchRef = useRef(-0.2);

  const [world, setWorld] = useState(null);
  const [selectedBlock, setSelectedBlock] = useState(BLOCK_TYPES[0].id);
  const [connectedPlayers, setConnectedPlayers] = useState([]);
  const [notice, setNotice] = useState("Click the world to lock pointer");
  const [error, setError] = useState("");

  const blockMaterials = useMemo(() => {
    const materials = new Map();
    const textureLoader = new THREE.TextureLoader();

    function loadBlockTexture(url) {
      const texture = textureLoader.load(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      return texture;
    }

    for (const block of BLOCK_TYPES) {
      const textureSet = BLOCK_TEXTURES[block.id];
      const materialOptions = {
        transparent: Boolean(block.transparent),
        opacity: block.transparent ? 0.62 : 1,
        depthWrite: !block.transparent
      };

      // BoxGeometry material order: right, left, top, bottom, front, back.
      materials.set(
        block.id,
        [
          new THREE.MeshLambertMaterial({ ...materialOptions, map: loadBlockTexture(textureSet.right) }),
          new THREE.MeshLambertMaterial({ ...materialOptions, map: loadBlockTexture(textureSet.left) }),
          new THREE.MeshLambertMaterial({ ...materialOptions, map: loadBlockTexture(textureSet.top) }),
          new THREE.MeshLambertMaterial({ ...materialOptions, map: loadBlockTexture(textureSet.bottom) }),
          new THREE.MeshLambertMaterial({ ...materialOptions, map: loadBlockTexture(textureSet.front) }),
          new THREE.MeshLambertMaterial({ ...materialOptions, map: loadBlockTexture(textureSet.back) })
        ]
      );
    }
    return materials;
  }, []);

  useEffect(() => {
    selectedRef.current = selectedBlock;
  }, [selectedBlock]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#9ed4ff");
    scene.fog = new THREE.Fog("#9ed4ff", 60, 180);

    const camera = new THREE.PerspectiveCamera(75, mount.clientWidth / mount.clientHeight, 0.1, 250);
    camera.position.set(50, 8, 50);
    camera.rotation.order = "YXZ";
    camera.rotation.x = pitchRef.current;
    camera.rotation.y = yawRef.current;
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = false;
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);

    const hemisphere = new THREE.HemisphereLight("#ffffff", "#6b765e", 2.5);
    scene.add(hemisphere);

    const sun = new THREE.DirectionalLight("#ffffff", 1.6);
    sun.position.set(40, 80, 20);
    scene.add(sun);

    const worldGroup = new THREE.Group();
    worldGroupRef.current = worldGroup;
    scene.add(worldGroup);

    const playersGroup = new THREE.Group();
    playersGroupRef.current = playersGroup;
    scene.add(playersGroup);

    let disposed = false;
    let avatarSource = null;
    let avatarLoadFailed = false;
    const pendingPlayers = new Map();

    const avatarLoader = new FBXLoader();
    avatarLoader.load(
      characterModelUrl,
      (fbx) => {
        if (disposed) return;
        avatarSource = prepareAvatarSource(fbx);
        pendingPlayers.forEach((player) => syncPlayerMeshesForPlayer(player));
        pendingPlayers.clear();
      },
      undefined,
      () => {
        if (disposed) return;
        avatarLoadFailed = true;
        pendingPlayers.forEach((player) => syncPlayerMeshesForPlayer(player));
        pendingPlayers.clear();
        setNotice("Character asset failed to load; using fallback avatars");
      }
    );

    const grid = new THREE.GridHelper(WORLD_SIZE, WORLD_SIZE, "#2f4c31", "#6fa86b");
    grid.position.set(49.5, 0.51, 49.5);
    scene.add(grid);

    rebuildWorldMeshes();

    const socket = io(API_URL, {
      auth: { token },
      transports: ["websocket", "polling"]
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit(
        "world:join",
        {
          worldId,
          position: {
            x: camera.position.x,
            y: camera.position.y,
            z: camera.position.z
          },
          rotation: {
            x: camera.rotation.x,
            y: camera.rotation.y,
            z: camera.rotation.z
          },
          animation: "idle"
        },
        (response) => {
          if (!response?.ok) {
            setError(response?.error || "Could not join world.");
            return;
          }

          setWorld(response.world);
          changedBlocksRef.current = new Map(response.blocks.map((block) => [blockKey(block), block]));
          rebuildWorldMeshes();
          setConnectedPlayers(response.players || []);
          syncPlayerMeshes(response.players || []);
          setNotice("Pointer locked: WASD move, Space up, Shift down");
        }
      );
    });

    socket.on("connect_error", (socketError) => {
      setError(socketError.message || "Socket connection failed.");
    });

    socket.on("block:changed", ({ block }) => {
      changedBlocksRef.current.set(blockKey(block), block);
      rebuildWorldMeshes();
    });

    socket.on("player:joined", (player) => {
      setConnectedPlayers((players) => upsertPlayer(players, player));
      syncPlayerMeshesForPlayer(player);
    });

    socket.on("player:moved", (player) => {
      setConnectedPlayers((players) => upsertPlayer(players, player));
      syncPlayerMeshesForPlayer(player);
    });

    socket.on("player:action", ({ socketId, action }) => {
      if (action !== "punch") return;

      const avatar = playerMeshesRef.current.get(socketId);
      if (avatar) {
        triggerAvatarPunch(avatar);
      }
    });

    socket.on("player:left", ({ socketId }) => {
      setConnectedPlayers((players) => players.filter((player) => player.socketId !== socketId));
      removePlayerMesh(socketId);
    });

    function rebuildWorldMeshes() {
      const group = worldGroupRef.current;
      if (!group) return;

      while (group.children.length) {
        const child = group.children.pop();
        child.geometry?.dispose?.();
      }

      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const instancesByType = new Map(BLOCK_TYPES.map((block) => [block.id, []]));
      const changes = changedBlocksRef.current;

      for (let x = 0; x < WORLD_SIZE; x += 1) {
        for (let z = 0; z < WORLD_SIZE; z += 1) {
          const key = keyFor(x, 0, z);
          if (!changes.has(key)) {
            instancesByType.get("grass").push({ x, y: 0, z });
          }
        }
      }

      for (const block of changes.values()) {
        if (block.blockType !== "air" && instancesByType.has(block.blockType)) {
          instancesByType.get(block.blockType).push({ x: block.x, y: block.y, z: block.z });
        }
      }

      const matrix = new THREE.Matrix4();

      for (const block of BLOCK_TYPES) {
        const coords = instancesByType.get(block.id);
        if (!coords.length) continue;

        const mesh = new THREE.InstancedMesh(geometry, blockMaterials.get(block.id), coords.length);
        mesh.userData.coords = coords;

        coords.forEach((coord, index) => {
          matrix.makeTranslation(coord.x + 0.5, coord.y + 0.5, coord.z + 0.5);
          mesh.setMatrixAt(index, matrix);
        });

        mesh.instanceMatrix.needsUpdate = true;
        group.add(mesh);
      }
    }

    function syncPlayerMeshes(players) {
      for (const socketId of playerMeshesRef.current.keys()) {
        removePlayerMesh(socketId);
      }
      players.forEach(syncPlayerMeshesForPlayer);
    }

    function syncPlayerMeshesForPlayer(player) {
      if (!playersGroupRef.current || !player.position) return;

      let avatar = playerMeshesRef.current.get(player.socketId);
      if (!avatar) {
        if (!avatarSource && !avatarLoadFailed) {
          pendingPlayers.set(player.socketId, player);
          return;
        }

        avatar = avatarSource
          ? createAnimatedAvatar(avatarSource, player.socketId, playerMixersRef.current)
          : createFallbackAvatar();
        playersGroupRef.current.add(avatar);
        playerMeshesRef.current.set(player.socketId, avatar);
      }

      const nextPosition = new THREE.Vector3(player.position.x, player.position.y - PLAYER_HEIGHT, player.position.z);
      const nextYaw = (player.rotation?.y || 0) + AVATAR_YAW_OFFSET;

      if (!avatar.userData.network) {
        avatar.userData.network = {
          targetPosition: nextPosition.clone(),
          targetYaw: nextYaw
        };
        avatar.position.copy(nextPosition);
        avatar.rotation.y = nextYaw;
      } else {
        avatar.userData.network.targetPosition.copy(nextPosition);
        avatar.userData.network.targetYaw = nextYaw;
      }

      setAvatarMovementAnimation(avatar, player.animation);
    }

    function removePlayerMesh(socketId) {
      const avatar = playerMeshesRef.current.get(socketId);
      if (!avatar) return;

      playersGroupRef.current?.remove(avatar);
      playerMixersRef.current.delete(socketId);
      if (avatar.userData.isFallbackAvatar) {
        avatar.traverse((child) => {
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        });
      }
      playerMeshesRef.current.delete(socketId);
      pendingPlayers.delete(socketId);
    }

    function onResize() {
      if (!mountRef.current || !rendererRef.current || !cameraRef.current) return;

      const width = mountRef.current.clientWidth;
      const height = mountRef.current.clientHeight;
      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(width, height);
    }

    function onKeyDown(event) {
      if (event.code === "Escape") return;
      keysRef.current.add(event.code);

      const numeric = Number(event.key);
      if (numeric >= 1 && numeric <= BLOCK_TYPES.length) {
        setSelectedBlock(BLOCK_TYPES[numeric - 1].id);
      }
    }

    function onKeyUp(event) {
      keysRef.current.delete(event.code);
    }

    function onMouseMove(event) {
      if (document.pointerLockElement !== renderer.domElement) return;

      yawRef.current -= event.movementX * 0.002;
      pitchRef.current -= event.movementY * 0.002;
      pitchRef.current = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitchRef.current));
      camera.rotation.y = yawRef.current;
      camera.rotation.x = pitchRef.current;
    }

    function onPointerDown(event) {
      if (event.target !== renderer.domElement) return;

      if (document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock();
        return;
      }

      if (event.button === 0) {
        sendPlayerAction("punch");
        editTargetBlock("air");
      }

      if (event.button === 2) {
        sendPlayerAction("punch");
        placeAdjacentBlock();
      }
    }

    function onContextMenu(event) {
      event.preventDefault();
    }

    function getTargetIntersection() {
      if (!cameraRef.current || !worldGroupRef.current) return null;

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(0, 0), cameraRef.current);
      const hits = raycaster.intersectObjects(worldGroupRef.current.children, false);
      return hits[0] || null;
    }

    function getHitCoordinate(hit) {
      const coords = hit?.object?.userData?.coords;
      if (!coords || hit.instanceId === undefined) return null;
      return coords[hit.instanceId] || null;
    }

    function editTargetBlock(blockType) {
      const hit = getTargetIntersection();
      const coord = getHitCoordinate(hit);
      if (!coord) return;

      sendBlockChange({ ...coord, blockType });
    }

    function placeAdjacentBlock() {
      const hit = getTargetIntersection();
      const coord = getHitCoordinate(hit);
      if (!coord || !hit.face) return;

      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).round();
      const next = {
        x: coord.x + normal.x,
        y: coord.y + normal.y,
        z: coord.z + normal.z,
        blockType: selectedRef.current
      };

      if (!insideWorld(next.x, next.y, next.z)) {
        setNotice("World boundary reached");
        return;
      }

      sendBlockChange(next);
    }

    function sendBlockChange(change) {
      socketRef.current?.emit("block:change", { worldId, ...change }, (response) => {
        if (!response?.ok) {
          setNotice(response?.error || "Block edit failed");
        }
      });
    }

    function sendPlayerAction(action) {
      socketRef.current?.emit("player:action", { worldId, action });
    }

    let lastTime = performance.now();
    let lastMoveBroadcast = 0;
    let frameId = 0;

    function animate(now) {
      const delta = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const speed = keysRef.current.has("ControlLeft") || keysRef.current.has("ControlRight") ? 24 : 12;
      const direction = new THREE.Vector3();
      const forward = new THREE.Vector3();
      const isRunning =
        keysRef.current.has("KeyW") ||
        keysRef.current.has("KeyA") ||
        keysRef.current.has("KeyS") ||
        keysRef.current.has("KeyD");
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();

      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

      if (keysRef.current.has("KeyW")) direction.add(forward);
      if (keysRef.current.has("KeyS")) direction.sub(forward);
      if (keysRef.current.has("KeyD")) direction.add(right);
      if (keysRef.current.has("KeyA")) direction.sub(right);
      if (keysRef.current.has("Space")) direction.y += 1;
      if (keysRef.current.has("ShiftLeft") || keysRef.current.has("ShiftRight")) direction.y -= 1;

      if (direction.lengthSq() > 0) {
        direction.normalize();
        camera.position.addScaledVector(direction, speed * delta);
        camera.position.x = THREE.MathUtils.clamp(camera.position.x, 0.5, WORLD_SIZE - 0.5);
        camera.position.y = THREE.MathUtils.clamp(camera.position.y, 1.2, WORLD_SIZE - 0.5);
        camera.position.z = THREE.MathUtils.clamp(camera.position.z, 0.5, WORLD_SIZE - 0.5);
      }

      if (now - lastMoveBroadcast > MOVE_BROADCAST_INTERVAL_MS) {
        lastMoveBroadcast = now;
        socketRef.current?.emit("player:move", {
          position: {
            x: camera.position.x,
            y: camera.position.y,
            z: camera.position.z
          },
          rotation: {
            x: camera.rotation.x,
            y: camera.rotation.y,
            z: camera.rotation.z
          },
          animation: isRunning ? "run" : "idle"
        });
      }

      playerMeshesRef.current.forEach((avatar) => interpolateRemoteAvatar(avatar, delta));
      playerMeshesRef.current.forEach((avatar) => finishAvatarPunchIfNeeded(avatar, now));
      playerMixersRef.current.forEach((mixer) => mixer.update(delta));
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    }

    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    frameId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frameId);
      disposed = true;
      socket.emit("world:leave");
      socket.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.dispose();
      blockMaterials.forEach((materialSet) => {
        materialSet.forEach((material) => {
          material.map?.dispose();
          material.dispose();
        });
      });
      [...playerMeshesRef.current.keys()].forEach(removePlayerMesh);
      mount.removeChild(renderer.domElement);
    };
  }, [api, blockMaterials, token, worldId]);

  return (
    <main className="world-shell">
      <div className="world-canvas" ref={mountRef} />
      <div className="crosshair" />

      <div className="world-topbar">
        <button className="secondary-button" onClick={onExit}>
          Exit
        </button>
        <div>
          <strong>{world?.name || "Joining world..."}</strong>
          <span>
            {user.displayName} · {notice}
          </span>
        </div>
      </div>

      <div className="players-panel">
        <strong>Online</strong>
        <span>You</span>
        {connectedPlayers.map((player) => (
          <span key={player.socketId}>{player.user.displayName}</span>
        ))}
      </div>

      <div className="hotbar">
        {BLOCK_TYPES.map((block, index) => (
          <button
            key={block.id}
            className={selectedBlock === block.id ? "hotbar-item active" : "hotbar-item"}
            onClick={() => setSelectedBlock(block.id)}
            title={`${index + 1}: ${block.label}`}
          >
            <span style={{ backgroundImage: `url("${BLOCK_TEXTURES[block.id].front}")` }} />
            <small>{index + 1}</small>
          </button>
        ))}
      </div>

      {error && <div className="world-error">{error}</div>}
    </main>
  );
}

function upsertPlayer(players, nextPlayer) {
  const without = players.filter((player) => player.socketId !== nextPlayer.socketId);
  return [...without, nextPlayer];
}

function prepareAvatarSource(fbx) {
  const source = fbx;

  source.traverse((child) => {
    if (child.isMesh) {
      child.frustumCulled = false;
    }
  });

  source.updateMatrixWorld(true);
  const originalBox = new THREE.Box3().setFromObject(source);
  const originalSize = new THREE.Vector3();
  originalBox.getSize(originalSize);
  const scale = AVATAR_HEIGHT / Math.max(originalSize.y, 1);
  source.scale.multiplyScalar(scale);

  source.updateMatrixWorld(true);
  const scaledBox = new THREE.Box3().setFromObject(source);
  const center = new THREE.Vector3();
  scaledBox.getCenter(center);
  source.position.x -= center.x;
  source.position.z -= center.z;
  source.position.y -= scaledBox.min.y;
  source.updateMatrixWorld(true);

  return source;
}

function createAnimatedAvatar(source, socketId, mixerRegistry) {
  const avatar = cloneSkeleton(source);
  avatar.name = `player-${socketId}`;

  if (source.animations?.length) {
    const mixer = new THREE.AnimationMixer(avatar);
    const idleClip = findAnimationClip(source, "Idle") || source.animations[0];
    const runClip = findAnimationClip(source, "Run") || findAnimationClip(source, "Walk") || idleClip;
    const punchClip = findAnimationClip(source, "Punch") || idleClip;
    const actions = {
      idle: createAvatarAction(mixer, idleClip, "loop"),
      run: createAvatarAction(mixer, runClip, "loop"),
      punch: createAvatarAction(mixer, punchClip, "once")
    };

    avatar.userData.animation = {
      actions,
      activeAction: null,
      activeName: null,
      movement: "idle",
      punchUntil: 0
    };

    setAvatarMovementAnimation(avatar, "idle", 0);
    mixerRegistry.set(socketId, mixer);
  }

  return avatar;
}

function findAnimationClip(source, clipName) {
  const targetName = clipName.toLowerCase();
  return source.animations.find((clip) => getShortAnimationName(clip.name).toLowerCase() === targetName);
}

function getShortAnimationName(name) {
  return String(name || "").split("|").pop();
}

function createAvatarAction(mixer, clip, mode) {
  const action = mixer.clipAction(clip);

  if (mode === "once") {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
  } else {
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
  }

  return action;
}

function setAvatarMovementAnimation(avatar, animation, fadeSeconds = 0.15) {
  const controller = avatar.userData.animation;
  if (!controller) return;

  const movement = MOVEMENT_ANIMATIONS.has(animation) ? animation : "idle";
  controller.movement = movement;

  if (controller.punchUntil > performance.now()) {
    return;
  }

  playAvatarAction(avatar, movement, fadeSeconds);
}

function triggerAvatarPunch(avatar) {
  const controller = avatar.userData.animation;
  if (!controller?.actions.punch) return;

  const punchDurationMs = controller.actions.punch.getClip().duration * 1000;
  controller.punchUntil = performance.now() + punchDurationMs;
  playAvatarAction(avatar, "punch", 0.06, true);
}

function finishAvatarPunchIfNeeded(avatar, now) {
  const controller = avatar.userData.animation;
  if (!controller?.punchUntil || now < controller.punchUntil) return;

  controller.punchUntil = 0;
  setAvatarMovementAnimation(avatar, controller.movement);
}

function interpolateRemoteAvatar(avatar, delta) {
  const network = avatar.userData.network;
  if (!network) return;

  const positionAlpha = 1 - Math.exp(-REMOTE_POSITION_LERP_SPEED * delta);
  const rotationAlpha = 1 - Math.exp(-REMOTE_ROTATION_LERP_SPEED * delta);

  avatar.position.lerp(network.targetPosition, positionAlpha);
  avatar.rotation.y = lerpAngle(avatar.rotation.y, network.targetYaw, rotationAlpha);
}

function lerpAngle(current, target, alpha) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * alpha;
}

function playAvatarAction(avatar, actionName, fadeSeconds = 0.15, reset = false) {
  const controller = avatar.userData.animation;
  const nextAction = controller?.actions[actionName];

  if (!nextAction || controller.activeAction === nextAction) {
    if (reset && nextAction) {
      nextAction.reset().play();
    }
    return;
  }

  if (controller.activeAction) {
    controller.activeAction.fadeOut(fadeSeconds);
  }

  nextAction.enabled = true;
  if (reset) {
    nextAction.reset();
  }
  nextAction.fadeIn(fadeSeconds).play();
  controller.activeAction = nextAction;
  controller.activeName = actionName;
}

function createFallbackAvatar() {
  const avatar = new THREE.Group();
  avatar.userData.isFallbackAvatar = true;
  const material = new THREE.MeshLambertMaterial({ color: "#f0c16a" });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.28), material);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), material);

  body.position.y = 0.75;
  head.position.y = 1.45;
  avatar.add(body, head);

  return avatar;
}
