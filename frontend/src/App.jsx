import { useEffect, useMemo, useState } from "react";
import { createApi, getErrorMessage } from "./api/client";
import AuthScreen from "./components/AuthScreen";
import Dashboard from "./components/Dashboard";
import WorldView from "./components/WorldView";

const TOKEN_KEY = "minicraft-token";

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  const [activeWorldId, setActiveWorldId] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState("");

  const api = useMemo(() => createApi(token), [token]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    api
      .get("/auth/me")
      .then((response) => {
        if (!cancelled) {
          setUser(response.data.user);
          setError("");
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          localStorage.removeItem(TOKEN_KEY);
          setToken(null);
          setUser(null);
          setError(getErrorMessage(requestError));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, token]);

  function handleAuthenticated(payload) {
    localStorage.setItem(TOKEN_KEY, payload.token);
    setToken(payload.token);
    setUser(payload.user);
    setError("");
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setActiveWorldId(null);
  }

  if (loading) {
    return <div className="center-screen">Loading MiniCraft...</div>;
  }

  if (!token || !user) {
    return <AuthScreen onAuthenticated={handleAuthenticated} initialError={error} />;
  }

  if (activeWorldId) {
    return (
      <WorldView
        api={api}
        token={token}
        user={user}
        worldId={activeWorldId}
        onExit={() => setActiveWorldId(null)}
      />
    );
  }

  return <Dashboard api={api} token={token} user={user} onLogout={handleLogout} onEnterWorld={setActiveWorldId} />;
}
