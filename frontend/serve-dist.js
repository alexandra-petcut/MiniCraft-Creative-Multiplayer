import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "dist");
const port = Number(process.env.FRONTEND_PORT || 5173);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"]
]);

function sendFile(response, filePath) {
  const extension = path.extname(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes.get(extension) || "application/octet-stream"
  });
  createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://localhost:${port}`);
    const requestedPath = decodeURIComponent(url.pathname);
    const safePath = requestedPath.replace(/^\/+/, "");
    let filePath = path.join(root, safePath);

    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const fileStat = await stat(filePath).catch(() => null);

    if (fileStat?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    const finalStat = await stat(filePath).catch(() => null);

    if (finalStat?.isFile()) {
      sendFile(response, filePath);
      return;
    }

    sendFile(response, path.join(root, "index.html"));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error.message);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MiniCraft frontend preview listening on http://127.0.0.1:${port}`);
});

