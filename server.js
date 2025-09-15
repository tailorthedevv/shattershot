import { WebSocketServer } from 'ws';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';
import fetch, { Request, Response } from 'node-fetch';

global.fetch = (url, options) => fetch(url, options);
global.Request = Request;
global.Response = Response;
global.self = global;
global.createImageBitmap = async () => Promise.resolve({ close: () => {} });

const wss = new WebSocketServer({ port: 8080 });
const worldOctree = new Octree();
let octreeReady = false;
const players = {};
const bullets = [];
const medkits = [];
const deadPlayers = {};
let nextBulletId = 0;
let lastMedkitSpawn = Date.now();

const TICK_RATE = 60;
const TICK_TIME = 1000 / TICK_RATE;
const PHYSICS_SUBSTEPS = 5;
const GRAVITY = 30;
const PLAYER_SPEED = 40;
const JUMP_VELOCITY = 8;
const MAX_SPEED = 5;
const RESPAWN_TIME = 3000;

const MEDKIT_MAX = 10;
const MEDKIT_RESPAWN_INTERVAL = 4000;
const MEDKIT_HEAL_AMOUNT = 40;
const MEDKIT_RADIUS = 0.35;
const MEDKIT_MIN_GROUND_NORMAL = 0.7;
const MEDKIT_MIN_PLAYER_DISTANCE = 2.0;
const MEDKIT_SPAWN_BOUNDS = 50;
const MEDKIT_RAY_HEIGHT = 30;
const MEDKIT_TRIES = 60;

const loader = new GLTFLoader();
loader.load('https://threejs.org/examples/models/gltf/collision-world.glb', (gltf) => {
  worldOctree.fromGraphNode(gltf.scene);
  octreeReady = true;
  startServer();
}, undefined, (err) => {
  console.error('World load error', err);
  startServer();
});

function vecLengthSq(v) {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function capsuleIntersectsSphere(capsule, sphere) {
  const start = capsule.start;
  const end = capsule.end;
  const center = sphere.center;
  const radius = capsule.radius + sphere.radius;
  const segDir = new THREE.Vector3().subVectors(end, start);
  const segLen = segDir.length();
  if (segLen === 0) return start.distanceTo(center) <= radius;
  segDir.normalize();
  const toCenter = new THREE.Vector3().subVectors(center, start);
  const t = Math.max(0, Math.min(segLen, segDir.dot(toCenter)));
  const closestPoint = new THREE.Vector3().copy(start).add(segDir.multiplyScalar(t));
  return closestPoint.distanceTo(center) <= radius;
}

function createBullet(player) {
  const bulletId = `bullet_${nextBulletId++}`;
  const direction = new THREE.Vector3(0, 0, -1).applyEuler(player.rotation).normalize();
  const headPos = player.collider.end.clone();
  const camQuat = new THREE.Quaternion().setFromEuler(player.rotation);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camQuat).normalize();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camQuat).normalize();
  const MUZZLE_FORWARD = 0.18;
  const MUZZLE_UP = 0.2;
  const MUZZLE_RIGHT = 0.1;
  const startPosition = headPos.clone()
    .add(direction.clone().multiplyScalar(MUZZLE_FORWARD))
    .add(up.clone().multiplyScalar(MUZZLE_UP))
    .add(right.clone().multiplyScalar(MUZZLE_RIGHT))
    .add(direction.clone().multiplyScalar(0.04));
  bullets.push({
    id: bulletId,
    ownerId: player.id,
    collider: new THREE.Sphere(startPosition.clone(), 0.08),
    velocity: direction.clone().multiplyScalar(80),
    spawnTime: Date.now(),
  });
}

function safeRayIntersect(ray) {
  if (!octreeReady || !worldOctree) return null;
  try {
    const hit = worldOctree.rayIntersect(ray);
    if (!hit || !hit.point) return null;
    return hit;
  } catch (e) {
    return null;
  }
}

