import { useState } from "react";
import { createApi, getErrorMessage } from "../api/client";

export default function AuthScreen({ onAuthenticated, initialError }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError || "");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const api = createApi();
      const payload =
        mode === "register"
          ? { username, displayName: displayName || username, password }
          : { username, password };
      const response = await api.post(`/auth/${mode}`, payload);
      onAuthenticated(response.data);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div>
          <p className="eyebrow">Creative multiplayer</p>
          <h1>MiniCraft</h1>
        </div>

        <div className="segmented">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Login
          </button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit} className="form-stack">
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} />
          </label>

          {mode === "register" && (
            <label>
              Display name
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
          )}

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={6}
            />
          </label>

          {error && <div className="error-message">{error}</div>}

          <button className="primary-button" disabled={busy}>
            {busy ? "Please wait..." : mode === "login" ? "Enter" : "Create account"}
          </button>
        </form>
      </section>
    </main>
  );
}

