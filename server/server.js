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
const media = require('../lib/media');

const ROOT = path.resolve(__dirname, '..');
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || '/media');
const MODELS_DIR = path.resolve(process.env.MODELS_DIR || '/models');
const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || '/config');
const HTTP_PORT = +(process.env.HTTP_PORT ?? 8080);
const HTTPS_PORT = +(process.env.HTTPS_PORT ?? 8443);
const PASSWORD = process.env.LUMEN_PASSWORD || '';
const VERSION = require('../package.json').version;
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.mts',
  '.mpg', '.mpeg', '.vob', '.3gp', '.divx', '.asf', '.f4v', '.rm', '.rmvb', '.m3u', '.m3u8']);
const PLAYLISTS_FILE = () => path.join(CONFIG_DIR, 'playlists.json');
const encPath = (rel) => rel.split('/').map(encodeURIComponent).join('/');

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Headers on every response. CORS lets the Android app (which runs its own bundled player) read the
// library, playlists and video frames from this server.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Type',
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
    if (req.method === 'OPTIONS') {   // CORS preflight (Android app → server on the home network)
      res.writeHead(204, {
        ...ISOLATION,
        'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
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
      return json(res, 200, { server: true, version: VERSION, https: HTTPS_PORT || null, http: HTTP_PORT || null, ffmpeg: !!media.findFfmpeg() });
    }
    if (p === '/api/library') {
      const r = url.searchParams.get('q') ? { path: '/', folders: [], videos: await search(url.searchParams.get('q')) } : await listFolder(url.searchParams.get('path') || '/');
      return r ? json(res, 200, r) : json(res, 404, { error: 'Folder not found' });
    }
    if (p === '/api/probe' && url.searchParams.get('u')) {
      // Network stream (HLS .m3u8, HTTP, RTSP…): the server reads it with FFmpeg and passes it on as MP4.
      const src = url.searchParams.get('u');
      if (!media.isUrl(src)) return json(res, 400, { error: 'Not a stream link' });
      const caps = { hevc: url.searchParams.get('hevc') === '1', av1: url.searchParams.get('av1') !== '0' };
      if (url.searchParams.get('force') === 'transcode') caps.force = 'transcode';
      const d = await media.describe(src, caps);
      if (!d.ffmpeg) return json(res, 500, { error: 'FFmpeg is not available on the server' });
      if (!d.videoCodec && !d.audioCodec) return json(res, 502, { error: 'Could not open that stream (check the link, or whether it is online)' });
      const q = new URLSearchParams({ u: src, mode: d.mode === 'transcode' ? 'transcode' : 'remux', copyAudio: d.copyAudio ? '1' : '0', codec: d.videoCodec, acodec: d.audioCodec });
      const fb = new URLSearchParams({ u: src, mode: 'transcode', copyAudio: d.copyAudio ? '1' : '0', acodec: d.audioCodec });
      return json(res, 200, { ...d, url: '/stream-url?' + q, fallbackUrl: '/stream-url?' + fb, streamed: true });
    }
    if (p === '/stream-url') {
      const q = url.searchParams;
      const src = q.get('u') || '';
      if (!media.isUrl(src)) return json(res, 400, { error: 'Not a stream link' });
      let child;
      try {
        child = media.stream(src, { mode: q.get('mode') === 'transcode' ? 'transcode' : 'remux', copyAudio: q.get('copyAudio') === '1', start: Math.max(0, +q.get('start') || 0), codec: q.get('codec') || '', audioCodec: q.get('acodec') || '', maxWidth: Math.max(0, Math.min(7680, +q.get('maxWidth') || 0)) });
      } catch (e) { return json(res, 500, { error: e.message }); }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', ...ISOLATION });
      child.stdout.pipe(res);
      const stop = () => child.kill('SIGKILL');
      req.on('close', stop);
      res.on('close', stop);
      return;
    }
    if (p === '/api/fetch-text') {
      // Download an M3U channel list for the player (no browser CORS limits on the server).
      try { return json(res, 200, await media.fetchText(url.searchParams.get('u') || '')); } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (p === '/api/probe') {
      const rel = url.searchParams.get('path') || '';
      const f = safeJoin(MEDIA_DIR, encPath(rel));
      if (!f || !fs.existsSync(f)) return json(res, 404, { error: 'File not found' });
      const caps = { hevc: url.searchParams.get('hevc') === '1', av1: url.searchParams.get('av1') !== '0' };
      if (url.searchParams.get('force') === 'transcode') caps.force = 'transcode';
      const d = await media.describe(f, caps);
      const direct = '/media' + encPath(rel);
      const streamUrl = '/stream' + encPath(rel) + `?mode=${d.mode}&copyAudio=${d.copyAudio ? 1 : 0}&codec=${encodeURIComponent(d.videoCodec)}&acodec=${encodeURIComponent(d.audioCodec)}`;
      return json(res, 200, { ...d, name: path.basename(f), lib: rel, url: d.mode === 'direct' ? direct : streamUrl, streamed: d.mode !== 'direct',
        fallbackUrl: '/stream' + encPath(rel) + `?mode=transcode&copyAudio=${d.copyAudio ? 1 : 0}` });
    }
    if (p.startsWith('/stream/')) {
      const f = safeJoin(MEDIA_DIR, url.pathname.slice('/stream'.length));
      if (!f) return json(res, 403, { error: 'Forbidden' });
      const q = url.searchParams;
      let child;
      try {
        child = media.stream(f, { mode: q.get('mode') === 'transcode' ? 'transcode' : 'remux', copyAudio: q.get('copyAudio') === '1', start: Math.max(0, +q.get('start') || 0), codec: q.get('codec') || '', audioCodec: q.get('acodec') || '', maxWidth: Math.max(0, Math.min(7680, +q.get('maxWidth') || 0)) });
      } catch (e) { return json(res, 500, { error: e.message }); }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', ...ISOLATION });
      child.stdout.pipe(res);
      const stop = () => child.kill('SIGKILL');
      req.on('close', stop);
      res.on('close', stop);
      return;
    }
    if (p === '/api/playlists') {
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (!Array.isArray(body)) return json(res, 400, { error: 'Expected an array' });
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        const tmp = PLAYLISTS_FILE() + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(body, null, 1));
        await fs.promises.rename(tmp, PLAYLISTS_FILE());
        return json(res, 200, { ok: true });
      }
      let list = [];
      try { list = JSON.parse(await fs.promises.readFile(PLAYLISTS_FILE(), 'utf8')); } catch { /* none yet */ }
      return json(res, 200, list);
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
  console.log(`  ffmpeg: ${media.findFfmpeg() || 'not found — only browser-native formats will play'}`);
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
