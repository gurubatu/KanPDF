#!/usr/bin/env node
// 乱翻书 KanPDF — 零依赖本地/局域网服务器（只需要 Node.js 18+，无需 Docker）
// 用法: node scripts/serve.js            环境变量: PORT=8080 HOST=0.0.0.0 BOOKS_DIR=./books
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..", "web");
const BOOKS = path.resolve(process.env.BOOKS_DIR || path.join(__dirname, "..", "books"));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
  ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream", ".ttf": "font/ttf",
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}

function inside(base, p) {
  const rel = path.relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    let start = 0, end = st.size - 1, code = 200;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
      else { start = Math.max(0, st.size - Number(m[2])); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        return res.end();
      }
      code = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    }
    headers["Content-Length"] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch { return send(res, 400, "Bad request"); }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  if (pathname.includes("\0")) return send(res, 400, "Bad request");

  if (pathname === "/books" ) { res.writeHead(301, { Location: "/books/" }); return res.end(); }
  if (pathname.startsWith("/books/")) {
    const target = path.resolve(BOOKS, "." + pathname.slice("/books".length));
    if (!inside(BOOKS, target)) return send(res, 403, "Forbidden");
    if (pathname === "/books/") {
      // 与 nginx autoindex_format json 同格式，供 library.html 使用
      fs.readdir(BOOKS, { withFileTypes: true }, (err, ents) => {
        if (err) return send(res, 200, "[]", MIME[".json"]);
        const out = ents.filter(e => e.isFile()).map(e => ({
          name: e.name, type: "file", size: fs.statSync(path.join(BOOKS, e.name)).size,
        }));
        send(res, 200, JSON.stringify(out), MIME[".json"]);
      });
      return;
    }
    return serveFile(req, res, target);
  }

  const target = path.resolve(ROOT, "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname));
  if (!inside(ROOT, target)) return send(res, 403, "Forbidden");
  serveFile(req, res, target);
}).listen(PORT, HOST, () => {
  console.log(`乱翻书已启动  书库目录: ${BOOKS}`);
  console.log(`  本机:   http://localhost:${PORT}/library.html`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === "IPv4" && !i.internal) console.log(`  局域网: http://${i.address}:${PORT}/library.html`);
  console.log("注意：无认证，请仅在可信局域网使用。Ctrl+C 退出。");
});
