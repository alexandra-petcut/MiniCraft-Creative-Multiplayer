# MiniCraft Creative Multiplayer

A small Minecraft-like creative mode project for the Data Transmission course.

## Features

- Node.js + Express backend
- SQLite persistence
- JWT login/register
- Friends list
- World/server creation with invite codes
- REST CRUD endpoints for Postman testing
- Socket.IO real-time multiplayer block updates
- React + Vite frontend
- Three.js 100x100x100 creative world
- 9 supported blocks: grass, dirt, stone, wood, glass, red, blue, yellow, white

## Project Structure

```text
backend/   Node.js API, Socket.IO server, SQLite database
frontend/  React dashboard and Three.js world client
```

## Setup

```bash
npm run install:all
```

Create `backend/.env` from `backend/.env.example` if you want custom values. The defaults work locally.

## Run

Backend:

```bash
npm run dev:backend
```

Frontend:

```bash
npm run dev:frontend
```

Default URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`
- Health check: `http://localhost:4000/api/health`

## Manual Multiplayer Test

1. Register Player A in one browser.
2. Create a world from the dashboard.
3. Register Player B in another browser or incognito window.
4. Copy Player A's invite code and join it as Player B.
5. Enter the same world from both clients.
6. Place/remove blocks and verify both clients update immediately.
7. Close both clients, reopen the world, and verify saved blocks are loaded from SQLite.

## Postman CRUD Checklist

Use the JWT returned by login/register as a Bearer token.

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/friends`
- `POST /api/friends`
- `DELETE /api/friends/:friendId`
- `GET /api/worlds`
- `POST /api/worlds`
- `GET /api/worlds/:id`
- `PATCH /api/worlds/:id`
- `DELETE /api/worlds/:id`
- `POST /api/worlds/join/:inviteCode`
- `GET /api/worlds/:worldId/blocks`
- `POST /api/worlds/:worldId/blocks`
- `PUT /api/worlds/:worldId/blocks/:blockId`
- `DELETE /api/worlds/:worldId/blocks/:blockId`

## Notes

- The world is bounded to `x=0..99`, `y=0..99`, `z=0..99`.
- The default terrain is a flat grass layer at `y=0`.
- SQLite stores only changed blocks, not the full 1,000,000-cell world.
- Removed default blocks are persisted as `air`.

