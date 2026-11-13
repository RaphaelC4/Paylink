/* Minimal static file server for frontend/ — the E2E layer's only "web
 * server". Dependency-free on purpose: the repo ships no bundler and this
 * must not add one. Serves committed files byte for byte on 127.0.0.1, with
 * no directory listing, no proxying and no egress of its own. Query strings
 * (the page's cache-bust refs, e.g. app.js?v=20261112b) are ignored.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = normalize(fileURLToPath(new URL("../frontend/", import.meta.url)));
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";

    /* Path-traversal guard: resolve against ROOT and refuse anything that
       escapes it (normalisation makes ../ and encoded forms collapse first).
       Containment is decided by path.relative(ROOT, filePath): an escaping
       path comes back as ".." (or starting with ".." + separator), and a
       cross-drive result on Windows comes back absolute — both refused.
       Unlike a bare startsWith(ROOT) prefix test, this cannot be fooled by
       a sibling directory whose name merely begins with "frontend". */
    const rel = normalize(pathname).replace(/^[/\\]+/, "");
    const filePath = normalize(join(ROOT, rel));
    const containment = relative(ROOT, filePath);
    if (
      containment !== "" &&
      (containment === ".." ||
        containment.startsWith(`..${sep}`) ||
        isAbsolute(containment))
    ) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }

    const body = await readFile(filePath);
    res
      .writeHead(200, {
        "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      })
      .end(body);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("server error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`paylink frontend served on http://127.0.0.1:${PORT}/ (static, no egress)`);
});