function randomGroundPosition(options = {}) {
  const {
    maxTries = MEDKIT_TRIES,
    bounds = MEDKIT_SPAWN_BOUNDS,
    minNormalY = MEDKIT_MIN_GROUND_NORMAL,
    minPlayerDist = MEDKIT_MIN_PLAYER_DISTANCE,
    rayHeight = MEDKIT_RAY_HEIGHT,
    medkitRadius = MEDKIT_RADIUS
  } = options;
  if (!octreeReady || !worldOctree) {
    const x = (Math.random() - 0.5) * 2 * bounds;
    const z = (Math.random() - 0.5) * 2 * bounds;
    return { x, y: medkitRadius + 0.02, z };
  }
  for (let i = 0; i < maxTries; i++) {
    const x = (Math.random() - 0.5) * 2 * bounds;
    const z = (Math.random() - 0.5) * 2 * bounds;
    const start = new THREE.Vector3(x, rayHeight, z);
    const ray = new THREE.Ray(start, new THREE.Vector3(0, -1, 0));
    const hit = safeRayIntersect(ray);
    if (!hit) continue;
    const normalY = hit.normal && typeof hit.normal.y === 'number' ? hit.normal.y : 0;
    if (normalY < minNormalY) continue;
    const pos = hit.point.clone();
    pos.y += medkitRadius + 0.02;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) continue;
    if (pos.y < -10 || pos.y > rayHeight) continue;
    const SAMPLE_OFFSETS = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.4, 0, 0),
      new THREE.Vector3(-0.4, 0, 0),
      new THREE.Vector3(0, 0, 0.4),
      new THREE.Vector3(0, 0, -0.4),
    ];
    let consistent = true;
    for (const off of SAMPLE_OFFSETS) {
      const sx = pos.x + off.x;
      const sz = pos.z + off.z;
      const sStart = new THREE.Vector3(sx, rayHeight, sz);
      const sRay = new THREE.Ray(sStart, new THREE.Vector3(0, -1, 0));
      const sHit = safeRayIntersect(sRay);
      if (!sHit) { consistent = false; break; }
      if (Math.abs(sHit.point.y - hit.point.y) > medkitRadius + 0.3) { consistent = false; break; }
      const sNormalY = (sHit.normal && typeof sHit.normal.y === 'number') ? sHit.normal.y : 0;
      if (sNormalY < minNormalY) { consistent = false; break; }
    }
    if (!consistent) continue;
    let tooClose = false;
    for (const p of Object.values(players)) {
      const center = p.collider.start.clone().add(p.collider.end).multiplyScalar(0.5);
      const feetY = p.collider.start.y - p.collider.radius;
      const dx = center.x - pos.x;
      const dz = center.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < (minPlayerDist * minPlayerDist)) { tooClose = true; break; }
      const dy = feetY - pos.y;
      if (Math.abs(dy) < 0.6 && d2 < ((minPlayerDist * 0.7) * (minPlayerDist * 0.7))) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const upStart = pos.clone().add(new THREE.Vector3(0, 0.01, 0));
    const upRay = new THREE.Ray(upStart, new THREE.Vector3(0, 1, 0));
    const upHit = safeRayIntersect(upRay);
    if (upHit && typeof upHit.distance === 'number' && upHit.distance < medkitRadius * 0.9) continue;
    return { x: pos.x, y: pos.y, z: pos.z };
  }
  for (let j = 0; j < 20; j++) {
    const x = (Math.random() - 0.5) * 2 * bounds;
    const z = (Math.random() - 0.5) * 2 * bounds;
    const start = new THREE.Vector3(x, rayHeight, z);
    const hit = safeRayIntersect(new THREE.Ray(start, new THREE.Vector3(0, -1, 0)));
    if (!hit) continue;
    const pos = hit.point.clone();
    pos.y += medkitRadius + 0.02;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) continue;
    return { x: pos.x, y: pos.y, z: pos.z };
  }
  const playerList = Object.values(players);
  if (playerList.length > 0) {
    const p = playerList[Math.floor(Math.random() * playerList.length)];
    for (let k = 0; k < 12; k++) {
      const angle = Math.random() * Math.PI * 2;
      const r = MEDKIT_MIN_PLAYER_DISTANCE + Math.random() * 4.0;
      const px = (p.collider.start.x + p.collider.end.x) / 2 + Math.cos(angle) * r;
      const pz = (p.collider.start.z + p.collider.end.z) / 2 + Math.sin(angle) * r;
      const start = new THREE.Vector3(px, MEDKIT_RAY_HEIGHT, pz);
      const hit = safeRayIntersect(new THREE.Ray(start, new THREE.Vector3(0, -1, 0)));
      if (!hit) continue;
      const pos = hit.point.clone(); pos.y += medkitRadius + 0.02;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) continue;
      return { x: pos.x, y: pos.y, z: pos.z };
    }
  }
  const fx = (Math.random() - 0.5) * 2 * bounds;
  const fz = (Math.random() - 0.5) * 2 * bounds;
  return { x: fx, y: medkitRadius + 0.02, z: fz };
}

