#!/usr/bin/env node
'use strict';
// Lumen VR Player — server edition (Docker / ZimaOS / any NAS).
// Serves the player UI and streams videos from a media folder to browsers on your network.
// HTTPS (self-signed by default) is required for VR headsets: browsers only allow WebXR in secure pages.
//
// Environment:
//   MEDIA_DIR        folder with videos (default /media)
//   MODELS_DIR       folder with .onnx AI models (default /models)
//   CONFIG_DIR       where the self-signed certificate is kept (default /config)
//   HTTP_PORT        default 8080   (set 0 to disable)
//   HTTPS_PORT       default 8443   (set 0 to disable)
//   LUMEN_PASSWORD   optional; when set, the browser asks for user "lumen" + this password

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { fileResponse, safeJoin } = require('../lib/serve');

const ROOT = path.resolve(__dirname, '..');
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || '/media');
const MODELS_DIR = path.resolve(process.env.MODELS_DIR || '/models');
const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || '/config');
const HTTP_PORT = +(process.env.HTTP_PORT ?? 8080);
const HTTPS_PORT = +(process.env.HTTPS_PORT ?? 8443);
const PASSWORD = process.env.LUMEN_PASSWORD || '';
const VERSION = require('../package.json').version;
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv']);

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...ISOLATION });
  res.end(data);
}

async function sendFile(req, res, file, extra = {}) {
  const r = await fileResponse(file, req.headers.range, { ...ISOLATION, ...extra });
  const headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  if (req.method === 'HEAD' || !r.body) return res.end();
  const reader = r.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((ok) => res.once('drain', ok));
    }
  } catch { /* client went away */ }
  res.end();
}

/** One folder level of the media library (folders first, then videos). */
async function listFolder(rel) {
  const dir = safeJoin(MEDIA_DIR, (rel || '/').split('/').map(encodeURIComponent).join('/'));
  if (!dir) return null;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return null; }
  const folders = [], videos = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('@')) continue;   // hidden / NAS metadata
    const relPath = path.posix.join(rel || '/', e.name);
    if (e.isDirectory()) folders.push({ name: e.name, path: relPath });
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      let size = 0, mtime = 0;
      try { const st = await fs.promises.stat(path.join(dir, e.name)); size = st.size; mtime = st.mtimeMs; } catch { /* ignore */ }
      videos.push({ name: e.name, path: relPath, size, mtime, url: '/media' + relPath.split('/').map(encodeURIComponent).join('/') });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  return { path: rel || '/', folders: folders.sort(byName), videos: videos.sort(byName) };
}

/** Recursive filename search (bounded). */
async function search(q, limit = 200) {
  const out = [];
  const needle = q.toLowerCase();
  async function walk(rel, depth) {
    if (out.length >= limit || depth > 8) return;
    const f = await listFolder(rel);
    if (!f) return;
    for (const v of f.videos) if (v.name.toLowerCase().includes(needle)) { out.push(v); if (out.length >= limit) return; }
    for (const d of f.folders) await walk(d.path, depth + 1);
  }
  await walk('/', 0);
  return out;
}

async function handle(req, res) {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Lumen VR Player", charset="UTF-8"' });
      return res.end('Password required');
    }
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);

    if (p === '/' || p === '/index.html') {
      res.writeHead(302, { Location: '/src/index.html' });
      return res.end();
    }
    if (p === '/api/info') {
      return json(res, 200, { server: true, version: VERSION, https: HTTPS_PORT || null, http: HTTP_PORT || null });
    }
    if (p === '/api/library') {
      const r = url.searchParams.get('q') ? { path: '/', folders: [], videos: await search(url.searchParams.get('q')) } : await listFolder(url.searchParams.get('path') || '/');
      return r ? json(res, 200, r) : json(res, 404, { error: 'Folder not found' });
    }
    if (p === '/api/models') {
      let files = [];
      try { files = (await fs.promises.readdir(MODELS_DIR)).filter((f) => f.toLowerCase().endsWith('.onnx')); } catch { /* none */ }
      return json(res, 200, files.sort().map((f) => ({ name: f, url: '/models/' + encodeURIComponent(f) })));
    }
    if (p.startsWith('/media/')) {
      const f = safeJoin(MEDIA_DIR, url.pathname.slice('/media'.length));
      return f ? sendFile(req, res, f) : json(res, 403, { error: 'Forbidden' });
    }
    if (p.startsWith('/models/')) {
      const f = safeJoin(MODELS_DIR, url.pathname.slice('/models'.length));
      return f ? sendFile(req, res, f) : json(res, 403, { error: 'Forbidden' });
    }
    if (p.startsWith('/src/') || p.startsWith('/node_modules/onnxruntime-web/dist/')) {
      const f = safeJoin(ROOT, url.pathname);
      return f ? sendFile(req, res, f, { 'Cache-Control': 'no-cache' }) : json(res, 403, { error: 'Forbidden' });
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
    else res.end();
  }
}

function certificate() {
  const key = path.join(CONFIG_DIR, 'key.pem'), cert = path.join(CONFIG_DIR, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    console.log('Creating a self-signed HTTPS certificate in', CONFIG_DIR);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-subj', '/CN=Lumen VR Player', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

if (require.main === module) {
  console.log(`Lumen VR Player server ${VERSION}`);
  console.log(`  media:  ${MEDIA_DIR}${fs.existsSync(MEDIA_DIR) ? '' : '  (missing! mount your videos here)'}`);
  console.log(`  models: ${MODELS_DIR}`);
  if (PASSWORD) console.log('  password protection: on (user "lumen")');
  if (HTTP_PORT) http.createServer(handle).listen(HTTP_PORT, () => console.log(`  http://<server-ip>:${HTTP_PORT}`));
  if (HTTPS_PORT) {
    try {
      https.createServer(certificate(), handle).listen(HTTPS_PORT, () => console.log(`  https://<server-ip>:${HTTPS_PORT}   (use this one for VR headsets)`));
    } catch (e) {
      console.error('HTTPS disabled:', e.message);
    }
  }
}

module.exports = { handle, listFolder };
