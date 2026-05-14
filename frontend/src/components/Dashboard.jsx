import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { API_URL, getErrorMessage } from "../api/client";

const DIRECT_MESSAGE_MAX_LENGTH = 200;

export default function Dashboard({ api, token, user, onLogout, onEnterWorld }) {
  const [view, setView] = useState("dashboard");
  const [worlds, setWorlds] = useState([]);
  const [friends, setFriends] = useState([]);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [outgoingRequests, setOutgoingRequests] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [messageRequests, setMessageRequests] = useState([]);
  const [worldName, setWorldName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [friendUsername, setFriendUsername] = useState("");
  const [selectedChat, setSelectedChat] = useState(null);
  const [directMessages, setDirectMessages] = useState([]);
  const [directMessageText, setDirectMessageText] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const socketRef = useRef(null);
  const selectedChatRef = useRef(null);
  const friendsRef = useRef([]);
  const viewRef = useRef(view);

  const ownedWorlds = useMemo(() => worlds.filter((world) => world.ownerId === user.id), [worlds, user.id]);
  const joinedWorlds = useMemo(() => worlds.filter((world) => world.ownerId !== user.id), [worlds, user.id]);

  async function loadDashboard() {
    const [worldResponse, friendResponse] = await Promise.all([api.get("/worlds"), api.get("/friends")]);
    setWorlds(worldResponse.data.worlds || []);
    setFriends(friendResponse.data.friends || []);
    setIncomingRequests(friendResponse.data.incomingRequests || []);
    setOutgoingRequests(friendResponse.data.outgoingRequests || []);
  }

  async function loadConversations() {
    const [conversationResponse, requestResponse] = await Promise.all([
      api.get("/direct-messages"),
      api.get("/direct-messages/requests")
    ]);
    setConversations(conversationResponse.data.conversations || []);
    setMessageRequests(requestResponse.data.requests || []);
  }

  useEffect(() => {
    loadDashboard().catch((error) => setMessage(getErrorMessage(error)));
  }, []);

  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

  useEffect(() => {
    friendsRef.current = friends;
  }, [friends]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const socket = io(API_URL, {
      auth: { token },
      transports: ["websocket", "polling"]
    });
    socketRef.current = socket;

    socket.on("connect_error", (socketError) => {
      setMessage(socketError.message || "Private chat connection failed.");
    });

    socket.on("dm:message", ({ message: nextMessage }) => {
      if (!nextMessage) return;

      const otherUserId = nextMessage.senderId === user.id ? nextMessage.receiverId : nextMessage.senderId;
      const isFriendMessage = friendsRef.current.some((friend) => friend.id === otherUserId);

      if (isFriendMessage) {
        setConversations((items) => upsertConversationPreview(items, nextMessage, user.id));
      } else {
        setMessageRequests((items) => upsertRequestPreview(items, nextMessage, user.id));
        loadConversations().catch((error) => setMessage(getErrorMessage(error)));
      }

      if (selectedChatRef.current?.user.id === otherUserId) {
        setDirectMessages((messages) => upsertDirectMessage(messages, nextMessage));
      } else {
        setMessage(`New message from ${nextMessage.sender?.displayName || "a user"}.`);
      }
    });

    socket.on("friends:updated", () => {
      loadDashboard().catch((error) => setMessage(getErrorMessage(error)));

      if (viewRef.current === "messages") {
        loadConversations().catch((error) => setMessage(getErrorMessage(error)));
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, user.id]);

  useEffect(() => {
    if (!selectedChat) return;

    const stillFriend = friends.some((friend) => friend.id === selectedChat.user.id);
    const stillRequest = messageRequests.some((request) => request.request.id === selectedChat.request?.id);

    if (selectedChat.type === "friend" && !stillFriend) {
      setSelectedChat(null);
      setDirectMessages([]);
    }

    if (selectedChat.type === "request" && !stillRequest) {
      setSelectedChat(null);
      setDirectMessages([]);
    }
  }, [friends, messageRequests, selectedChat]);

  useEffect(() => {
    if (!selectedChat) return;

    let cancelled = false;
    setChatLoading(true);
    setDirectMessages([]);

    api
      .get(`/direct-messages/${selectedChat.user.id}`)
      .then((response) => {
        if (cancelled) return;

        setDirectMessages(response.data.messages || []);
        setSelectedChat((current) => {
          if (!current || current.user.id !== selectedChat.user.id) return current;
          return {
            ...current,
            canSend: response.data.relationship?.canSend ?? current.canSend,
            relationship: response.data.relationship || current.relationship
          };
        });
      })
      .catch((error) => {
        if (!cancelled) setMessage(getErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, selectedChat?.user.id]);

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

  async function runSocialAction(action) {
    setBusy(true);
    setMessage("");

    try {
      await action();
      await loadDashboard();
      if (view === "messages") await loadConversations();
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
    runSocialAction(async () => {
      const response = await api.post("/friends", { username: friendUsername });
      setFriendUsername("");

      if (response.data.accepted) {
        setMessage(`You are now friends with ${response.data.friend.displayName}.`);
        return;
      }

      if (response.data.alreadyFriends) {
        setMessage(`${response.data.friend.displayName} is already your friend.`);
        return;
      }

      setMessage(`Friend request sent to ${response.data.request.user.displayName}.`);
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
    runSocialAction(async () => {
      await api.delete(`/friends/${friend.id}`);
      setConversations((items) => items.filter((item) => item.friend.id !== friend.id));
      if (selectedChat?.user.id === friend.id) {
        setSelectedChat(null);
        setDirectMessages([]);
      }
      setMessage("Friend removed.");
    });
  }

  function acceptFriendRequest(requestItem) {
    const requestId = requestItem.request?.id || requestItem.id;
    const requestUser = requestItem.user || selectedChat?.user;

    setBusy(true);
    setMessage("");

    api
      .patch(`/friends/requests/${requestId}/accept`)
      .then(async (response) => {
        const friend = response.data.friend || requestUser;
        await loadDashboard();
        if (view === "messages") await loadConversations();

        setSelectedChat((current) => {
          if (current?.request?.id !== requestId) return current;
          return {
            type: "friend",
            user: friend,
            request: null,
            direction: "friend",
            canSend: true
          };
        });

        setMessage(`Accepted ${friend.displayName}'s friend request.`);
      })
      .catch((error) => setMessage(getErrorMessage(error)))
      .finally(() => setBusy(false));
  }

  function deleteFriendRequest(requestItem, actionText) {
    const requestId = requestItem.request?.id || requestItem.id;

    setBusy(true);
    setMessage("");

    api
      .delete(`/friends/requests/${requestId}`)
      .then(async () => {
        await loadDashboard();
        if (view === "messages") await loadConversations();

        setSelectedChat((current) => {
          if (current?.request?.id !== requestId) return current;
          setDirectMessages([]);
          return null;
        });

        setMessage(actionText);
      })
      .catch((error) => setMessage(getErrorMessage(error)))
      .finally(() => setBusy(false));
  }

  function openMessages() {
    setView("messages");
    setMessage("");
    loadConversations().catch((error) => setMessage(getErrorMessage(error)));
  }

  function openFriendChat(friend) {
    setSelectedChat({
      type: "friend",
      user: friend,
      request: null,
      direction: "friend",
      canSend: true
    });
    setDirectMessageText("");
    setMessage("");
    setView("messages");
    loadConversations().catch((error) => setMessage(getErrorMessage(error)));
  }

  function openIncomingRequests() {
    setView("incomingRequests");
    setMessage("");
  }

  function openSentRequests() {
    setView("sentRequests");
    setMessage("");
  }

  function closeRequestView() {
    setView("dashboard");
    setMessage("");
  }

  function closeMessages() {
    setView("dashboard");
    setSelectedChat(null);
    setDirectMessages([]);
    setDirectMessageText("");
  }

  function selectConversation(conversation) {
    setSelectedChat({
      type: "friend",
      user: conversation.friend,
      request: null,
      direction: "friend",
      canSend: true
    });
    setDirectMessageText("");
    setMessage("");
  }

  function sendDirectMessage(event) {
    event.preventDefault();

    const text = directMessageText.trim();
    if (!selectedChat || !text) {
      setDirectMessageText("");
      return;
    }

    if (!selectedChat.canSend) {
      setMessage("Accept this friend request before replying.");
      return;
    }

    socketRef.current?.emit("dm:send", { receiverId: selectedChat.user.id, text }, (response) => {
      if (!response?.ok) {
        setMessage(response?.error || "Message failed.");
      }
    });

    setDirectMessageText("");
  }

  if (view === "incomingRequests" || view === "sentRequests") {
    const incomingView = view === "incomingRequests";
    const requestItems = incomingView ? incomingRequests : outgoingRequests;
    const title = incomingView ? "Incoming requests" : "Sent requests";

    return (
      <main className="dashboard">
        <header className="topbar">
          <div>
            <p className="eyebrow">MiniCraft dashboard</p>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            <button className="secondary-button" onClick={closeRequestView}>
              Back to dashboard
            </button>
            <button className="secondary-button" onClick={onLogout}>
              Logout
            </button>
          </div>
        </header>

        <section className="request-page">
          <div className="panel">
            <div className="panel-header">
              <h2>{title}</h2>
              <span>{requestItems.length}</span>
            </div>

            {requestItems.length === 0 && (
              <div className="request-empty">
                <h2>{incomingView ? "No incoming requests" : "No sent requests"}</h2>
                <p className="muted">
                  {incomingView
                    ? "New friend requests will appear here."
                    : "Friend requests you send will appear here."}
                </p>
              </div>
            )}

            {requestItems.length > 0 && (
              <div className="request-list">
                {requestItems.map((request) => (
                  <div className="request-row request-page-row" key={request.id}>
                    <div>
                      <strong>{request.user.displayName}</strong>
                      <span>@{request.user.username}</span>
                    </div>
                    <div className="friend-actions">
                      {incomingView ? (
                        <>
                          <button
                            className="primary-button"
                            onClick={() => acceptFriendRequest(request)}
                            disabled={busy}
                          >
                            Accept
                          </button>
                          <button
                            className="ghost-button"
                            onClick={() => deleteFriendRequest(request, "Friend request declined.")}
                            disabled={busy}
                          >
                            Decline
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="status-pill">Pending</span>
                          <button
                            className="ghost-button"
                            onClick={() => deleteFriendRequest(request, "Friend request cancelled.")}
                            disabled={busy}
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {message && <div className="toast">{message}</div>}
      </main>
    );
  }

  if (view === "messages") {
    const visibleConversations = conversations.filter((conversation) => conversation.latestMessage);
    const hasConversationItems = visibleConversations.length > 0;

    return (
      <main className="dashboard">
        <header className="topbar">
          <div>
            <p className="eyebrow">MiniCraft dashboard</p>
            <h1>Messages</h1>
          </div>
          <div className="topbar-actions">
            <button className="secondary-button" onClick={closeMessages}>
              Back to dashboard
            </button>
            <button className="secondary-button" onClick={onLogout}>
              Logout
            </button>
          </div>
        </header>

        <section className="messages-layout">
          <aside className="panel conversations-panel">
            <div className="panel-header">
              <h2>Chats</h2>
              <span>{visibleConversations.length}</span>
            </div>

            <div className="conversation-list">
              {visibleConversations.length === 0 && <p className="muted">No accepted chats yet.</p>}
              {visibleConversations.map((conversation) => (
                <button
                  className={
                    selectedChat?.type === "friend" && selectedChat.user.id === conversation.friend.id
                      ? "conversation-row active"
                      : "conversation-row"
                  }
                  key={conversation.friend.id}
                  onClick={() => selectConversation(conversation)}
                >
                  <span className="conversation-avatar">{getInitials(conversation.friend.displayName)}</span>
                  <span className="conversation-copy">
                    <strong>{conversation.friend.displayName}</strong>
                    <small>@{conversation.friend.username}</small>
                    <em>{getConversationPreview(conversation, user.id)}</em>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="panel messages-panel">
            {!selectedChat && (
              <div className="messages-empty">
                <h2>{hasConversationItems ? "Select a chat" : "No chats yet"}</h2>
                <p className="muted">
                  {hasConversationItems
                    ? "Choose a chat or request from the list."
                    : "Add friends from the dashboard to start private chats."}
                </p>
              </div>
            )}

            {selectedChat && (
              <>
                <div className="messages-header">
                  <div>
                    <h2>{selectedChat.user.displayName}</h2>
                    <span>@{selectedChat.user.username}</span>
                  </div>

                  {selectedChat.type === "request" && selectedChat.direction === "incoming" && (
                    <div className="messages-request-actions">
                      <button className="primary-button" onClick={() => acceptFriendRequest(selectedChat)}>
                        Accept
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() => deleteFriendRequest(selectedChat, "Friend request declined.")}
                      >
                        Decline
                      </button>
                    </div>
                  )}

                  {selectedChat.type === "request" && selectedChat.direction === "outgoing" && (
                    <div className="messages-request-actions">
                      <button
                        className="ghost-button"
                        onClick={() => deleteFriendRequest(selectedChat, "Friend request cancelled.")}
                      >
                        Cancel request
                      </button>
                    </div>
                  )}
                </div>

                {selectedChat.type === "request" && (
                  <p className="messages-notice">
                    {selectedChat.direction === "incoming"
                      ? "This user sent you a friend request. Accept it to reply and move this chat to Chats."
                      : "This message will stay in Requests until the other user accepts your friend request."}
                  </p>
                )}

                <div className="dashboard-chat-messages messages-thread">
                  {chatLoading && <p className="muted">Loading messages...</p>}
                  {!chatLoading && directMessages.length === 0 && <p className="muted">No messages yet.</p>}
                  {directMessages.map((directMessage) => {
                    const ownMessage = directMessage.senderId === user.id;
                    return (
                      <div
                        className={ownMessage ? "dashboard-chat-message own" : "dashboard-chat-message"}
                        key={directMessage.id}
                      >
                        <div>
                          <span>{ownMessage ? "You" : directMessage.sender.displayName}</span>
                          <p>{directMessage.text}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {selectedChat.canSend ? (
                  <form className="dashboard-chat-form" onSubmit={sendDirectMessage}>
                    <input
                      value={directMessageText}
                      onChange={(event) => setDirectMessageText(event.target.value)}
                      maxLength={DIRECT_MESSAGE_MAX_LENGTH}
                      placeholder={`Message ${selectedChat.user.displayName}`}
                    />
                    <button className="primary-button">Send</button>
                  </form>
                ) : (
                  <div className="messages-disabled-input">Accept this friend request to reply.</div>
                )}
              </>
            )}
          </section>
        </section>

        {message && <div className="toast">{message}</div>}
      </main>
    );
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">MiniCraft dashboard</p>
          <h1>Welcome, {user.displayName}</h1>
        </div>
        <div className="topbar-actions">
          <button className="secondary-button" onClick={openMessages}>
            Messages
          </button>
          <button className="secondary-button" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      <section className="dashboard-grid">
        <div className="dashboard-world-column">
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
        </div>

        <div className="panel friends-panel">
          <div className="panel-header">
            <h2>Friends</h2>
            <span>{friends.length}</span>
          </div>
          <form className="inline-form friend-add-form" onSubmit={addFriend}>
            <input
              value={friendUsername}
              onChange={(event) => setFriendUsername(event.target.value)}
              placeholder="Username"
              required
            />
            <button className="primary-button" disabled={busy}>
              Send request
            </button>
          </form>

          <div className="request-entry-list">
            <button className="request-entry" onClick={openIncomingRequests}>
              <span>Incoming requests</span>
              <strong>{incomingRequests.length}</strong>
            </button>
            <button className="request-entry" onClick={openSentRequests}>
              <span>Sent requests</span>
              <strong>{outgoingRequests.length}</strong>
            </button>
          </div>

          <div className="friend-list friend-list-scroll">
            {friends.length === 0 && <p className="muted">No friends yet.</p>}
            {friends.map((friend) => (
              <div className="friend-row" key={friend.id}>
                <div>
                  <strong>{friend.displayName}</strong>
                  <span>@{friend.username}</span>
                </div>
                <div className="friend-actions">
                  <button className="secondary-button" onClick={() => openFriendChat(friend)}>
                    Chat
                  </button>
                  <button className="ghost-button" onClick={() => removeFriend(friend)} disabled={busy}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {message && <div className="toast">{message}</div>}
    </main>
  );
}

function upsertDirectMessage(messages, nextMessage) {
  if (messages.some((message) => message.id === nextMessage.id)) return messages;
  return [...messages, nextMessage];
}

function upsertConversationPreview(conversations, nextMessage, currentUserId) {
  const friend = nextMessage.senderId === currentUserId ? nextMessage.receiver : nextMessage.sender;
  const without = conversations.filter((conversation) => conversation.friend.id !== friend.id);
  return [{ friend, latestMessage: nextMessage }, ...without];
}

function upsertRequestPreview(requests, nextMessage, currentUserId) {
  const otherUser = nextMessage.senderId === currentUserId ? nextMessage.receiver : nextMessage.sender;
  const existing = requests.find((request) => request.user.id === otherUser.id);
  if (!existing) return requests;

  const without = requests.filter((request) => request.user.id !== otherUser.id);
  return [{ ...existing, latestMessage: nextMessage }, ...without];
}

function getConversationPreview(conversation, currentUserId) {
  const message = conversation.latestMessage;
  if (!message) return "No messages yet";

  const prefix = message.senderId === currentUserId ? "You: " : "";
  return `${prefix}${message.text}`;
}

function getInitials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
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
              Owner: {world.ownerDisplayName} - Members: {world.memberCount}
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