function spawnMedkit() {
  if (medkits.length >= MEDKIT_MAX) return;
  const pos = randomGroundPosition();
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    medkits.push({ id: `medkit_${Math.random().toString(36).slice(2, 10)}`, position: { x: 0, y: MEDKIT_RADIUS + 0.02, z: 0 }, pickedUp: false });
    return;
  }
  const id = `medkit_${Math.random().toString(36).slice(2, 10)}`;
  medkits.push({ id, position: { x: pos.x, y: pos.y, z: pos.z }, pickedUp: false });
}

function checkMedkitPickups() {
  for (const player of Object.values(players)) {
    for (const medkit of medkits) {
      if (medkit.pickedUp) continue;
      const px = player.collider.start.x;
      const py = player.collider.start.y;
      const pz = player.collider.start.z;
      const { x, y, z } = medkit.position;
      const dist = Math.sqrt((px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z));
      if (dist < 1.0 && player.health < player.maxHealth) {
        player.health = Math.min(player.maxHealth, player.health + MEDKIT_HEAL_AMOUNT);
        medkit.pickedUp = true;
      }
    }
  }
}

function updatePlayerState(player) {
  if (player.isReloading && (Date.now() - player.reloadStartTime >= player.reloadTime)) {
    player.isReloading = false;
    player.ammo = player.maxAmmo;
  }
}

function updatePlayer(player, deltaTime) {
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(player.rotation);
  forward.y = 0; forward.normalize();
  const side = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
  const accel = PLAYER_SPEED * deltaTime;
  if (player.input['KeyW']) player.velocity.add(forward.clone().multiplyScalar(accel));
  if (player.input['KeyS']) player.velocity.add(forward.clone().multiplyScalar(-accel));
  if (player.input['KeyA']) player.velocity.add(side.clone().multiplyScalar(-accel));
  if (player.input['KeyD']) player.velocity.add(side.clone().multiplyScalar(accel));
  if (player.onFloor && player.input['Space']) player.velocity.y = JUMP_VELOCITY;
  if (!player.onFloor) player.velocity.y -= GRAVITY * deltaTime;
  const damping = Math.exp(-6 * deltaTime);
  player.velocity.x *= damping;
  player.velocity.z *= damping;
  const horizontal = new THREE.Vector3(player.velocity.x, 0, player.velocity.z);
  if (horizontal.lengthSq() > MAX_SPEED * MAX_SPEED) {
    horizontal.normalize().multiplyScalar(MAX_SPEED);
    player.velocity.x = horizontal.x; player.velocity.z = horizontal.z;
  }
  const deltaPos = player.velocity.clone().multiplyScalar(deltaTime);
  player.collider.translate(deltaPos);
  const result = worldOctree.capsuleIntersect(player.collider);
  player.onFloor = false;
  if (result) {
    player.onFloor = result.normal.y > 0;
    if (!player.onFloor) player.velocity.addScaledVector(result.normal, -result.normal.dot(player.velocity));
    player.collider.translate(result.normal.multiplyScalar(result.depth));
  }
  if (player.collider.start.y < -25) {
    player.collider.start.set(0, 0.35, 0);
    player.collider.end.set(0, 0.8, 0);
    player.velocity.set(0, 0, 0);
  }
}

function updateBullets(deltaTime) {
  const now = Date.now();
  for (let i = bullets.length - 1; i >= 0; i--) {
    const bullet = bullets[i];
    if (!bullet) continue;
    const prev = bullet.collider.center.clone();
    bullet.collider.center.addScaledVector(bullet.velocity, deltaTime);
    const dir = new THREE.Vector3().subVectors(bullet.collider.center, prev);
    const segLen = dir.length();
    if (segLen > 0) dir.normalize();
    const ray = new THREE.Ray(prev, dir);
    const worldCollision = safeRayIntersect(ray);
    if ((worldCollision && worldCollision.distance <= segLen) || bullet.collider.center.length() > 300 || now - bullet.spawnTime > 3000) {
      bullets.splice(i, 1);
      continue;
    }
  }
}

function checkCollisions() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const bullet = bullets[i];
    if (!bullet) continue;
    for (const player of Object.values(players)) {
      if (bullet.ownerId !== player.id && capsuleIntersectsSphere(player.collider, bullet.collider)) {
        bullets.splice(i, 1);
        player.health -= 20;
        if (player.health <= 0) {
          if (players[bullet.ownerId]) players[bullet.ownerId].kills++;
          deadPlayers[player.id] = { respawnTime: Date.now() + RESPAWN_TIME, kills: player.kills };
          delete players[player.id];
        }
        break;
      }
    }
  }
}

