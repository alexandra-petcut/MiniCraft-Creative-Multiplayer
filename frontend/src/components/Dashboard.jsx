import { useEffect, useMemo, useState } from "react";
import { getErrorMessage } from "../api/client";

export default function Dashboard({ api, user, onLogout, onEnterWorld }) {
  const [worlds, setWorlds] = useState([]);
  const [friends, setFriends] = useState([]);
  const [worldName, setWorldName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [friendUsername, setFriendUsername] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const ownedWorlds = useMemo(() => worlds.filter((world) => world.ownerId === user.id), [worlds, user.id]);
  const joinedWorlds = useMemo(() => worlds.filter((world) => world.ownerId !== user.id), [worlds, user.id]);

  async function loadDashboard() {
    const [worldResponse, friendResponse] = await Promise.all([api.get("/worlds"), api.get("/friends")]);
    setWorlds(worldResponse.data.worlds);
    setFriends(friendResponse.data.friends);
  }

  useEffect(() => {
    loadDashboard().catch((error) => setMessage(getErrorMessage(error)));
  }, []);

  async function runAction(action) {
    setBusy(true);
    setMessage("");

    try {
      await action();
      await loadDashboard();
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function createWorld(event) {
    event.preventDefault();
    runAction(async () => {
      const response = await api.post("/worlds", { name: worldName });
      setWorldName("");
      setMessage(`Created world ${response.data.world.name}.`);
    });
  }

  function joinWorld(event) {
    event.preventDefault();
    runAction(async () => {
      const code = inviteCode.trim().toUpperCase();
      const response = await api.post(`/worlds/join/${code}`);
      setInviteCode("");
      setMessage(`Joined ${response.data.world.name}.`);
    });
  }

  function addFriend(event) {
    event.preventDefault();
    runAction(async () => {
      const response = await api.post("/friends", { username: friendUsername });
      setFriendUsername("");
      setMessage(`Added ${response.data.friend.username}.`);
    });
  }

  function renameWorld(world) {
    const nextName = window.prompt("New world name", world.name);
    if (!nextName || nextName.trim() === world.name) return;

    runAction(async () => {
      await api.patch(`/worlds/${world.id}`, { name: nextName.trim() });
      setMessage("World renamed.");
    });
  }

  function deleteWorld(world) {
    if (!window.confirm(`Delete ${world.name}?`)) return;

    runAction(async () => {
      await api.delete(`/worlds/${world.id}`);
      setMessage("World deleted.");
    });
  }

  function removeFriend(friend) {
    runAction(async () => {
      await api.delete(`/friends/${friend.id}`);
      setMessage("Friend removed.");
    });
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">MiniCraft dashboard</p>
          <h1>Welcome, {user.displayName}</h1>
        </div>
        <button className="secondary-button" onClick={onLogout}>
          Logout
        </button>
      </header>

      <section className="dashboard-grid">
        <div className="panel wide">
          <div className="panel-header">
            <h2>Your worlds</h2>
            <span>{worlds.length} total</span>
          </div>

          <form className="inline-form" onSubmit={createWorld}>
            <input
              value={worldName}
              onChange={(event) => setWorldName(event.target.value)}
              placeholder="World name"
              minLength={3}
              required
            />
            <button className="primary-button" disabled={busy}>
              Create
            </button>
          </form>

          <div className="world-list">
            <WorldGroup
              title="Owned"
              worlds={ownedWorlds}
              user={user}
              onEnterWorld={onEnterWorld}
              onRename={renameWorld}
              onDelete={deleteWorld}
            />
            <WorldGroup
              title="Joined"
              worlds={joinedWorlds}
              user={user}
              onEnterWorld={onEnterWorld}
              onRename={renameWorld}
              onDelete={deleteWorld}
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Join world</h2>
          </div>
          <form className="form-stack" onSubmit={joinWorld}>
            <label>
              Invite code
              <input
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="AB12CD34"
                required
              />
            </label>
            <button className="primary-button" disabled={busy}>
              Join
            </button>
          </form>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Friends</h2>
            <span>{friends.length}</span>
          </div>
          <form className="inline-form" onSubmit={addFriend}>
            <input
              value={friendUsername}
              onChange={(event) => setFriendUsername(event.target.value)}
              placeholder="Username"
              required
            />
            <button className="primary-button" disabled={busy}>
              Add
            </button>
          </form>

          <div className="friend-list">
            {friends.length === 0 && <p className="muted">No friends yet.</p>}
            {friends.map((friend) => (
              <div className="friend-row" key={friend.id}>
                <div>
                  <strong>{friend.displayName}</strong>
                  <span>@{friend.username}</span>
                </div>
                <button className="ghost-button" onClick={() => removeFriend(friend)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {message && <div className="toast">{message}</div>}
    </main>
  );
}

function WorldGroup({ title, worlds, user, onEnterWorld, onRename, onDelete }) {
  return (
    <section className="world-group">
      <h3>{title}</h3>
      {worlds.length === 0 && <p className="muted">No worlds in this group.</p>}
      {worlds.map((world) => (
        <article className="world-card" key={world.id}>
          <div>
            <h4>{world.name}</h4>
            <p>
              Owner: {world.ownerDisplayName} · Members: {world.memberCount}
            </p>
            <code>{world.inviteCode}</code>
          </div>
          <div className="card-actions">
            <button className="primary-button" onClick={() => onEnterWorld(world.id)}>
              Enter
            </button>
            {world.ownerId === user.id && (
              <>
                <button className="secondary-button" onClick={() => onRename(world)}>
                  Rename
                </button>
                <button className="danger-button" onClick={() => onDelete(world)}>
                  Delete
                </button>
              </>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}

