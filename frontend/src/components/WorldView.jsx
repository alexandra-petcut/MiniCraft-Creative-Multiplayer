import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import characterModelUrl from "../../assets/Male Character 1.fbx?url";
import { API_URL } from "../api/client";
import { ANIMAL_TYPE_MAP, SPAWN_EGG_BLOCK_MAP } from "../data/animalTypes";
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
const HOTBAR_SLOT_COUNT = 9;
const MIN_NON_CHICKEN_DEATH_VISIBLE_MS = 900;
const BLOCK_LOOKUP = new Map(BLOCK_TYPES.map((block) => [block.id, block]));

function createDefaultHotbarSlots() {
  return Array.from({ length: HOTBAR_SLOT_COUNT }, (_, index) => BLOCK_TYPES[index]?.id || null);
}

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
  const animalsGroupRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const changedBlocksRef = useRef(new Map());
  const playerMeshesRef = useRef(new Map());
  const playerMixersRef = useRef(new Map());
  const animalMeshesRef = useRef(new Map());
  const animalMixersRef = useRef(new Map());
  const selectedRef = useRef(BLOCK_TYPES[0].id);
  const hotbarSlotsRef = useRef(createDefaultHotbarSlots());
  const selectedSlotRef = useRef(0);
  const inventoryOpenRef = useRef(false);
  const keysRef = useRef(new Set());
  const yawRef = useRef(0);
  const pitchRef = useRef(-0.2);

  const [world, setWorld] = useState(null);
  const [hotbarSlots, setHotbarSlots] = useState(createDefaultHotbarSlots);
  const [selectedSlot, setSelectedSlot] = useState(0);
  const [selectedBlock, setSelectedBlock] = useState(BLOCK_TYPES[0].id);
  const [inventoryOpen, setInventoryOpen] = useState(false);
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
    hotbarSlotsRef.current = hotbarSlots;
    selectedSlotRef.current = selectedSlot;

    const nextBlock = hotbarSlots[selectedSlot] || hotbarSlots.find(Boolean) || BLOCK_TYPES[0].id;
    setSelectedBlock(nextBlock);
    selectedRef.current = nextBlock;
  }, [hotbarSlots, selectedSlot]);

  useEffect(() => {
    inventoryOpenRef.current = inventoryOpen;
  }, [inventoryOpen]);

  function openInventory() {
    keysRef.current.clear();
    document.exitPointerLock?.();
    setInventoryOpen(true);
  }

  function closeInventory() {
    setInventoryOpen(false);
  }

  function toggleInventory() {
    if (inventoryOpenRef.current) {
      closeInventory();
      return;
    }

    openInventory();
  }

  function handleBlockDragStart(event, blockId) {
    event.dataTransfer.setData("application/x-minicraft-block", blockId);
    event.dataTransfer.effectAllowed = "copy";
  }

  function handleHotbarDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleHotbarDrop(event, slotIndex) {
    event.preventDefault();

    const blockId = event.dataTransfer.getData("application/x-minicraft-block");
    if (!BLOCK_LOOKUP.has(blockId)) return;

    setHotbarSlots((slots) => {
      const nextSlots = [...slots];
      nextSlots[slotIndex] = blockId;
      return nextSlots;
    });
    setSelectedSlot(slotIndex);
    setSelectedBlock(blockId);
    selectedRef.current = blockId;
  }

  function selectHotbarSlot(slotIndex) {
    setSelectedSlot(slotIndex);

    const blockId = hotbarSlots[slotIndex];
    if (blockId) {
      setSelectedBlock(blockId);
      selectedRef.current = blockId;
    }
  }

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

    const animalsGroup = new THREE.Group();
    animalsGroupRef.current = animalsGroup;
    scene.add(animalsGroup);

    let disposed = false;
    let avatarSource = null;
    let avatarLoadFailed = false;
    const pendingPlayers = new Map();
    const animalSources = new Map();
    const failedAnimalSources = new Set();
    const pendingAnimals = new Map();

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

    ANIMAL_TYPE_MAP.forEach((animalConfig) => {
      const animalLoader = new FBXLoader();
      animalLoader.load(
        animalConfig.modelUrl,
        (fbx) => {
          if (disposed) return;
          animalSources.set(animalConfig.id, prepareAnimalSource(fbx, animalConfig));
          pendingAnimals.forEach((animal) => syncAnimalMesh(animal));
        },
        undefined,
        () => {
          if (disposed) return;
          failedAnimalSources.add(animalConfig.id);
          pendingAnimals.forEach((animal) => syncAnimalMesh(animal));
          setNotice("An animal asset failed to load; using fallback animals");
        }
      );
    });

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
          syncAnimalMeshes(response.animals || []);
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

    socket.on("animal:spawned", ({ animal }) => {
      syncAnimalMesh(animal);
    });

    socket.on("animal:moved", ({ animal }) => {
      syncAnimalMesh(animal);
    });

    socket.on("animal:action", ({ animalId, action }) => {
      const animal = animalMeshesRef.current.get(animalId);
      if (!animal) return;

      if (action === "happy") {
        triggerAnimalAction(animal, "happy");
      }

      if (action === "die") {
        triggerAnimalAction(animal, "die");
      }
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

    function syncAnimalMeshes(animals) {
      for (const animalId of animalMeshesRef.current.keys()) {
        if (!animals.some((animal) => animal.id === animalId)) {
          removeAnimalMesh(animalId);
        }
      }

      animals.forEach(syncAnimalMesh);
    }

    function syncAnimalMesh(animal) {
      if (!animalsGroupRef.current || !animal?.position) return;

      let animalMesh = animalMeshesRef.current.get(animal.id);
      if (!animalMesh) {
        const source = animalSources.get(animal.animalType);

        if (!source && !failedAnimalSources.has(animal.animalType)) {
          pendingAnimals.set(animal.id, animal);
          return;
        }

        animalMesh = source
          ? createAnimatedAnimal(source, animal, animalMixersRef.current)
          : createFallbackAnimal(animal.animalType);
        animalMesh.userData.animalId = animal.id;
        animalMesh.traverse((child) => {
          child.userData.animalId = animal.id;
        });
        animalsGroupRef.current.add(animalMesh);
        animalMeshesRef.current.set(animal.id, animalMesh);
        pendingAnimals.delete(animal.id);
      }

      const nextPosition = new THREE.Vector3(animal.position.x, animal.position.y, animal.position.z);
      const nextYaw = animal.yaw || 0;

      if (!animalMesh.userData.network) {
        animalMesh.userData.network = {
          targetPosition: nextPosition.clone(),
          targetYaw: nextYaw
        };
        animalMesh.position.copy(nextPosition);
        animalMesh.rotation.y = nextYaw;
      } else {
        animalMesh.userData.network.targetPosition.copy(nextPosition);
        animalMesh.userData.network.targetYaw = nextYaw;
      }

      setAnimalMovementAnimation(animalMesh, animal.animation);
    }

    function removeAnimalMesh(animalId) {
      const animal = animalMeshesRef.current.get(animalId);
      if (!animal) return;

      animalsGroupRef.current?.remove(animal);
      animalMixersRef.current.delete(animalId);
      if (animal.userData.isFallbackAnimal) {
        animal.traverse((child) => {
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        });
      }
      animalMeshesRef.current.delete(animalId);
      pendingAnimals.delete(animalId);
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
      if (event.code === "KeyI") {
        event.preventDefault();
        toggleInventory();
        return;
      }

      if (inventoryOpenRef.current) {
        if (event.code === "Escape" || event.code === "Tab") {
          event.preventDefault();
          closeInventory();
        }
        return;
      }

      if (event.code === "Escape") return;
      keysRef.current.add(event.code);

      const numeric = Number(event.key);
      if (numeric >= 1 && numeric <= HOTBAR_SLOT_COUNT) {
        const slotIndex = numeric - 1;
        const blockId = hotbarSlotsRef.current[slotIndex];
        setSelectedSlot(slotIndex);

        if (blockId) {
          setSelectedBlock(blockId);
          selectedRef.current = blockId;
        }
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
      if (inventoryOpenRef.current) return;

      if (document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock();
        return;
      }

      const animalHit = getAnimalIntersection();
      if (animalHit) {
        if (event.button === 0) {
          sendAnimalAction(animalHit.userData.animalId, "die");
        }

        if (event.button === 2) {
          sendAnimalAction(animalHit.userData.animalId, "happy");
        }

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

    function getAnimalIntersection() {
      if (!cameraRef.current || !animalsGroupRef.current) return null;

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(0, 0), cameraRef.current);
      const hits = raycaster.intersectObjects(animalsGroupRef.current.children, true);
      const hit = hits[0];
      if (!hit) return null;

      let object = hit.object;
      while (object && !object.userData.animalId) {
        object = object.parent;
      }

      return object || null;
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

      const animalConfig = SPAWN_EGG_BLOCK_MAP.get(selectedRef.current);
      if (animalConfig) {
        sendAnimalSpawn({
          animalType: animalConfig.id,
          x: next.x + 0.5,
          y: next.y,
          z: next.z + 0.5,
          yaw: camera.rotation.y
        });
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

    function sendAnimalSpawn(spawn) {
      socketRef.current?.emit("animal:spawn", { worldId, ...spawn }, (response) => {
        if (!response?.ok) {
          setNotice(response?.error || "Animal spawn failed");
        }
      });
    }

    function sendAnimalAction(animalId, action) {
      socketRef.current?.emit("animal:action", { worldId, animalId, action }, (response) => {
        if (!response?.ok) {
          setNotice(response?.error || "Animal action failed");
        }
      });
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
      animalMeshesRef.current.forEach((animal) => interpolateRemoteAvatar(animal, delta));
      animalMeshesRef.current.forEach(keepAnimalLooping);
      animalMeshesRef.current.forEach((animal) => finishAnimalActionIfNeeded(animal, now, removeAnimalMesh));
      playerMixersRef.current.forEach((mixer) => mixer.update(delta));
      animalMixersRef.current.forEach((mixer) => mixer.update(delta));
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
      [...animalMeshesRef.current.keys()].forEach(removeAnimalMesh);
      mount.removeChild(renderer.domElement);
    };
  }, [api, blockMaterials, token, worldId]);

  return (
    <main className={inventoryOpen ? "world-shell inventory-open" : "world-shell"}>
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
        {hotbarSlots.map((blockId, index) => {
          const block = BLOCK_LOOKUP.get(blockId);

          return (
            <button
              key={index}
              className={selectedSlot === index ? "hotbar-item active" : "hotbar-item"}
              draggable={Boolean(block)}
              onClick={() => selectHotbarSlot(index)}
              onDragOver={handleHotbarDragOver}
              onDrop={(event) => handleHotbarDrop(event, index)}
              onDragStart={(event) => block && handleBlockDragStart(event, block.id)}
              title={block ? `${index + 1}: ${block.label}` : `Slot ${index + 1}`}
            >
              {block ? (
                <span style={{ backgroundImage: `url("${BLOCK_TEXTURES[block.id].front}")` }} />
              ) : (
                <span className="empty-slot" />
              )}
              <small>{index + 1}</small>
            </button>
          );
        })}
      </div>

      {inventoryOpen && (
        <div className="inventory-overlay" onPointerDown={(event) => event.stopPropagation()}>
          <section className="inventory-panel">
            <header className="inventory-header">
              <h2>Inventory</h2>
              <button className="secondary-button" onClick={closeInventory}>
                Close
              </button>
            </header>

            <div className="inventory-grid">
              {BLOCK_TYPES.map((block) => (
                <button
                  key={block.id}
                  className="inventory-item"
                  draggable
                  onDragStart={(event) => handleBlockDragStart(event, block.id)}
                  title={block.label}
                >
                  <span style={{ backgroundImage: `url("${BLOCK_TEXTURES[block.id].front}")` }} />
                  <strong>{block.label}</strong>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

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
  action.userData = { mode };

  if (mode === "once") {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
  } else {
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
  }

  action.enabled = true;

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

function prepareAnimalSource(fbx, animalConfig) {
  const source = fbx;
  source.userData.animalConfig = animalConfig;

  source.traverse((child) => {
    if (child.isMesh) {
      child.frustumCulled = false;
    }
  });

  source.updateMatrixWorld(true);
  const originalBox = new THREE.Box3().setFromObject(source);
  const originalSize = new THREE.Vector3();
  originalBox.getSize(originalSize);
  const scale = animalConfig.height / Math.max(originalSize.y, 1);
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

function createAnimatedAnimal(source, animal, mixerRegistry) {
  const animalObject = cloneSkeleton(source);
  const config = source.userData.animalConfig || ANIMAL_TYPE_MAP.get(animal.animalType);
  animalObject.name = `animal-${animal.id}`;
  animalObject.userData.animalId = animal.id;
  animalObject.userData.animalType = animal.animalType;

  animalObject.traverse((child) => {
    child.userData.animalId = animal.id;
  });

  if (source.animations?.length) {
    const mixer = new THREE.AnimationMixer(animalObject);
    const idleClip = findAnimationClip(source, "Idle") || source.animations[0];
    const walkClip = findFirstAnimationClip(source, config?.walkCandidates || ["Walk", "Run"]) || idleClip;
    const happyClip = findFirstAnimationClip(source, config?.happyCandidates || ["Happy"]) || idleClip;
    const dieClip = findAnimationClip(source, "Death") || idleClip;
    const actions = {
      idle: createAvatarAction(mixer, idleClip, "loop"),
      walk: createAvatarAction(mixer, walkClip, "loop"),
      happy: createAvatarAction(mixer, happyClip, "once"),
      die: createAvatarAction(mixer, dieClip, "once")
    };

    animalObject.userData.animation = {
      actions,
      activeAction: null,
      activeName: null,
      movement: "idle",
      actionUntil: 0,
      removeAt: 0
    };

    setAnimalMovementAnimation(animalObject, "idle", 0);
    mixerRegistry.set(animal.id, mixer);
  }

  return animalObject;
}

function createFallbackAnimal(animalType) {
  const animal = new THREE.Group();
  animal.userData.isFallbackAnimal = true;
  animal.userData.animalType = animalType;

  const material = new THREE.MeshLambertMaterial({ color: animalType === "pig" ? "#e99bac" : "#d6d1c4" });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.5), material);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.38, 0.38), material);

  body.position.y = 0.3;
  head.position.set(0, 0.48, 0.38);
  animal.add(body, head);

  return animal;
}

function findFirstAnimationClip(source, names) {
  for (const name of names) {
    const clip = findAnimationClip(source, name);
    if (clip) return clip;
  }

  return null;
}

function setAnimalMovementAnimation(animal, animation, fadeSeconds = 0.15) {
  const controller = animal.userData.animation;
  if (!controller) return;

  const movement = animation === "walk" ? "walk" : "idle";
  controller.movement = movement;

  if (controller.actionUntil > performance.now() || controller.removeAt) {
    return;
  }

  playLoopingAvatarAction(animal, movement, fadeSeconds);
}

function triggerAnimalAction(animal, actionName) {
  const controller = animal.userData.animation;
  if (!controller) return;

  const action = actionName === "die" ? "die" : "happy";
  const nextAction = controller.actions[action];
  if (!nextAction) return;

  const durationMs = nextAction.getClip().duration * 1000;
  if (action === "die") {
    const minimumDuration =
      animal.userData.animalType === "chicken" ? 0 : MIN_NON_CHICKEN_DEATH_VISIBLE_MS;
    controller.removeAt = performance.now() + Math.max(durationMs, minimumDuration);
  } else {
    controller.actionUntil = performance.now() + durationMs;
  }

  playAvatarAction(animal, action, 0.06, true);
}

function finishAnimalActionIfNeeded(animal, now, removeAnimalMesh) {
  const controller = animal.userData.animation;
  if (!controller) return;

  if (controller.removeAt && now >= controller.removeAt) {
    removeAnimalMesh(animal.userData.animalId);
    return;
  }

  if (!controller.actionUntil || now < controller.actionUntil) return;

  controller.actionUntil = 0;
  setAnimalMovementAnimation(animal, controller.movement);
}

function keepAnimalLooping(animal) {
  const controller = animal.userData.animation;
  if (!controller || controller.actionUntil || controller.removeAt) return;

  const activeAction = controller.activeAction;
  if (!activeAction || activeAction.userData?.mode !== "loop") return;

  activeAction.setLoop(THREE.LoopRepeat, Infinity);
  activeAction.clampWhenFinished = false;
  activeAction.enabled = true;
  activeAction.paused = false;

  if (!activeAction.isRunning()) {
    activeAction.reset().play();
  }
}

function playLoopingAvatarAction(avatar, actionName, fadeSeconds = 0.15) {
  const controller = avatar.userData.animation;
  const nextAction = controller?.actions[actionName];

  if (!nextAction) return;

  nextAction.setLoop(THREE.LoopRepeat, Infinity);
  nextAction.clampWhenFinished = false;
  nextAction.enabled = true;
  nextAction.paused = false;

  if (controller.activeAction === nextAction) {
    if (!nextAction.isRunning()) {
      nextAction.reset().play();
    }
    return;
  }

  playAvatarAction(avatar, actionName, fadeSeconds, true);
}