function respawnPlayers() {
  const now = Date.now();
  for (const playerId in deadPlayers) {
    if (now >= deadPlayers[playerId].respawnTime) {
      players[playerId] = {
        id: playerId,
        name: playerId,
        collider: new Capsule(new THREE.Vector3(0, 0.35, 0), new THREE.Vector3(0, 0.8, 0), 0.35),
        velocity: new THREE.Vector3(),
        rotation: new THREE.Euler(0, 0, 0, 'YXZ'),
        input: {},
        onFloor: false,
        health: 100,
        maxHealth: 100,
        ammo: 30,
        maxAmmo: 30,
        isReloading: false,
        reloadStartTime: 0,
        reloadTime: 1500,
        kills: deadPlayers[playerId].kills || 0,
      };
      delete deadPlayers[playerId];
    }
  }
}

function tick() {
  const deltaTime = TICK_TIME / 1000;
  const substepDelta = deltaTime / PHYSICS_SUBSTEPS;
  for (const player of Object.values(players)) updatePlayerState(player);
  for (let i = 0; i < PHYSICS_SUBSTEPS; i++) {
    for (const player of Object.values(players)) updatePlayer(player, substepDelta);
    updateBullets(substepDelta);
    checkCollisions();
  }
  respawnPlayers();
  if (Date.now() - lastMedkitSpawn > MEDKIT_RESPAWN_INTERVAL) {
    spawnMedkit();
    lastMedkitSpawn = Date.now();
  }
  checkMedkitPickups();
  for (let i = medkits.length - 1; i >= 0; i--) {
    if (medkits[i].pickedUp) medkits.splice(i, 1);
  }
  const playersState = Object.values(players).map(p => {
    const center = p.collider.start.clone().add(p.collider.end).multiplyScalar(0.5);
    const feetY = p.collider.start.y - p.collider.radius;
    return {
      id: p.id,
      name: p.name,
      position: { x: center.x, y: feetY, z: center.z },
      rotation: { x: p.rotation.x, y: p.rotation.y, z: p.rotation.z },
      health: p.health,
      maxHealth: p.maxHealth,
      ammo: p.ammo,
      maxAmmo: p.maxAmmo,
      isReloading: p.isReloading,
      kills: p.kills,
    };
  });
  const bulletsState = bullets.map(b => ({
    id: b.id,
    position: { x: b.collider.center.x, y: b.collider.center.y, z: b.collider.center.z },
  }));
  const medkitsState = medkits.map(m => ({
    id: m.id,
    position: m.position
  }));
  const gameState = { type: 'update', players: playersState, bullets: bulletsState, medkits: medkitsState };
  const stateString = JSON.stringify(gameState);
  wss.clients.forEach(client => { if (client.readyState === client.OPEN) client.send(stateString); });
}

function startServer() {
  wss.on('connection', (ws) => {
    const playerId = `player_${Math.random().toString(36).slice(2, 9)}`;
    players[playerId] = {
      id: playerId,
      name: playerId,
      collider: new Capsule(new THREE.Vector3(0, 0.35, 0), new THREE.Vector3(0, 0.8, 0), 0.35),
      velocity: new THREE.Vector3(),
      rotation: new THREE.Euler(0, 0, 0, 'YXZ'),
      input: {},
      onFloor: false,
      health: 100,
      maxHealth: 100,
      kills: 0,
      ammo: 30,
      maxAmmo: 30,
      isReloading: false,
      reloadStartTime: 0,
      reloadTime: 1500,
    };
    ws.playerId = playerId;
    ws.send(JSON.stringify({ type: 'init', playerId }));
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        const player = players[playerId];
        if (!player) return;
        if (data.type === 'join') {
          player.name = (typeof data.name === 'string' && data.name.length > 0) ? data.name.slice(0, 16) : player.name;
          return;
        }
        if (data.type === 'input') {
          if (data.rotation && Number.isFinite(data.rotation.x) && Number.isFinite(data.rotation.y) && Number.isFinite(data.rotation.z)) {
            const rx = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, data.rotation.x));
            player.rotation.set(rx, data.rotation.y, data.rotation.z, 'YXZ');
          }
          player.input = data.keys || {};
        } else if (data.type === 'shoot') {
          if (!player.isReloading && player.ammo > 0) {
            player.ammo--;
            createBullet(player);
            if (player.ammo <= 0) {
              player.isReloading = true;
              player.reloadStartTime = Date.now();
            }
          }
        } else if (data.type === 'reload') {
          if (!player.isReloading && player.ammo < player.maxAmmo) {
            player.isReloading = true;
            player.reloadStartTime = Date.now();
          }
        }
      } catch (e) {
        console.error('Failed to parse message', e);
      }
    });
    ws.on('close', () => {
      delete players[playerId];
      delete ws.playerId;
    });
  });
  setInterval(tick, TICK_TIME);
}

console.log('WebSocket server starting...');
