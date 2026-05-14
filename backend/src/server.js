require("dotenv").config();

const cors = require("cors");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { databasePath } = require("./db");
const authRoutes = require("./routes/authRoutes");
const blockRoutes = require("./routes/blockRoutes");
const friendRoutes = require("./routes/friendRoutes");
const worldRoutes = require("./routes/worldRoutes");
const configureSockets = require("./socket");

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT || 4000);
const configuredClientOrigins = (
  process.env.CLIENT_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const localDevOriginPattern = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

function isAllowedOrigin(origin) {
  return !origin || configuredClientOrigins.includes(origin) || localDevOriginPattern.test(origin);
}

function corsOrigin(origin, callback) {
  if (isAllowedOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin ${origin} is not allowed by CORS.`));
}

app.use(
  cors({
    origin: corsOrigin,
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "MiniCraft backend",
    databasePath
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/worlds/:worldId/blocks", blockRoutes);
app.use("/api/worlds", worldRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

app.use((error, req, res, next) => {
  const status = error.status || 500;
  const message = status === 500 ? "Internal server error." : error.message;

  if (status === 500) {
    console.error(error);
  }

  res.status(status).json({ error: message });
});

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    credentials: true
  }
});

configureSockets(io);

server.listen(port, () => {
  console.log(`MiniCraft backend listening on http://localhost:${port}`);
});
