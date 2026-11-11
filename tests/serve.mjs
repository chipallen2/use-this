// tests/serve.mjs - local dev/test server: serves dist/ like Vercel (cleanUrls)
// and routes /api/picks through the real api/picks.mjs handler.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { handle } from "../api/picks.mjs";

const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".txt": "text/plain", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

export function startServer({ dist = "dist", dataFile = "data/models.json", port = 0 } = {}) {
  const data = JSON.parse(readFileSync(dataFile, "utf8"));
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/api/picks") {
      const out = handle(`http://${req.headers.host}${req.url}`, data);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(out.body));
    }
    let p = join(dist, decodeURIComponent(u.pathname));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
    else if (!existsSync(p) && existsSync(p + ".html")) p += ".html";
    if (!existsSync(p)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" });
    res.end(readFileSync(p));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

if (process.argv[1]?.endsWith("serve.mjs")) {
  const { url } = await startServer({ port: Number(process.env.PORT || 4173) });
  console.log("serving " + url);
}
