import { Renderer } from './gl.js';
import { XRPlayer } from './xr.js';
import { AIUpscaler } from './ai.js';
import { detectFormat, eyeAspect } from './detect.js';
import { Queue } from './queue.js';
import { parsePlaylist, isHlsPlaylist, groupsOf, looksLikeM3U, looksLikeList, isDashUrl, isStreamUrl } from './m3u.js';
import { perspective, multiply, invert, rotX, rotY } from './math.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = window.lumen || null;            // Electron bridge (absent when opened in a plain browser)
let server = null;                            // set when served by the Docker / NAS server edition
const android = window.LumenAndroid || null;  // Android app bridge
let API = '';                                 // base URL of the Lumen server API ('' = same origin)
const apiUrl = (p) => (p && p.startsWith('/') ? API + p : p);
// Android: the app relays everything under /server/ to your Lumen server, so requests stay same-origin.
function androidServerOrigin() {
  if (!android || !android.getServer()) return '';
  return '/server';
}
function androidServerHost() {
  try { return new URL(android.getServer()).host; } catch { return android.getServer(); }
}
const video = $('video');
const canvas = $('stage');

// ------------------------------------------------------------------------------------------------
// State
const DEFAULTS = {
  upscale: 'gpu', scale: 'auto', sharpness: 0.5, desktopStereo: 'left',
  aiApply: 'paused', tile: 256, backend: 'auto', fov: 90, volume: 1, muted: false, lastModel: '', gyro: true, speed: 1, slowSound: 'pitch', slowTipShown: false,
};
const S = Object.assign({}, DEFAULTS, load('lumen.settings', {}));
const F = { projection: 'flat', stereo: 'mono', swap: false };   // current file's format
let fileName = '';
let yaw = 0, pitch = 0;
let compare = false, splitPos = 0.5;
let dirty = true, newFrame = false;
let lastScale = 0;
const stats = { frames: 0, fps: 0, t0: performance.now(), aiMs: 0, aiTiles: 0 };

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
function persist() { save('lumen.settings', S); }

// ------------------------------------------------------------------------------------------------
// Renderer, XR, AI
let renderer;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  document.body.innerHTML = `<p style="padding:40px;font:16px system-ui;color:#fff">Could not start the renderer: ${e.message}</p>`;
  throw e;
}
const ai = new AIUpscaler();
const xr = new XRPlayer(renderer, {
  frame: () => processFrame(true),
  getView: () => viewParams(true),
  onSelect: () => togglePlay(),
  onEnd: () => { $('vrBtn').classList.remove('on'); toast('Left VR'); },
});
XRPlayer.supported().then((ok) => {
  $('vrBtn').disabled = !ok;
  $('vrBtn').title = ok ? 'Enter headset (V)' : 'No OpenXR headset / runtime detected';
});

// ------------------------------------------------------------------------------------------------
// Opening media
// ------------------------------------------------------------------------------------------------
// Playback source: direct file, or an FFmpeg stream (remux/transcode) with a "virtual" timeline.
// For streams, video.currentTime counts from the point the stream was started (cur.offset).
const cur = { item: null, info: null, url: '', offset: 0, streamed: false, duration: 0, retried: false, token: 0 };
const curTime = () => cur.offset + (video.currentTime || 0);
const totalTime = () => (cur.streamed ? cur.duration || 0 : (isFinite(video.duration) ? video.duration : cur.duration || 0));
const withStart = (url, t) => url + (url.includes('?') ? '&' : '?') + 'start=' + (cur.live ? 0 : t).toFixed(3) + (cur.maxWidth ? '&maxWidth=' + cur.maxWidth : '');
const isLive = () => !!cur.live || (!!cur.item && video.duration === Infinity);

function restartStream(t, play) {
  cur.offset = t;
  video.src = withStart(cur.url, t);
  video.load();
  resetHealth();
  video.addEventListener('loadeddata', () => { newFrame = true; if (play) video.play().catch(() => {}); }, { once: true });
  aiInvalidate();
}

function caps() {
  const ms = window.MediaSource;
  const ok = (t) => { try { return !!(ms && ms.isTypeSupported(t)) || video.canPlayType(t) === 'probably'; } catch { return false; } };
  return { hevc: ok('video/mp4; codecs="hvc1.1.6.L120.90"'), av1: ok('video/mp4; codecs="av01.0.08M.08"') };
}

// Playback health: catches files that "play" without a picture, conversions that can't keep up,
// and upscaling that is too heavy for the GPU — and fixes them automatically.
const health = { frames: 0, waits: [], lastDropped: 0, lastTotal: 0, badSeconds: 0, stepped: false, maxWidth: 0 };
function resetHealth() {
  Object.assign(health, { frames: 0, waits: [], badSeconds: 0, stepped: false });
  const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
  health.lastDropped = q ? q.droppedVideoFrames : 0;
  health.lastTotal = q ? q.totalVideoFrames : 0;
}

function checkHealth() {
  if (!cur.item || video.paused || video.seeking || video.readyState < 2) return;
  // 1. Audio/time runs but no video frames arrive (e.g. an HEVC/Dolby Vision MP4 the GPU can't decode)
  if (!cur.streamed && !cur.retried && video.currentTime > 2.5 && health.frames < 3 && 'requestVideoFrameCallback' in video) {
    toast('This video’s format isn’t supported by your graphics driver — converting it…', 3500);
    playItem(cur.item, { force: 'transcode', at: curTime() });
    return;
  }
  // 2. Too many dropped frames → lighten the load
  const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
  if (q) {
    const dd = q.droppedVideoFrames - health.lastDropped, dt = q.totalVideoFrames - health.lastTotal;
    health.lastDropped = q.droppedVideoFrames; health.lastTotal = q.totalVideoFrames;
    health.badSeconds = dt >= 10 && dd / dt > 0.15 ? health.badSeconds + 1 : 0;
    if (health.badSeconds >= 4 && !health.stepped) {
      health.stepped = true; health.badSeconds = 0;
      if (S.upscale === 'ai') { setUpscale('gpu'); toast('AI upscaling was too slow for live playback — switched to GPU upscaling', 4500); }
      else if (S.upscale === 'gpu') { S.upscale = 'off'; dirty = true; syncUI(); toast('Upscaling paused for this video: your graphics card couldn’t keep up (turn it back on with U)', 5000); }
    }
  }
}
setInterval(checkHealth, 1000);

// 3. A conversion that keeps buffering → restart it at a lower resolution
video.addEventListener('waiting', () => {
  if (!cur.streamed || !cur.info || cur.info.mode !== 'transcode' || video.seeking) return;
  const now = performance.now();
  health.waits = health.waits.filter((t) => now - t < 30000).concat(now);
  if (health.waits.length >= 3) {
    health.waits = [];
    const w = cur.maxWidth || (cur.info.encoder && cur.info.encoder !== 'libx264' ? 3840 : 1920);
    const next = w > 1920 ? 1920 : w > 1280 ? 1280 : w > 854 ? 854 : 0;
    if (!next) return;
    cur.maxWidth = next;
    toast(`Lowering conversion quality to ${Math.round(next * 9 / 16)}p so it plays smoothly`, 4000);
    restartStream(curTime(), !video.paused);
  }
});

/** Turn a queue item into something playable. */
async function prepareItem(item, force) {
  const c = caps();
  if (force) c.force = force;
  if (item.url && isStreamUrl(item.url) && !item.url.startsWith(location.origin)) return prepareStream(item.url, c, force);
  if (item.path && host && host.prepare) return host.prepare(item.path, c);
  if (item.lib && server) {
    const q = new URLSearchParams({ path: item.lib, hevc: c.hevc ? '1' : '0', av1: c.av1 ? '1' : '0' });
    const r = await fetch(apiUrl('/api/probe?' + q));
    if (!r.ok) return { error: (await r.json().catch(() => ({}))).error || 'Could not open ' + item.name };
    const info = await r.json();
    info.url = apiUrl(info.url);
    info.fallbackUrl = apiUrl(info.fallbackUrl);
    if (force === 'transcode') return { ...info, url: info.fallbackUrl, streamed: true, mode: 'transcode' };
    return info;
  }
  if (item.file) {
    if (!item.url) item.url = URL.createObjectURL(item.file);
    return { url: item.url, streamed: false, mode: 'direct' };
  }
  return { url: item.url, streamed: false, mode: 'direct' };
}

/** Live / network streams: desktop and server read them with FFmpeg; the Android app relays them itself. */
async function prepareStream(url, c, force) {
  if (host && host.prepare) return host.prepare(url, c);
  if (server) {
    const q = new URLSearchParams({ u: url, hevc: c.hevc ? '1' : '0', av1: c.av1 ? '1' : '0' });
    if (force) q.set('force', force);
    const r = await fetch(apiUrl('/api/probe?' + q));
    const info = await r.json().catch(() => ({}));
    if (!r.ok) return { error: info.error || 'Could not open that stream' };
    info.url = apiUrl(info.url);
    info.fallbackUrl = apiUrl(info.fallbackUrl);
    return info;
  }
  if (android) {
    if (!/^https?:/i.test(url)) return { error: 'RTSP, RTMP, MMS, UDP, SRT and RIST streams play through your Lumen server. Connect to it first (Settings → Server).' };
    if (isDashUrl(url)) return { error: 'DASH (.mpd) streams play through your Lumen server. Connect to it first (Settings → Server).' };
    // The app's relay fetches the stream and rewrites HLS playlists so every segment stays same-origin.
    const hls = looksLikeM3U(url);
    return { url: `/proxy/${hls ? 'live.m3u8' : 'media'}?url=${encodeURIComponent(url)}`, streamed: false, mode: 'direct', live: hls, native: true };
  }
  return { url, streamed: false, mode: 'direct', native: true };
}

/** Text of an M3U list from anywhere: a link, a local file, the server library or a file picked on this device. */
async function fetchListText(item) {
  if (item.file) return { text: await item.file.text(), base: '' };
  if (item.path && host) {
    const r = await host.readText(item.path);
    if (r.error) throw new Error(r.error);
    return { text: r.text, base: '', dir: r.dir, sep: r.sep };
  }
  if (item.lib && server) {
    const r = await fetch(apiUrl('/media' + item.lib.split('/').map(encodeURIComponent).join('/')));
    if (!r.ok) throw new Error('Could not read ' + item.name);
    return { text: await r.text(), base: '', libDir: item.lib.split('/').slice(0, -1).join('/') };
  }
  const url = item.url;
  if (host) { const r = await host.fetchText(url); if (r.error) throw new Error(r.error); return { text: r.text, base: r.finalUrl || url }; }
  if (server) {
    const r = await fetch(apiUrl('/api/fetch-text?u=' + encodeURIComponent(url)));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not download the list');
    return { text: j.text, base: j.finalUrl || url };
  }
  if (android) {
    const r = await fetch('/proxy/list.m3u?url=' + encodeURIComponent(url));
    if (!r.ok) throw new Error('Could not download the list');
    return { text: await r.text(), base: url };
  }
  const r = await fetch(url);
  return { text: await r.text(), base: url };
}

/** An .m3u/.m3u8 item: either an HLS stream (play it) or a channel list (browse it). Returns true when handled as a list. */
async function openM3U(item) {
  let res;
  try { res = await fetchListText(item); } catch (e) {
    // Couldn't read it as text (e.g. the server only answers players): try it as a stream.
    if (item.url) return false;
    toast(e.message, 5000);
    return true;
  }
  if (isHlsPlaylist(res.text)) return false;            // a single stream: play it
  let items = parsePlaylist(res.text, res.base);
  // Entries relative to a local list file → files next to it.
  items = (await Promise.all(items.map(async (it) => {
    if (isStreamUrl(it.url)) return { name: it.name, url: it.url, group: it.group, logo: it.logo };
    if (res.dir && host) {
      const isAbs = /^([a-z]:[\\/]|[\\/])/i.test(it.url);
      const p = isAbs ? it.url : res.dir + res.sep + it.url.replace(/[\\/]/g, res.sep);
      return (await host.allowPath(decodeURIComponent(p))) ? { name: it.name, path: decodeURIComponent(p), group: it.group } : null;
    }
    if (res.libDir !== undefined && server) return { name: it.name, lib: (res.libDir + '/' + it.url).replace(/\/+/g, '/'), group: it.group };
    return null;                                          // relative entry we can't resolve here
  }))).filter(Boolean);
  if (!items.length) { toast('No playable entries found in ' + item.name, 5000); return true; }
  openChannels(items, item.name.replace(/\.(m3u8?|pls|xspf|asx|wax|wvx)$/i, ''));
  return true;
}

async function playItem(item, { autoplay = true, force = null, at = 0 } = {}) {
  if (!item) return;
  if (!item.hls && !force && looksLikeList(item.path || item.lib || item.url || item.name)) {
    const isList = await openM3U(item);
    if (isList) {
      const i = queue.items.indexOf(item);
      if (i >= 0) queue.remove(i);
      return;
    }
    item.hls = true;
  }
  if (isStreamUrl(item.url) && !item.hls) toast('Connecting to stream…', 2500);
  const token = ++cur.token;
  fileName = item.name || 'video';
  $('title').textContent = fileName;
  document.body.classList.add('loaded');
  const info = await prepareItem(item, force);
  if (token !== cur.token) return;                    // another item was chosen meanwhile
  if (!info || info.error || !info.url) { toast(info && info.error ? info.error : 'Could not open ' + fileName, 5000); return; }
  Object.assign(cur, { item, info, url: info.url, offset: 0, streamed: !!info.streamed, duration: info.live ? 0 : info.duration || 0, retried: !!force, maxWidth: 0, live: !!info.live });
  if (cur.live) at = 0;
  if (info.mode && info.mode !== 'direct' && !force) toast(info.mode === 'transcode' ? `Converting ${info.videoCodec || 'video'} for playback…` : 'Preparing ' + (info.reason || 'video') + '…', 2500);
  if (cur.streamed) cur.offset = at;
  const crossOrigin = /^https?:/i.test(cur.url) && !cur.url.startsWith(location.origin);
  if (crossOrigin) video.crossOrigin = 'anonymous'; else video.removeAttribute('crossorigin');
  video.src = cur.streamed ? withStart(cur.url, at) : cur.url;
  video.load();
  resetHealth();
  if (!cur.streamed && at) video.addEventListener('loadedmetadata', () => { video.currentTime = at; }, { once: true });
  aiInvalidate();
  yaw = 0; pitch = 0;
  resetZoom(false);
  video.addEventListener('loadedmetadata', () => {
    if (token !== cur.token) return;
    const remembered = load('lumen.fmt.' + fileName, null);
    Object.assign(F, remembered || detectFormat(fileName, video.videoWidth, video.videoHeight, info));
    syncUI();
    if (autoplay) video.play().catch(() => { /* autoplay may need a click */ });
  }, { once: true });
  renderQueue();
  saveQueueState();
  addRecent(item);
}

/** Seek on the full-length timeline, restarting the FFmpeg stream when needed. */
function seekTo(t) {
  if (isLive()) return;                                  // live streams can't be scrubbed
  const d = totalTime();
  t = Math.max(0, d ? Math.min(d - 0.05, t) : t);
  if (!cur.streamed) { video.currentTime = t; return; }
  const rel = t - cur.offset;
  for (let i = 0; i < video.buffered.length; i++) {
    if (rel >= video.buffered.start(i) && rel <= video.buffered.end(i) - 0.2) { video.currentTime = rel; return; }
  }
  restartStream(t, !video.paused);
}

// ------------------------------------------------------------------------------------------------
// Queue, repeat, shuffle, playlists
const queue = new Queue();
queue.restore(load('lumen.queue', null));
queue.onchange = () => { renderQueue(); saveQueueState(); syncPlaylistButtons(); };
function saveQueueState() { save('lumen.queue', queue); }

function playIndex(i, opts) { const it = queue.select(i); if (it) playItem(it, opts); }
function playNext(auto = false) {
  const i = queue.nextIndex(auto);
  if (i < 0) { if (!auto) toast('End of queue'); return false; }
  if (i === queue.index && auto) { seekTo(0); video.play().catch(() => {}); return true; }
  playIndex(i);
  return true;
}
function playPrev() {
  if (curTime() > 3 || queue.items.length < 2) { seekTo(0); return; }
  const i = queue.prevIndex();
  if (i >= 0 && i !== queue.index) playIndex(i); else seekTo(0);
}
video.addEventListener('ended', () => {
  if (playNext(true)) return;
  video.pause();
  savePosition();
  if (document.fullscreenElement && android) document.exitFullscreen().catch(() => {});
  $('endName').textContent = cur.item ? cur.item.name : '';
  $('endCard').hidden = false;
  wake();
});
function hideEndCard() { $('endCard').hidden = true; }
for (const ev of ['play', 'seeking', 'emptied']) video.addEventListener(ev, hideEndCard);

/** Add items; play the first one now unless told otherwise. */
function addAndPlay(items, { play = true, next = false } = {}) {
  if (!items.length) return;
  const at = queue.add(items, { after: next || (play && queue.index >= 0) });
  if (play) playIndex(at);
  else toast(items.length === 1 ? `Added “${items[0].name}” to the queue` : `Added ${items.length} videos to the queue`);
}

// Kept for the desktop bridge, file associations and tests: { name, path } or { name, url }
async function openPayload(p) {
  if (!p) return;
  addAndPlay([{ name: p.name, path: p.path, url: p.path ? undefined : p.url, lib: p.lib }], { play: !p.enqueue });
}

async function itemsFromFiles(files) {
  const out = [];
  for (const f of files) {
    if (host && host.registerDroppedFile) {
      const p = await host.registerDroppedFile(f);
      if (p) { out.push({ name: p.name, path: p.path }); continue; }
    }
    out.push({ name: f.name, file: f });
  }
  return out;
}

let addMode = false;   // file picker / library used for "Add videos" instead of "play"
async function openDialog(add = false) {
  addMode = add;
  if (host) {
    const list = await host.openVideoDialog();
    if (list && list.length) addAndPlay(list.map((p) => ({ name: p.name, path: p.path })), { play: !add });
  } else if (server) openLibrary();
  else $('fileInput').click();
}

$('fileInput').addEventListener('change', async (e) => {
  const items = await itemsFromFiles([...e.target.files]);
  e.target.value = '';
  addAndPlay(items, { play: !addMode });
  addMode = false;
});
$('openBtn').onclick = () => openDialog(false);
if (host) {
  host.onOpenFile(openPayload);
  host.onShowHelp(() => { $('help').hidden = false; });
}

video.addEventListener('error', () => {
  const err = video.error;
  if (!cur.item || !video.getAttribute('src')) return;
  // The browser refused the file: retry once through FFmpeg conversion when we can.
  if (cur.info && cur.info.native && cur.item.url && !cur.retried) {
    toast('This stream could not be played on this device. Connect to your Lumen server to play it through FFmpeg.', 7000);
    return;
  }
  if (!cur.retried && ((host && (cur.item.path || isStreamUrl(cur.item.url))) || (server && (cur.item.lib || isStreamUrl(cur.item.url)))) && (!cur.info || cur.info.ffmpeg !== false)) {
    toast('Converting this video for playback…', 2500);
    playItem(cur.item, { force: 'transcode', at: curTime() });
    return;
  }
  toast(err && err.code === 4
    ? (host || server ? 'This file could not be played or converted.' : 'This format needs the desktop app or the server edition (they convert MKV, AVI, WMV…).')
    : 'Could not play this file.', 6000);
});

// Drag & drop (several files at once go into the queue)
let dragDepth = 0;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', (e) => { if (!isFileDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
  const files = [...e.dataTransfer.files];
  const model = files.find((f) => f.name.toLowerCase().endsWith('.onnx'));
  if (model) return loadModelFile(model);
  const items = await itemsFromFiles(files);
  addAndPlay(items, { play: !cur.item || video.paused || video.ended });
});

// ------------------------------------------------------------------------------------------------
// Frame tracking
function watchFrames() {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
  const cb = () => { newFrame = true; health.frames++; video.requestVideoFrameCallback(cb); };
  video.requestVideoFrameCallback(cb);
}
watchFrames();
for (const ev of ['loadeddata', 'seeked']) video.addEventListener(ev, () => { newFrame = true; });
for (const ev of ['play', 'seeking']) video.addEventListener(ev, () => { if (S.aiApply === 'paused') aiInvalidate(); });

// ------------------------------------------------------------------------------------------------
// Rendering
const MODE = { flat: 0, equi360: 1, equi180: 2, fisheye180: 3 };
const STEREO = { mono: 0, sbs: 1, tb: 2 };

function autoScale(inXR) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return 1;
  const eyeW = F.stereo === 'sbs' ? vw / 2 : vw;
  const eyeH = F.stereo === 'tb' ? vh / 2 : vh;
  let r;
  if (inXR) r = 2;
  else if (F.projection === 'flat') r = flatRect()[2] / eyeW;
  else r = (canvas.height / (S.fov * Math.PI / 180)) / (eyeH / Math.PI);  // screen px per radian ÷ source px per radian
  return Math.min(F.projection === 'flat' ? 4 : 3, Math.max(1, Math.round(r * 4) / 4));
}

function processFrame(inXR) {
  if (newFrame || (!('requestVideoFrameCallback' in video) && !video.paused)) {
    if (renderer.uploadVideo(video)) { dirty = true; stats.frames++; }
    newFrame = false;
  }
  const scale = S.upscale === 'off' ? 1 : (S.scale === 'auto' ? autoScale(inXR) : +S.scale);
  if (scale !== lastScale) { lastScale = scale; dirty = true; }
  if (!dirty) return;
  dirty = false;
  renderer.process({
    useAI: S.upscale === 'ai' && aiValid,
    enhance: S.upscale !== 'off',
    scale,
    sharpness: S.sharpness,
  });
}

// 2D zoom & pan. (zu, zv) = the point of the video (0..1, v measured from the bottom) shown at the
// centre of the screen; zoom = 1 fits the whole video.
const ZOOM_MAX = 8;
let zoom = 1, zu = 0.5, zv = 0.5;

function fitRect() {
  const cw = canvas.width, ch = canvas.height;
  const a = eyeAspect(video.videoWidth, video.videoHeight, F.stereo);
  let w = cw, h = cw / a;
  if (h > ch) { h = ch; w = ch * a; }
  return [w, h];
}

function flatRect() {
  const cw = canvas.width, ch = canvas.height;
  const [bw, bh] = fitRect();
  const w = bw * zoom, h = bh * zoom;
  let x = cw / 2 - zu * w, y = ch / 2 - zv * h;
  // Keep the picture covering the screen while zoomed (no empty gaps), centred when smaller.
  x = w <= cw ? (cw - w) / 2 : Math.min(0, Math.max(cw - w, x));
  y = h <= ch ? (ch - h) / 2 : Math.min(0, Math.max(ch - h, y));
  return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
}

function setRectPos(x, y, w, h) {   // store a rect position back as (zu, zv), clamped by flatRect()
  zu = (canvas.width / 2 - x) / w;
  zv = (canvas.height / 2 - y) / h;
  const [cx, cy] = flatRect();
  zu = (canvas.width / 2 - cx) / w;
  zv = (canvas.height / 2 - cy) / h;
}

/** Zoom by a factor, keeping the video point under (px, py) — CSS pixels — fixed on screen. */
function zoomAt(factor, px = canvas.clientWidth / 2, py = canvas.clientHeight / 2) {
  if (!video.videoWidth) return;
  const dpr = canvas.width / canvas.clientWidth;
  const mx = px * dpr, my = canvas.height - py * dpr;          // GL coordinates (y up)
  const [x, y, w, h] = flatRect();
  const pu = (mx - x) / w, pv = (my - y) / h;                     // video point under the cursor
  const nz = Math.max(1, Math.min(ZOOM_MAX, zoom * factor));
  if (nz === zoom) return;
  zoom = nz;
  const [bw, bh] = fitRect();
  const nw = bw * zoom, nh = bh * zoom;
  setRectPos(mx - pu * nw, my - pv * nh, nw, nh);
  if (zoom < 1.01) resetZoom(false);
  showZoom();
}

function panBy(dxCss, dyCss) {
  if (zoom <= 1) return;
  const dpr = canvas.width / canvas.clientWidth;
  const [x, y, w, h] = flatRect();
  setRectPos(x + dxCss * dpr, y - dyCss * dpr, w, h);
}

function resetZoom(announce = true) {
  zoom = 1; zu = 0.5; zv = 0.5;
  showZoom();
  if (announce) toast('Zoom reset');
}

function showZoom() {
  const chip = $('zoomChip');
  const on = F.projection === 'flat' && zoom > 1.01;
  chip.hidden = !on;
  chip.textContent = `${Math.round(zoom * 100)}%  ✕`;
  document.body.classList.toggle('zoomed', on);
}

function viewParams(inXR) {
  const a = eyeAspect(video.videoWidth, video.videoHeight, F.stereo);
  const screenHalfW = 2.2;
  return {
    mode: F.projection === 'flat' ? (inXR ? 4 : 0) : MODE[F.projection],
    stereo: STEREO[F.stereo],
    swap: F.swap,
    screen: [screenHalfW, screenHalfW / a, 3.4],
    fisheyeFov: Math.PI,
  };
}


// ------------------------------------------------------------------------------------------------
// Phones & tablets: look around 360°/180° videos by moving the device ("magic window").
let gyroQ = null, gyroYaw0 = null, gyroSeen = false;
function quatFromDevice(alpha, beta, gamma, orient) {
  const d = Math.PI / 180;
  const x = beta * d, y = alpha * d, z = -gamma * d;              // Euler order YXZ (same as three.js)
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  let q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
  const mul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  q = mul(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);                  // camera looks out of the back of the device
  const o = -orient * d / 2;
  return mul(q, [0, 0, Math.sin(o), Math.cos(o)]);                  // screen rotation
}
function quatToMat([x, y, z, w]) {
  const m = new Float32Array(16);
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y);
  m[15] = 1;
  return m;
}
function gyroMatrix() {
  if (!gyroQ || !S.gyro || F.projection === 'flat') return null;
  const m = quatToMat(gyroQ);
  if (gyroYaw0 === null) gyroYaw0 = Math.atan2(m[8], m[10]);         // start facing the video's front
  return multiply(rotY(-gyroYaw0), m);
}
window.addEventListener('deviceorientation', (e) => {
  if (e.alpha == null) return;
  const orient = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  gyroQ = quatFromDevice(e.alpha, e.beta, e.gamma, orient);
  if (!gyroSeen) { gyroSeen = true; $('gyroRow').hidden = false; }
});

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
}

function drawDesktop() {
  const cw = canvas.width, ch = canvas.height;
  const P = perspective(S.fov * Math.PI / 180, cw / ch);
  const R = gyroMatrix();
  const V = R ? invert(multiply(rotY(yaw), R)) : multiply(rotX(-pitch), rotY(-yaw));
  const view = viewParams(false);
  renderer.draw({
    ...view,
    viewport: [0, 0, cw, ch],
    eye: 0,
    anaglyph: S.desktopStereo === 'anaglyph',
    invVP: invert(multiply(P, V)),
    flatRect: flatRect(),
    split: compare && S.upscale !== 'off' ? Math.round(cw * splitPos) : null,
  });
}

function loop(now) {
  requestAnimationFrame(loop);
  if (xr.active) return;          // the headset drives its own frame loop
  resize();
  processFrame(false);
  drawDesktop();
  updateTimeline();
  if (now - stats.t0 > 1000) {
    stats.fps = stats.frames * 1000 / (now - stats.t0);
    stats.frames = 0; stats.t0 = now;
    if (!$('stats').hidden) renderStats();
    updateUpBadge();
  }
}
requestAnimationFrame(loop);

// ------------------------------------------------------------------------------------------------
// AI super-resolution
let aiValid = false, aiFrameTime = -1, aiRunning = false, aiGen = 0;

function aiInvalidate() {
  aiGen++;
  aiFrameTime = -1;
  if (aiValid) { aiValid = false; dirty = true; }
}

async function aiLoop() {
  if (aiRunning) return;
  aiRunning = true;
  try {
    while (S.upscale === 'ai' && ai.ready) {
      const t = video.currentTime;
      const live = S.aiApply === 'live';
      const want = video.readyState >= 2 && !video.seeking && video.videoWidth && (live ? (!video.paused || aiFrameTime !== t) : (video.paused && aiFrameTime !== t));
      if (!want) { await sleep(40); continue; }
      const gen = aiGen;
      const vw = video.videoWidth, vh = video.videoHeight;
      const plan = ai.plan(vw, vh, renderer.maxTex);
      const progressive = !live;
      let full = null;
      if (progressive) {
        renderer.ensureAITexture(plan.outW, plan.outH);
        seedAIFromVideo();                      // bilinear preview, then tiles replace it
        aiValid = true; dirty = true;
      } else {
        full = new Uint8Array(plan.outW * plan.outH * 4);
      }
      setAIStatus(`Upscaling ${vw}×${vh} → ${plan.outW}×${plan.outH}…`, '');
      let res;
      try {
        res = await ai.upscale(video, vw, vh, {
          maxOut: renderer.maxTex,
          tile: S.tile,
          shouldAbort: () => gen !== aiGen || S.upscale !== 'ai',
          onTile: (x, y, w, h, rgba) => {
            if (progressive) { renderer.uploadAIRegion(x, y, w, h, rgba); dirty = true; }
            else for (let r = 0; r < h; r++) full.set(rgba.subarray(r * w * 4, (r + 1) * w * 4), ((y + r) * plan.outW + x) * 4);
          },
        });
      } catch (e) {
        setAIStatus('AI error: ' + (e.message || e), 'err');
        S.upscale = 'gpu'; syncUI(); persist();
        break;
      }
      if (res.aborted) continue;
      if (!progressive) {
        if (gen !== aiGen) continue;
        renderer.ensureAITexture(plan.outW, plan.outH);
        renderer.uploadAIRegion(0, 0, plan.outW, plan.outH, full);
        aiValid = true; dirty = true;
      }
      aiFrameTime = t;
      stats.aiMs = res.ms; stats.aiTiles = res.tiles;
      setAIStatus(`${ai.modelName} · ${ai.scale}× · ${ai.backend}\nLast frame: ${vw}×${vh} → ${res.outW}×${res.outH} in ${(res.ms / 1000).toFixed(2)} s (${res.tiles} tiles)`, 'ok');
    }
  } finally {
    aiRunning = false;
  }
}

function seedAIFromVideo() {
  const gl = renderer.gl;
  renderer.uploadVideo(video);
  const rf = gl.createFramebuffer(), df = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rf);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, renderer.videoTex, 0);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, df);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, renderer.aiTex, 0);
  gl.blitFramebuffer(0, 0, renderer.videoW, renderer.videoH, 0, 0, renderer.aiW, renderer.aiH, gl.COLOR_BUFFER_BIT, gl.LINEAR);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.deleteFramebuffer(rf); gl.deleteFramebuffer(df);
}

function setAIStatus(text, cls) {
  const el = $('aiStatus');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

async function loadModel(src, name) {
  setAIStatus(`Loading ${name}…`, '');
  toast(`Loading AI model ${name}…`);
  try {
    const info = await ai.loadModel(src, name, S.backend);
    aiInvalidate();
    setAIStatus(`${name} · ${info.scale}× · ${info.backend}${info.fixed ? ` · fixed ${info.fixed[1]}×${info.fixed[0]} input` : ''}\nReady.`, 'ok');
    toast(`AI model ready (${info.scale}×, ${info.backend})`);
    if (typeof src === 'string') { S.lastModel = src; persist(); }
    refreshModelList(typeof src === 'string' ? src : '');
    if (S.upscale !== 'ai') { S.upscale = 'ai'; syncUI(); persist(); }
    aiLoop();
    return true;
  } catch (e) {
    console.error(e);
    setAIStatus('Could not load model: ' + (e.message || e), 'err');
    toast('Could not load AI model', 4000);
    return false;
  }
}

async function loadModelFile(file) {
  return loadModel(new Uint8Array(await file.arrayBuffer()), file.name);
}

async function browseModel() {
  if (host) {
    const m = await host.openModelDialog();
    if (m) loadModel(m.url, m.name);
  } else $('modelInput').click();
}
$('modelInput').addEventListener('change', (e) => { loadModelFile(e.target.files[0]); e.target.value = ''; });
$('modelBrowse').onclick = browseModel;
$('emptyModelBtn').onclick = browseModel;
$('modelFolder').onclick = () => (host ? host.openModelsFolder() : toast('Models folder is available in the desktop app'));
$('modelFolder').hidden = !host;

async function listModels() {
  if (host) return host.listModels();
  if (server) { try { return (await (await fetch(apiUrl('/api/models'))).json()).map((m) => ({ ...m, url: apiUrl(m.url) })); } catch { return []; } }
  return [];
}

async function refreshModelList(selectUrl = S.lastModel) {
  const sel = $('modelSel');
  const list = await listModels();
  sel.innerHTML = '';
  sel.append(new Option(ai.ready ? `${ai.modelName} (loaded)` : '— none loaded —', ''));
  for (const m of list) sel.append(new Option(m.name, m.url));
  if (selectUrl && list.some((m) => m.url === selectUrl)) sel.value = selectUrl;
}
$('modelSel').onchange = (e) => { const o = e.target.selectedOptions[0]; if (e.target.value) loadModel(e.target.value, o.textContent); };
refreshModelList();

async function ensureAI() {
  if (ai.ready) { aiLoop(); return true; }
  const list = await listModels();
  const last = list.find((m) => m.url === S.lastModel);
  if (last) return loadModel(last.url, last.name);
  if (S.lastModel && host) return loadModel(S.lastModel, decodeURIComponent(S.lastModel.split('%2F').pop().split('%5C').pop()));
  if (list.length) return loadModel(list[0].url, list[0].name);
  setAIStatus('Choose an ONNX super-resolution model to enable AI upscaling (see README for recommended models).', 'err');
  $('panel').hidden = false;
  toast('Load an AI model first — Settings → AI model → Browse…', 4500);
  return false;
}

// ------------------------------------------------------------------------------------------------
// UI
const FORMATS = [
  { label: '2D', projection: 'flat', stereo: 'mono' },
  { label: '3D side-by-side', projection: 'flat', stereo: 'sbs' },
  { label: '3D top-bottom', projection: 'flat', stereo: 'tb' },
  'sep',
  { label: '360°', projection: 'equi360', stereo: 'mono' },
  { label: '360° 3D top-bottom', projection: 'equi360', stereo: 'tb' },
  { label: '360° 3D side-by-side', projection: 'equi360', stereo: 'sbs' },
  'sep',
  { label: '180° 3D side-by-side', projection: 'equi180', stereo: 'sbs' },
  { label: '180° 3D top-bottom', projection: 'equi180', stereo: 'tb' },
  { label: '180° mono', projection: 'equi180', stereo: 'mono' },
  { label: 'Fisheye 180° 3D SBS', projection: 'fisheye180', stereo: 'sbs' },
];
function fmtLabel() {
  const f = FORMATS.find((x) => x !== 'sep' && x.projection === F.projection && x.stereo === F.stereo);
  return f ? f.label.replace('side-by-side', 'SBS').replace('top-bottom', 'TB') : 'Custom';
}
const UPS = [
  { v: 'off', label: 'Off', sub: 'bilinear' },
  { v: 'gpu', label: 'GPU upscale', sub: 'real-time' },
  { v: 'ai', label: 'AI super-resolution', sub: 'ONNX model' },
];

function buildPops() {
  const fp = $('fmtPop');
  fp.innerHTML = '<div class="head">Video format</div>';
  for (const f of FORMATS) {
    if (f === 'sep') { fp.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.innerHTML = `<span>${f.label}</span>`;
    b.classList.toggle('sel', f.projection === F.projection && f.stereo === F.stereo);
    b.onclick = () => { setFormat({ projection: f.projection, stereo: f.stereo }); closePops(); };
    fp.append(b);
  }
  fp.append(document.createElement('hr'));
  const auto = document.createElement('button');
  auto.innerHTML = '<span>Auto-detect</span><small>from filename</small>';
  auto.onclick = () => { localStorage.removeItem('lumen.fmt.' + fileName); setFormat(detectFormat(fileName, video.videoWidth, video.videoHeight), false); closePops(); };
  fp.append(auto);

  const up = $('upPop');
  up.innerHTML = '<div class="head">Upscaling</div>';
  for (const u of UPS) {
    const b = document.createElement('button');
    b.innerHTML = `<span>${u.label}</span><small>${u.sub}</small>`;
    b.classList.toggle('sel', S.upscale === u.v);
    b.onclick = () => { setUpscale(u.v); closePops(); };
    up.append(b);
  }
  up.append(document.createElement('hr'));
  const more = document.createElement('button');
  more.innerHTML = '<span>More settings…</span>';
  more.onclick = () => { closePops(); $('panel').hidden = false; };
  up.append(more);
}

function closePops() { $('fmtPop').hidden = true; $('upPop').hidden = true; }
$('fmtBtn').onclick = (e) => { e.stopPropagation(); const h = $('fmtPop').hidden; closePops(); buildPops(); $('fmtPop').hidden = !h; };
$('upBtn').onclick = (e) => { e.stopPropagation(); const h = $('upPop').hidden; closePops(); buildPops(); $('upPop').hidden = !h; };
document.addEventListener('click', (e) => { if (!e.target.closest('.pop-wrap')) closePops(); });

function setFormat(f, remember = $('rememberChk').checked) {
  Object.assign(F, f);
  if (f.swap === undefined) F.swap = $('swapChk').checked;
  if (remember && fileName) save('lumen.fmt.' + fileName, F);
  yaw = 0; pitch = 0; dirty = true;
  resetZoom(false);
  syncUI();
  toast(fmtLabel());
}

async function setUpscale(v) {
  S.upscale = v; persist(); dirty = true;
  syncUI();
  if (v === 'ai') {
    const ok = await ensureAI();
    if (!ok) { S.upscale = 'gpu'; syncUI(); persist(); }
  } else aiInvalidate();
  toast('Upscaling: ' + UPS.find((u) => u.v === S.upscale).label);
}

function syncUI() {
  $('projSel').value = F.projection;
  $('stereoSel').value = F.stereo;
  $('swapChk').checked = !!F.swap;
  $('deskStereoSel').value = S.desktopStereo;
  $('upSel').value = S.upscale;
  $('scaleSel').value = String(S.scale);
  $('sharpRange').value = S.sharpness;
  $('sharpOut').textContent = Math.round(S.sharpness * 100) + '%';
  $('aiApplySel').value = S.aiApply;
  $('tileSel').value = String(S.tile);
  $('backendSel').value = S.backend;
  $('fovRange').value = S.fov;
  $('fovOut').textContent = S.fov + '°';
  $('fmtLabel').textContent = fmtLabel();
  $('fmtBadge').textContent = video.videoWidth ? `${video.videoWidth}×${video.videoHeight} · ${fmtLabel()}` : '';
  $('upLabel').textContent = { off: 'Off', gpu: 'GPU', ai: 'AI' }[S.upscale];
  $('upBtn').classList.toggle('on', S.upscale !== 'off');
  $('cmpBtn').classList.toggle('on', compare);
  $('compareLabels').hidden = !(compare && S.upscale !== 'off');
  document.body.classList.toggle('vr', F.projection !== 'flat');
  video.volume = S.volume; video.muted = S.muted;
  $('volume').value = S.muted ? 0 : S.volume;
  $('muteBtn').innerHTML = `<svg><use href="#i-${S.muted || S.volume === 0 ? 'mute' : 'vol'}"/></svg>`;
  updateUpBadge();
}

function updateUpBadge() {
  const s = lastScale || 1;
  $('upBadge').textContent = S.upscale === 'off' ? '' : S.upscale === 'ai'
    ? (aiValid ? `AI ${ai.scale}×` : (ai.ready ? 'AI · GPU preview' : 'AI (no model)'))
    : `GPU ${s}×`;
}

$('projSel').onchange = (e) => setFormat({ projection: e.target.value, stereo: F.stereo });
$('stereoSel').onchange = (e) => setFormat({ projection: F.projection, stereo: e.target.value });
$('swapChk').onchange = (e) => setFormat({ projection: F.projection, stereo: F.stereo, swap: e.target.checked });
$('deskStereoSel').onchange = (e) => { S.desktopStereo = e.target.value; persist(); };
$('upSel').onchange = (e) => setUpscale(e.target.value);
$('scaleSel').onchange = (e) => { S.scale = e.target.value === 'auto' ? 'auto' : +e.target.value; persist(); dirty = true; };
$('sharpRange').oninput = (e) => { S.sharpness = +e.target.value; $('sharpOut').textContent = Math.round(S.sharpness * 100) + '%'; persist(); dirty = true; };
$('aiApplySel').onchange = (e) => { S.aiApply = e.target.value; persist(); aiInvalidate(); };
$('tileSel').onchange = (e) => { S.tile = +e.target.value; persist(); aiInvalidate(); };
$('backendSel').onchange = (e) => { S.backend = e.target.value; persist(); toast('Reload the model to apply the new backend'); };
$('fovRange').oninput = (e) => { S.fov = +e.target.value; $('fovOut').textContent = S.fov + '°'; persist(); };
$('recenterBtn').onclick = recenter;
$('gyroChk').checked = S.gyro;
$('gyroChk').onchange = (e) => { S.gyro = e.target.checked; gyroYaw0 = null; persist(); };
$('zoomChip').onclick = () => resetZoom();
$('statsBtn').onclick = toggleStats;
$('helpBtn').onclick = () => { $('help').hidden = false; };
$('helpClose').onclick = () => { $('help').hidden = true; };
$('help').onclick = (e) => { if (e.target.id === 'help') $('help').hidden = true; };
$('gearBtn').onclick = () => { $('panel').hidden = !$('panel').hidden; };
$('homeGear').onclick = () => { $('panel').hidden = !$('panel').hidden; };
$('panelClose').onclick = () => { $('panel').hidden = true; };

// Transport
function togglePlay() {
  if (!document.body.classList.contains('loaded') && cur.item) return resumePlayer();
  if (!video.getAttribute('src')) {
    if (queue.items.length) return playIndex(queue.index >= 0 ? queue.index : queue.nextIndex());
    return openDialog();
  }
  if (video.paused) video.play(); else video.pause();
}
function seekBy(s) { if (totalTime()) seekTo(curTime() + s); }
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
// The chosen speed sticks: it carries over to the next video (and stream restarts after seeking),
// and is remembered for next time. defaultPlaybackRate is what the browser applies to each new video.
function applySpeed(v, announce = false) {
  v = SPEEDS.includes(+v) ? +v : 1;
  S.speed = v;
  video.defaultPlaybackRate = v;
  video.playbackRate = v;
  $('speedBtn').textContent = v + '×';
  $('speedBtn').classList.toggle('on', v !== 1);
  $('speedSel').value = String(v);
  persist();
  if (announce) { toast(`Speed ${v}×`); maybeSlowTip(v); }
}
// How sound behaves at other speeds:
//  'pitch'  – keep voices at normal pitch (the engine time-stretches the audio; can sound warbly when slowed a lot)
//  'smooth' – play the sound slowed down like slow motion: no artifacts, but voices get deeper (higher when sped up)
function applySlowSound(mode) {
  S.slowSound = mode === 'smooth' ? 'smooth' : 'pitch';
  video.preservesPitch = S.slowSound === 'pitch';
  if ('mozPreservesPitch' in video) video.mozPreservesPitch = video.preservesPitch;
  $('slowSoundSel').value = S.slowSound;
  persist();
}
function maybeSlowTip(v) {
  if (v < 1 && S.slowSound === 'pitch' && !S.slowTipShown) {
    S.slowTipShown = true;
    persist();
    setTimeout(() => toast('Sound warbly when slowed down? Settings → Playback → Sound: “Smooth”', 6000), 1200);
  }
}
function setSpeed(dir) {
  const i = Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(S.speed) + dir));
  applySpeed(SPEEDS[i], true);
}
// Some engines reset the rate when a new source loads; put the chosen speed back.
video.addEventListener('loadedmetadata', () => { if (video.playbackRate !== S.speed) video.playbackRate = S.speed; });
video.addEventListener('play', () => { if (video.playbackRate !== S.speed) video.playbackRate = S.speed; });
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
}
document.addEventListener('fullscreenchange', () => {
  if (!android) return;
  const wide = !video.videoWidth || F.projection !== 'flat' || eyeAspect(video.videoWidth, video.videoHeight, F.stereo) >= 1.1;
  android.setLandscape(!!document.fullscreenElement && wide);
});
if (android) {
  video.addEventListener('play', () => android.keepScreenOn(true));
  for (const ev of ['pause', 'ended']) video.addEventListener(ev, () => android.keepScreenOn(false));
}
function recenter() { yaw = 0; pitch = 0; gyroYaw0 = null; if (zoom > 1) resetZoom(false); if (xr.active) xr.recenter(); }
function toggleStats() { $('stats').hidden = !$('stats').hidden; renderStats(); }
async function toggleVR() {
  if (xr.active) return xr.exit();
  if ($('vrBtn').disabled) return toast('No VR headset detected. Start SteamVR / Quest Link / your OpenXR runtime, then restart the app.', 5000);
  try {
    await xr.enter();
    $('vrBtn').classList.add('on');
    dirty = true;
    toast('In VR — trigger: play/pause · grip: recenter');
  } catch (e) { toast('Could not start VR: ' + e.message, 5000); }
}
function stepFrame(dir) {
  if (!video.paused) video.pause();
  seekBy(dir / 30);
}

$('playBtn').onclick = togglePlay;
$('backBtn').onclick = () => seekBy(-10);
$('fwdBtn').onclick = () => seekBy(10);
$('fullBtn').onclick = toggleFullscreen;
$('vrBtn').onclick = toggleVR;
$('cmpBtn').onclick = () => { compare = !compare; if (compare && S.upscale === 'off') setUpscale('gpu'); syncUI(); };
$('speedBtn').onclick = () => applySpeed(SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length], true);
$('speedSel').onchange = (e) => applySpeed(e.target.value, true);
$('slowSoundSel').onchange = (e) => { applySlowSound(e.target.value); toast(S.slowSound === 'smooth' ? 'Sound: smooth slow motion (deeper voices)' : 'Sound: normal voice pitch'); };
applySlowSound(S.slowSound);
applySpeed(S.speed);
$('muteBtn').onclick = () => { S.muted = !S.muted; if (!S.muted && S.volume === 0) S.volume = 0.5; persist(); syncUI(); };
$('volume').oninput = (e) => { S.volume = +e.target.value; S.muted = S.volume === 0; persist(); syncUI(); };
video.addEventListener('play', () => { $('playBtn').innerHTML = '<svg><use href="#i-pause"/></svg>'; });
video.addEventListener('pause', () => { $('playBtn').innerHTML = '<svg><use href="#i-play"/></svg>'; });
video.addEventListener('loadedmetadata', syncUI);

// Seek bar
const fmt = (t) => {
  if (!isFinite(t)) return '0:00';
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
let seeking = false;
$('seek').addEventListener('input', (e) => {
  seeking = true;
  const t = (e.target.value / 1000) * totalTime();
  $('cur').textContent = fmt(t);
  if (!cur.streamed && totalTime()) seekTo(t);          // live scrubbing for directly playable files
});
$('seek').addEventListener('change', (e) => {
  if (cur.streamed && totalTime()) seekTo((e.target.value / 1000) * totalTime());   // converted streams seek on release
  seeking = false;
});
$('seek').addEventListener('mousemove', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  $('seekTip').style.left = f * 100 + '%';
  $('seekTip').textContent = fmt(f * totalTime());
});
function updateTimeline() {
  const live = isLive();
  document.body.classList.toggle('live', live);
  if (live) {
    $('cur').textContent = '● LIVE';
    $('dur').textContent = '';
    return;
  }
  const d = totalTime();
  const f = d ? Math.min(1, curTime() / d) : 0;
  $('played').style.width = f * 100 + '%';
  if (!seeking) $('seek').value = Math.round(f * 1000);
  if (!seeking) $('cur').textContent = fmt(curTime());
  $('dur').textContent = fmt(d);
  if (d && video.buffered.length) $('buffered').style.width = Math.min(100, ((cur.offset + video.buffered.end(video.buffered.length - 1)) / d) * 100) + '%';
}

function renderStats() {
  const o = renderer.output;
  const lines = [
    `source   ${video.videoWidth}×${video.videoHeight}  ${fmtLabel()}`,
    `output   ${o ? o.w + '×' + o.h : '-'}  (${S.upscale}${S.upscale !== 'off' ? ' ' + lastScale + '×' : ''})`,
    `file     ${cur.info ? [cur.info.videoCodec, cur.info.audioCodec].filter(Boolean).join(' + ') || '?' : '-'}  ${cur.info && cur.info.mode ? cur.info.mode : ''}${cur.info && cur.info.encoder ? ' (' + cur.info.encoder + ')' : ''}${cur.maxWidth ? ' ≤' + cur.maxWidth + 'px' : ''}`,
    `frames   ${stats.fps.toFixed(1)} fps decoded, ${video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality().droppedVideoFrames : 0} dropped`,
    `display  ${canvas.width}×${canvas.height}  fov ${S.fov}°`,
  ];
  if (ai.ready) lines.push(`ai       ${ai.modelName} ${ai.scale}× ${ai.backend}`, `ai frame ${(stats.aiMs / 1000).toFixed(2)} s / ${stats.aiTiles} tiles`);
  if (xr.active) lines.push('xr       headset active');
  $('stats').textContent = lines.join('\n');
  updateUpBadge();
}

// Look-around, compare divider, click-to-play
let drag = null;
// Two-finger pinch: zoom 2D videos (around the fingers) or change the field of view in 360°/180°.
const touches = new Map();
let pinch = null, pinched = false;
function pinchState() {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) pinched = false;
    if (touches.size === 2) { pinch = pinchState(); pinched = true; }
  }
}, true);
canvas.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2 && pinch) {
    e.stopImmediatePropagation();
    const now = pinchState();
    const f = now.d / Math.max(1, pinch.d);
    if (F.projection === 'flat') { zoomAt(f, now.x, now.y); panBy(now.x - pinch.x, now.y - pinch.y); }
    else { S.fov = Math.round(Math.max(30, Math.min(120, S.fov / f))); $('fovRange').value = S.fov; $('fovOut').textContent = S.fov + '°'; }
    pinch = now;
  }
}, true);
const endTouch = (e) => {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
};
canvas.addEventListener('pointerup', endTouch, true);
canvas.addEventListener('pointercancel', endTouch, true);

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const nearSplit = compare && S.upscale !== 'off' && Math.abs(e.clientX - splitPos * canvas.clientWidth) < 14;
  drag = { x: e.clientX, y: e.clientY, moved: false, split: nearSplit };
  if ((F.projection !== 'flat' || zoom > 1) && !nearSplit) canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (compare) canvas.style.cursor = Math.abs(e.clientX - splitPos * canvas.clientWidth) < 14 ? 'ew-resize' : '';
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.split) { splitPos = Math.max(0.02, Math.min(0.98, e.clientX / canvas.clientWidth)); }
  else if (F.projection === 'flat') panBy(dx, dy);
  else {
    const k = (S.fov * Math.PI / 180) / canvas.clientHeight;
    yaw += dx * k;
    pitch = Math.max(-1.55, Math.min(1.55, pitch + dy * k));
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved && !drag.split && !pinched) {
    if (e.pointerType === 'touch') {
      // Phones/tablets: a tap shows the controls (Home, play, seek…); tapping again hides them.
      if (document.body.classList.contains('idle') || video.paused) wake();
      else { clearTimeout(idleTimer); document.body.classList.add('idle'); }
    } else {
      pendingClick = setTimeout(togglePlay, 220);   // mouse: click = play/pause (cancelled by dblclick)
    }
  }
  drag = null;
  canvas.classList.remove('dragging');
});
let pendingClick = 0;
canvas.addEventListener('dblclick', () => { clearTimeout(pendingClick); toggleFullscreen(); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (F.projection === 'flat') {
    // Mouse wheel, touchpad scroll or pinch: zoom toward the pointer.
    const step = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoomAt(Math.exp(-step * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
    return;
  }
  S.fov = Math.round(Math.max(30, Math.min(120, S.fov * Math.exp(e.deltaY * 0.001))));
  $('fovRange').value = S.fov; $('fovOut').textContent = S.fov + '°';
  persist();
}, { passive: false });

// Auto-hide controls
let idleTimer = 0;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!video.paused && $('panel').hidden && !document.querySelector('#controls:hover')) document.body.classList.add('idle');
  }, 2600);
}
window.addEventListener('pointermove', wake);
window.addEventListener('pointerdown', (e) => { if (e.target !== canvas) wake(); });
video.addEventListener('play', wake);   // start the auto-hide timer even without any input
window.addEventListener('keydown', wake);
video.addEventListener('pause', wake);

// Keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text], input[type=search], select') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  const handled = true;
  const onHome = !document.body.classList.contains('loaded');
  if (onHome && !['o', 'O', '?', ' ', 'Escape', 'k', 'K', 's', 'S'].includes(k)) return;
  switch (k) {
    case ' ': case 'k': case 'K': togglePlay(); break;
    case 'ArrowLeft': if (e.shiftKey && zoom > 1) panBy(60, 0); else seekBy(-5); break;
    case 'ArrowRight': if (e.shiftKey && zoom > 1) panBy(-60, 0); else seekBy(5); break;
    case 'j': case 'J': seekBy(-10); break;
    case 'l': case 'L': seekBy(10); break;
    case ',': stepFrame(-1); break;
    case '.': stepFrame(1); break;
    case 'ArrowUp': if (e.shiftKey && zoom > 1) { panBy(0, 60); break; } S.volume = Math.min(1, S.volume + 0.05); S.muted = false; persist(); syncUI(); toast(`Volume ${Math.round(S.volume * 100)}%`); break;
    case 'ArrowDown': if (e.shiftKey && zoom > 1) { panBy(0, -60); break; } S.volume = Math.max(0, S.volume - 0.05); persist(); syncUI(); toast(`Volume ${Math.round(S.volume * 100)}%`); break;
    case 'm': case 'M': $('muteBtn').click(); break;
    case '+': case '=': if (F.projection === 'flat') zoomAt(1.25); else { S.fov = Math.max(30, S.fov - 5); syncUI(); } break;
    case '-': case '_': if (F.projection === 'flat') zoomAt(0.8); else { S.fov = Math.min(120, S.fov + 5); syncUI(); } break;
    case '0': resetZoom(); break;
    case 'n': case 'N': playNext(false); break;
    case 'b': case 'B': playPrev(); break;
    case 'h': case 'H': $('shuffleBtn').click(); break;
    case 't': case 'T': $('repeatBtn').click(); break;
    case 'q': case 'Q': toggleQueue(); break;
    case 'Backspace': goHome(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'o': case 'O': openDialog(); break;
    case 'u': case 'U': setUpscale(UPS[(UPS.findIndex((u) => u.v === S.upscale) + 1) % UPS.length].v); break;
    case 'c': case 'C': $('cmpBtn').click(); break;
    case 'v': case 'V': toggleVR(); break;
    case 'r': case 'R': recenter(); break;
    case 'i': case 'I': toggleStats(); break;
    case 's': case 'S': $('gearBtn').click(); break;
    case 'p': case 'P': {
      const list = FORMATS.filter((f) => f !== 'sep');
      const i = list.findIndex((f) => f.projection === F.projection && f.stereo === F.stereo);
      const n = list[(i + 1) % list.length];
      setFormat({ projection: n.projection, stereo: n.stereo });
      break;
    }
    case '[': setSpeed(-1); break;
    case ']': setSpeed(1); break;
    case '?': $('help').hidden = !$('help').hidden; break;
    case 'Escape': $('help').hidden = true; $('streamDlg').hidden = true; $('panel').hidden = true; $('library').hidden = true; toggleQueue(false); closePops(); break;
    default: return;
  }
  if (handled) e.preventDefault();
});

// Toast
let toastTimer = 0;
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }


// ------------------------------------------------------------------------------------------------
// Home / start screen: go back to pick another video, resume, recently played
const RECENT_MAX = 12;
const itemKey = (it) => it.path || it.lib || it.url || it.name;
function addRecent(item) {
  if (!item || item.file) return;                     // files picked from the device can't be reopened later
  const entry = { name: item.name, path: item.path, lib: item.lib, url: item.url && !String(item.url).startsWith('blob:') ? item.url : undefined, at: Date.now() };
  if (!entry.path && !entry.lib && !entry.url) return;
  const list = load('lumen.recent', []).filter((r) => itemKey(r) !== itemKey(entry));
  list.unshift(entry);
  save('lumen.recent', list.slice(0, RECENT_MAX));
}
function savePosition() {
  if (!cur.item || !totalTime()) return;
  const pos = load('lumen.positions', {});
  const t = curTime(), d = totalTime();
  const k = itemKey(cur.item);
  if (t > 5 && t < d - 10) pos[k] = Math.round(t); else delete pos[k];   // forget finished videos
  const keys = Object.keys(pos);
  if (keys.length > 200) delete pos[keys[0]];
  save('lumen.positions', pos);
}
setInterval(() => { if (!video.paused) savePosition(); }, 5000);
video.addEventListener('pause', savePosition);

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
};

function renderHome() {
  // Resume the video that's loaded right now
  const hasCurrent = !!(cur.item && video.getAttribute('src'));
  $('resumeBtn').hidden = !hasCurrent;
  if (hasCurrent) {
    $('resumeName').textContent = cur.item.name;
    $('resumeTime').textContent = totalTime() ? `${fmt(curTime())} / ${fmt(totalTime())}` : '';
  }
  // Recently played (that this device can reopen)
  const canReopen = (r) => (r.path && host) || (r.lib && server) || r.url;
  const list = load('lumen.recent', []).filter(canReopen).filter((r) => !hasCurrent || itemKey(r) !== itemKey(cur.item));
  const pos = load('lumen.positions', {});
  $('recent').hidden = !list.length;
  const ul = $('recentList');
  ul.innerHTML = '';
  for (const r of list.slice(0, 8)) {
    const li = document.createElement('li');
    const p = pos[itemKey(r)];
    li.innerHTML = `<svg><use href="#i-play"/></svg><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><span class="meta">${p ? 'at ' + fmt(p) + ' · ' : ''}${ago(r.at)}</span>`;
    li.onclick = () => openRecent(r);
    ul.append(li);
  }
}

async function openRecent(r) {
  const item = { name: r.name, path: r.path, lib: r.lib, url: r.url };
  const at = load('lumen.positions', {})[itemKey(r)] || 0;
  const i = queue.add([item], { after: queue.index >= 0 });
  queue.select(i);
  await playItem(queue.current, { at });
}

function goHome() {
  if (!document.body.classList.contains('loaded')) return;
  savePosition();
  video.pause();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  for (const id of ['panel', 'queue', 'library', 'help', 'endCard']) $(id).hidden = true;
  closePops();
  if (xr.active) xr.exit();
  document.body.classList.remove('loaded', 'idle');
  renderHome();
}

function resumePlayer() {
  if (!cur.item) return;
  document.body.classList.add('loaded');
  if (video.ended) seekTo(0);
  video.play().catch(() => {});
}

$('homeBtn').onclick = goHome;
$('homeBtn2').onclick = goHome;
$('endHome').onclick = () => { hideEndCard(); goHome(); };
$('endReplay').onclick = () => { hideEndCard(); seekTo(0); video.play().catch(() => {}); };
$('endOpen').onclick = () => { hideEndCard(); goHome(); openDialog(false); };
$('resumeBtn').onclick = resumePlayer;
$('recentClear').onclick = () => { save('lumen.recent', []); renderHome(); };

// ------------------------------------------------------------------------------------------------
// Queue panel & saved playlists
/** A list kept on the server (shared by every device) when connected, otherwise on this device. */
function makeStore(apiPath, localKey, what) {
  return {
    async list() {
      if (server) { try { return await (await fetch(apiUrl(apiPath), { cache: 'no-store' })).json(); } catch { return []; } }
      return load(localKey, []);
    },
    async saveAll(lists) {
      if (server && android && API) {
        const code = android.serverSend('PUT', apiPath, JSON.stringify(lists));
        if (code < 200 || code >= 300) throw new Error(`Could not save ${what} on the server`);
      } else if (server) {
        const r = await fetch(apiUrl(apiPath), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lists) });
        if (!r.ok) throw new Error(`Could not save ${what} on the server`);
      } else save(localKey, lists);
    },
  };
}
const PL = makeStore('/api/playlists', 'lumen.playlists', 'playlists');
const LINKS = makeStore('/api/links', 'lumen.savedLinks', 'links');

function syncPlaylistButtons() {
  $('shuffleBtn').classList.toggle('on', queue.shuffle);
  $('shuffleBtn').title = `Shuffle: ${queue.shuffle ? 'on' : 'off'} (H)`;
  const r = queue.repeat;
  $('repeatBtn').classList.toggle('on', r !== 'off');
  $('repeatBtn').innerHTML = `<svg><use href="#i-${r === 'one' ? 'repeat1' : 'repeat'}"/></svg>`;
  $('repeatBtn').title = `Repeat: ${{ off: 'off', all: 'all', one: 'one' }[r]} (T)`;
  $('queueBtn').classList.toggle('on', !$('queue').hidden);
}

let dragFrom = -1;
function renderQueue() {
  const ol = $('qList');
  if (!ol) return;
  $('qName').textContent = queue.name || 'Queue';
  $('qCount').textContent = queue.items.length ? `${queue.items.length} video${queue.items.length > 1 ? 's' : ''}` : '';
  ol.innerHTML = '';
  if (!queue.items.length) {
    ol.innerHTML = '<li class="empty">The queue is empty.<br>Open several videos, drop files here, or use + in the library.</li>';
    return;
  }
  queue.items.forEach((it, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.className = i === queue.index ? 'cur' : '';
    li.innerHTML = `<svg class="grip"><use href="#i-grip"/></svg><span class="num">${i === queue.index ? '▶' : i + 1}</span><span class="nm" title="${esc(it.name)}">${esc(it.name)}</span><button class="x" title="Remove">✕</button>`;
    li.onclick = (e) => { if (e.target.closest('.x')) { queue.remove(i); return; } playIndex(i); };
    li.addEventListener('dragstart', (e) => { dragFrom = i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
    li.addEventListener('dragend', () => { dragFrom = -1; li.classList.remove('dragging'); });
    li.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const after = e.offsetY > li.clientHeight / 2;
      li.classList.toggle('drop-after', after); li.classList.toggle('drop-before', !after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-after', 'drop-before'));
    li.addEventListener('drop', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault(); e.stopPropagation();
      const after = e.offsetY > li.clientHeight / 2;
      let to = i + (after ? 1 : 0);
      if (dragFrom < to) to--;
      queue.move(dragFrom, Math.max(0, Math.min(queue.items.length - 1, to)));
    });
    ol.append(li);
  });
  const curLi = ol.querySelector('li.cur');
  if (curLi && !$('queue').hidden) curLi.scrollIntoView({ block: 'nearest' });
}

async function renderPlaylists() {
  const ul = $('plList');
  const lists = await PL.list();
  ul.innerHTML = '';
  $('plNote').textContent = server ? 'Playlists are saved on the server and shared by every device.'
    : host ? 'Playlists are saved on this computer.' : 'Files opened from this device only stay in a playlist until the page is closed.';
  if (!lists.length) { ul.innerHTML = '<li class="empty">No playlists yet.<br>Build a queue, then choose “Save as playlist”.</li>'; return; }
  for (const pl of lists) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nm" title="${esc(pl.name)}">${esc(pl.name)}</span><span class="meta">${pl.items.length}</span>
      <button class="act" data-a="play">Play</button><button class="act" data-a="add">Add</button><button class="act" data-a="ren">Rename</button><button class="act" data-a="del">Delete</button>`;
    li.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'play' || (!a && !e.target.closest('input'))) {
        queue.replace(pl.items, pl.name);
        if (queue.items.length) playIndex(queue.shuffle ? queue.order[0] : 0);
        showQueueTab('queue');
      } else if (a === 'add') {
        addAndPlay(pl.items.map((x) => ({ ...x })), { play: false });
      } else if (a === 'ren') {
        const nm = li.querySelector('.nm');
        const input = Object.assign(document.createElement('input'), { type: 'text', value: pl.name, className: 'q-input' });
        nm.replaceWith(input); input.focus(); input.select();
        const done = async (ok) => {
          if (ok && input.value.trim()) { pl.name = input.value.trim(); await PL.saveAll(lists); }
          renderPlaylists();
        };
        input.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
        input.onblur = () => done(true);
      } else if (a === 'del') {
        if (e.target.textContent !== 'Sure?') { e.target.textContent = 'Sure?'; setTimeout(() => { e.target.textContent = 'Delete'; }, 2500); return; }
        await PL.saveAll(lists.filter((x) => x !== pl));
        renderPlaylists();
      }
    };
    ul.append(li);
  }
}

function showQueueTab(tab) {
  $('qTabQueue').classList.toggle('on', tab === 'queue');
  $('qTabLists').classList.toggle('on', tab === 'lists');
  $('qQueueView').hidden = tab !== 'queue';
  $('qListsView').hidden = tab !== 'lists';
  if (tab === 'lists') renderPlaylists(); else renderQueue();
}

function toggleQueue(show = $('queue').hidden) {
  $('queue').hidden = !show;
  if (show) showQueueTab('queue');
  syncPlaylistButtons();
}

async function saveQueueAsPlaylist() {
  const items = queue.serializable();
  if (!items.length) return toast(queue.items.length ? 'Videos opened from this device can’t be saved in a playlist' : 'The queue is empty');
  const foot = $('qQueueView').querySelector('.q-foot');
  const old = foot.innerHTML;
  foot.innerHTML = '<input type="text" class="q-input" id="qSaveName" placeholder="Playlist name"><button class="primary sm" id="qSaveOk">Save</button>';
  const input = $('qSaveName');
  input.value = queue.name || '';
  input.focus();
  const finish = async (ok) => {
    const name = input.value.trim();
    foot.innerHTML = old;
    bindQueueFoot();
    if (!ok || !name) return;
    const lists = await PL.list();
    const existing = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (existing) { existing.items = items; existing.updated = Date.now(); } else lists.push({ id: Date.now().toString(36), name, items, updated: Date.now() });
    try { await PL.saveAll(lists); queue.name = name; renderQueue(); saveQueueState(); toast(`Saved playlist “${name}”`); } catch (e) { toast(e.message, 4000); }
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  $('qSaveOk').onclick = () => finish(true);
}

function bindQueueFoot() {
  $('qAdd').onclick = () => openDialog(true);
  $('qSave').onclick = saveQueueAsPlaylist;
  $('qClear').onclick = () => {
    if ($('qClear').textContent !== 'Sure?') { $('qClear').textContent = 'Sure?'; setTimeout(() => { if ($('qClear')) $('qClear').textContent = 'Clear'; }, 2500); return; }
    const keep = queue.current;
    queue.clear();
    if (keep) { queue.add(keep); queue.select(0); }
  };
}
bindQueueFoot();
$('qTabQueue').onclick = () => showQueueTab('queue');
$('qTabLists').onclick = () => showQueueTab('lists');
$('qClose').onclick = () => toggleQueue(false);
$('queueBtn').onclick = () => toggleQueue();
$('prevBtn').onclick = playPrev;
$('nextBtn').onclick = () => playNext(false);
$('shuffleBtn').onclick = () => { queue.setShuffle(!queue.shuffle); toast(`Shuffle ${queue.shuffle ? 'on' : 'off'}`); };
$('repeatBtn').onclick = () => { const r = queue.cycleRepeat(); toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[r]); };
syncPlaylistButtons();
renderQueue();

// ------------------------------------------------------------------------------------------------
// Server edition: media library
let libPath = load('lumen.libPath', '/');
let libVideos = [];
let libMode = 'files';                  // 'files' (server library) or 'channels' (an M3U list)
let chItems = [], chName = '', chGroup = null;
const libListName = () => (libMode === 'channels' ? (chGroup ? `${chName} · ${chGroup || 'Other'}` : chName) : (libPath.split('/').pop() || 'Media'));
const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="currentColor" opacity=".85"/></svg>';
const ICON_VIDEO = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor"/></svg>';
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
function vrTag(name) {
  const f = detectFormat(name, 0, 0);
  if (f.projection === 'flat') return f.stereo === 'mono' ? '' : '3D';
  return { equi360: '360°', equi180: '180°', fisheye180: '180°' }[f.projection] + (f.stereo !== 'mono' ? ' 3D' : '');
}

async function openLibrary(path = libPath) {
  libMode = 'files';
  $('libSearch').placeholder = 'Search videos…';
  $('libSaveList').hidden = true;
  $('libPlayAll').lastChild.textContent = 'Play folder';
  $('libShuffleAll').lastChild.textContent = 'Shuffle folder';
  $('libAddAll').lastChild.textContent = 'Add folder to queue';
  $('library').hidden = false;
  $('library').querySelector('h2').textContent = addMode ? 'Add to queue' : 'Library';
  if (!$('libSearch').value) await showFolder(path);
  setTimeout(() => $('libSearch').focus(), 50);
}

async function showFolder(path, query = '') {
  const list = $('libList');
  list.innerHTML = '<div class="empty">Loading…</div>';
  let data;
  try {
    const r = await fetch(apiUrl(query ? '/api/library?q=' + encodeURIComponent(query) : '/api/library?path=' + encodeURIComponent(path)));
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch {
    if (path !== '/' && !query) return showFolder('/');
    list.innerHTML = '<div class="empty">Could not read the media folder.</div>';
    return;
  }
  if (!query) { libPath = data.path; save('lumen.libPath', libPath); }
  // breadcrumbs
  const crumbs = $('libCrumbs');
  crumbs.innerHTML = '';
  if (query) crumbs.innerHTML = `<span>Results for “${esc(query)}”</span>`;
  else {
    const parts = data.path.split('/').filter(Boolean);
    const mk = (label, p) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => showFolder(p); return b; };
    crumbs.append(mk('Media', '/'));
    parts.forEach((part, i) => {
      const sep = document.createElement('span'); sep.textContent = '›'; crumbs.append(sep);
      crumbs.append(mk(part, '/' + parts.slice(0, i + 1).join('/')));
    });
  }
  list.innerHTML = '';
  if (!query && data.path !== '/') {
    const up = document.createElement('button');
    up.className = 'folder';
    up.innerHTML = `${ICON_FOLDER}<span class="name">..</span>`;
    up.onclick = () => showFolder(data.path.split('/').slice(0, -1).join('/') || '/');
    list.append(up);
  }
  for (const f of data.folders) {
    const b = document.createElement('button');
    b.className = 'folder';
    b.innerHTML = `${ICON_FOLDER}<span class="name">${esc(f.name)}</span>`;
    b.onclick = () => showFolder(f.path);
    list.append(b);
  }
  libVideos = data.videos.map((v) => ({ name: v.name, lib: v.path }));
  $('libActions').hidden = !libVideos.length || !!query;
  for (const v of data.videos) {
    const b = document.createElement('button');
    const tag = vrTag(v.name);
    b.innerHTML = `${ICON_VIDEO}<span class="name">${esc(v.name)}</span>${tag ? `<span class="tag">${tag}</span>` : ''}<span class="meta">${fmtSize(v.size)}</span><span class="add" role="button" title="Add to queue"><svg><use href="#i-plus"/></svg></span>`;
    b.onclick = (e) => {
      const item = { name: v.name, lib: v.path };
      if (e.target.closest('.add') || addMode) { addAndPlay([item], { play: false }); return; }
      $('library').hidden = true;
      addAndPlay([item], { play: true });
    };
    list.append(b);
  }
  if (!data.folders.length && !data.videos.length) list.innerHTML += `<div class="empty">${query ? 'No matching videos.' : 'No videos in this folder.'}</div>`;
}

let libSearchTimer = 0;
$('libSearch').addEventListener('input', (e) => {
  clearTimeout(libSearchTimer);
  const q = e.target.value.trim();
  libSearchTimer = setTimeout(() => (libMode === 'channels' ? renderChannels(q) : showFolder(libPath, q)), 250);
});
$('libClose').onclick = () => { $('library').hidden = true; addMode = false; };
$('libPlayAll').onclick = () => { queue.replace(libVideos, libListName()); if (queue.shuffle) queue.setShuffle(false); $('library').hidden = true; playIndex(0); };
$('libShuffleAll').onclick = () => { queue.replace(libVideos, libListName()); queue.setShuffle(true); $('library').hidden = true; playIndex(queue.order[0]); };
$('libSaveList').onclick = async () => {
  const lists = await PL.list();
  const items = chItems.map(({ name, url, path, lib }) => ({ name, url, path, lib }));
  const existing = lists.find((l) => l.name.toLowerCase() === chName.toLowerCase());
  if (existing) { existing.items = items; existing.updated = Date.now(); } else lists.push({ id: Date.now().toString(36), name: chName, items, updated: Date.now() });
  try { await PL.saveAll(lists); toast(`Saved “${chName}” (${items.length}) to Playlists`); } catch (e) { toast(e.message, 4000); }
};

// ---- Channel browser for M3U lists (reuses the library window)
function openChannels(items, name) {
  libMode = 'channels';
  chItems = items; chName = name || 'Channels'; chGroup = null;
  $('libSearch').value = '';
  $('libSaveList').hidden = false;
  $('libSearch').placeholder = 'Search channels…';
  $('library').querySelector('h2').textContent = chName;
  $('library').hidden = false;
  renderChannels();
}

function renderChannels(query = '') {
  libMode = 'channels';
  const list = $('libList'), crumbs = $('libCrumbs');
  const groups = groupsOf(chItems);
  crumbs.innerHTML = '';
  const mk = (label, g) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { chGroup = g; $('libSearch').value = ''; renderChannels(); }; return b; };
  crumbs.append(mk(`All channels (${chItems.length})`, null));
  if (chGroup !== null) { const sep = document.createElement('span'); sep.textContent = '›'; crumbs.append(sep, mk(chGroup || 'Other', chGroup)); }
  const q = query.trim().toLowerCase();
  let shown = [];
  list.innerHTML = '';
  if (!q && chGroup === null && groups.length > 1) {
    for (const g of groups) {
      const b = document.createElement('button');
      b.className = 'folder';
      b.innerHTML = `${ICON_FOLDER}<span class="name">${esc(g.name || 'Other')}</span><span class="meta">${g.count}</span>`;
      b.onclick = () => { chGroup = g.name; renderChannels(); };
      list.append(b);
    }
    shown = chItems;   // "Play all" etc. act on the whole list here
  } else {
    shown = chItems.filter((it) => (q ? (it.name || '').toLowerCase().includes(q) || (it.group || '').toLowerCase().includes(q) : chGroup === null || (it.group || '') === chGroup));
    const MAX = 600;
    shown.slice(0, MAX).forEach((it, idx) => {
      const b = document.createElement('button');
      const live = isStreamUrl(it.url);
      b.innerHTML = `${live ? '<svg><use href="#i-live"/></svg>' : ICON_VIDEO}<span class="name">${esc(it.name)}</span>${q && it.group ? `<span class="grp">${esc(it.group)}</span>` : ''}<span class="add" role="button" title="Add to queue"><svg><use href="#i-plus"/></svg></span>`;
      b.onclick = (e) => {
        const item = { name: it.name, url: it.url, path: it.path, lib: it.lib };
        if (e.target.closest('.add')) { addAndPlay([item], { play: false }); return; }
        // Put the whole group in the queue so Next / Previous switch channels.
        queue.replace(shown.map(({ name, url, path, lib }) => ({ name, url, path, lib })), libListName());
        if (queue.shuffle) queue.setShuffle(false);
        $('library').hidden = true;
        playIndex(idx);
      };
      list.append(b);
    });
    if (shown.length > MAX) list.insertAdjacentHTML('beforeend', `<div class="empty">Showing ${MAX} of ${shown.length}. Search to find more.</div>`);
    if (!shown.length) list.innerHTML = '<div class="empty">No matching channels.</div>';
  }
  libVideos = shown.map(({ name, url, path, lib }) => ({ name, url, path, lib }));
  $('libActions').hidden = !libVideos.length;
  $('libPlayAll').lastChild.textContent = 'Play all';
  $('libShuffleAll').lastChild.textContent = 'Shuffle';
  $('libAddAll').lastChild.textContent = 'Add to queue';
}

// ---- "Open stream link" dialog
let savedLinksCache = [];
const savedName = (u) => (savedLinksCache.find((l) => l.url === u) || {}).name || '';

function openStreamDialog() {
  $('streamDlg').hidden = false;
  $('streamName').value = '';
  renderLinks();
  setTimeout(() => $('streamUrl').focus(), 50);
}

async function renderLinks() {
  savedLinksCache = await LINKS.list();
  // Saved links: open, rename, delete
  const sul = $('savedLinks');
  sul.innerHTML = '';
  $('savedEmpty').hidden = !!savedLinksCache.length;
  savedLinksCache.forEach((l, i) => {
    const li = document.createElement('li');
    li.className = 'link-row';
    li.innerHTML = `<div class="link-main"><b>${esc(l.name)}</b><small>${esc(l.url)}</small></div>
      <button class="act" data-a="open">Open</button><button class="act" data-a="ren">Rename</button><button class="act" data-a="del">Delete</button>`;
    li.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'del') {
        if (e.target.textContent !== 'Sure?') { e.target.textContent = 'Sure?'; setTimeout(() => { e.target.textContent = 'Delete'; }, 2500); return; }
        savedLinksCache.splice(i, 1);
        await saveLinks(`Deleted “${l.name}”`);
      } else if (a === 'ren') {
        const main = li.querySelector('.link-main b');
        const input = Object.assign(document.createElement('input'), { type: 'text', value: l.name, className: 'q-input' });
        main.replaceWith(input); input.focus(); input.select();
        const done = async (ok) => { if (ok && input.value.trim() && input.value.trim() !== l.name) { l.name = input.value.trim(); await saveLinks('Renamed'); } else renderLinks(); };
        input.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
        input.onblur = () => done(true);
      } else if (a === 'open' || (!a && !e.target.closest('input'))) {
        $('streamUrl').value = l.url; $('streamName').value = l.name; $('streamGo').click();
      }
    };
    sul.append(li);
  });
  // Recent links: save, remove
  const recent = load('lumen.streamLinks', []);
  $('streamRecentWrap').hidden = !recent.length;
  const ul = $('streamRecent');
  ul.innerHTML = '';
  recent.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'link-row';
    const isSaved = savedLinksCache.some((l) => l.url === u);
    li.innerHTML = `<div class="link-main"><small title="${esc(u)}">${esc(u)}</small></div>
      ${isSaved ? '<span class="saved-tag">saved</span>' : '<button class="act" data-a="save">Save</button>'}<button class="act" data-a="rm" title="Remove from recent">✕</button>`;
    li.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'rm') { save('lumen.streamLinks', load('lumen.streamLinks', []).filter((x) => x !== u)); renderLinks(); return; }
      if (a === 'save') { $('streamUrl').value = u; $('streamName').focus(); toast('Type a name, then press Save link'); return; }
      $('streamUrl').value = u; $('streamGo').click();
    };
    ul.append(li);
  });
}

async function saveLinks(msg) {
  try { await LINKS.saveAll(savedLinksCache); if (msg) toast(msg); } catch (e) { toast(e.message, 4000); }
  renderLinks();
}

$('streamSave').onclick = async () => {
  let u = $('streamUrl').value.trim();
  if (!u) return toast('Paste a link first');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
  if (!isStreamUrl(u)) return toast('That doesn’t look like a stream link', 3500);
  const name = $('streamName').value.trim() || streamName(u);
  savedLinksCache = await LINKS.list();
  const existing = savedLinksCache.find((l) => l.url === u);
  if (existing) existing.name = name; else savedLinksCache.unshift({ name, url: u, added: Date.now() });
  $('streamName').value = '';
  await saveLinks(`Saved “${name}”`);
};
function streamName(u) {
  try {
    const x = new URL(u);
    const last = decodeURIComponent(x.pathname.split('/').filter(Boolean).pop() || '');
    return last && !/^(index|playlist|master|live|stream|chunklist)[\w-]*\.(m3u8?|ts)$/i.test(last) ? last : x.host + (last ? ' · ' + last : '');
  } catch { return u; }
}
$('streamBtn').onclick = openStreamDialog;
$('streamClose').onclick = () => { $('streamDlg').hidden = true; };
$('streamDlg').onclick = (e) => { if (e.target.id === 'streamDlg') $('streamDlg').hidden = true; };
$('streamFile').onclick = () => { $('streamDlg').hidden = true; $('fileInput').click(); };
$('streamUrl').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('streamGo').click(); });
$('streamName').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('streamSave').click(); });
$('streamGo').onclick = async () => {
  let u = $('streamUrl').value.trim();
  if (!u) return;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
  if (!isStreamUrl(u)) return toast('That doesn’t look like a stream link (http, https, rtsp, rtmp, mms, udp, rtp, srt, rist, tcp)', 4500);
  save('lumen.streamLinks', [u, ...load('lumen.streamLinks', []).filter((x) => x !== u)].slice(0, 10));
  $('streamDlg').hidden = true;
  const item = { name: $('streamName').value.trim() || savedName(u) || streamName(u), url: u };
  // IPTV list links often have no .m3u ending (e.g. get.php?…&type=m3u_plus): peek at the content first.
  const mediaExt = /\.(mp4|m4v|mkv|webm|mov|ts|m2ts|mpg|mpeg|flv|avi|wmv|mp3|aac|mpd)(\?|$)/i.test(u);
  if (/^https?:/i.test(u) && !mediaExt && !looksLikeList(u)) {
    try {
      const res = await fetchListText(item);
      if (!isHlsPlaylist(res.text)) {
        const items = parsePlaylist(res.text, res.base).filter((it) => isStreamUrl(it.url)).map((it) => ({ name: it.name, url: it.url, group: it.group }));
        if (items.length) { openChannels(items, $('streamName').value.trim() || streamName(u).replace(/\.(m3u8?|pls|xspf|asx)$/i, '') || 'Channels'); return; }
      }
    } catch { /* not a list: play it as a stream */ }
  }
  addAndPlay([item], { play: true });
};
if (host && host.onShowStreamDialog) host.onShowStreamDialog(() => { if (!document.body.classList.contains('loaded')) renderHome(); openStreamDialog(); });
$('libAddAll').onclick = () => addAndPlay(libVideos.map((x) => ({ ...x })), { play: false });
$('library').onclick = (e) => { if (e.target.id === 'library') { $('library').hidden = true; addMode = false; } };
$('libLocal').onclick = () => { $('library').hidden = true; $('fileInput').click(); };

// Android: connect the app to a Lumen server (ZimaOS) to browse its library and use its conversion.
if (android) {
  $('serverBtn').hidden = false;
  $('serverRow').hidden = false;
  const saved = android.getServer();
  $('serverStatus').textContent = saved ? `Connected to ${saved}` : 'Not connected — playing files on this phone.';
  $('serverDisconnect').hidden = !saved;
  const openDlg = () => { $('serverDlg').hidden = false; $('serverAddr').value = saved || load('lumen.lastServer', ''); setTimeout(() => $('serverAddr').focus(), 50); };
  $('serverBtn').onclick = openDlg;
  $('serverConnectBtn').onclick = openDlg;
  $('serverCancel').onclick = () => { $('serverDlg').hidden = true; };
  $('serverDisconnect').onclick = () => android.disconnectServer();
  $('serverGo').onclick = async () => {
    let addr = $('serverAddr').value.trim();
    if (!addr) return;
    if (!/^https?:\/\//i.test(addr)) addr = 'http://' + addr;
    if (!/:\d+(\/|$)/.test(addr.replace(/^https?:\/\//, ''))) addr = addr.replace(/\/$/, '') + (addr.startsWith('https') ? ':8445' : ':8095');
    const url = addr.replace(/\/+$/, '');
    $('serverMsg').textContent = 'Connecting…';
    save('lumen.lastServer', $('serverAddr').value.trim());
    android.connectServer(url);
  };
  $('serverAddr').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('serverGo').click(); });
  const err = new URLSearchParams(location.search).get('serverError');
  if (err) { toast('Could not reach the server: ' + err, 5000); }
}

async function detectServer() {
  if (host) return;
  API = androidServerOrigin();
  const hostName = API ? androidServerHost() : location.hostname;
  try {
    const r = await fetch(apiUrl('/api/info'), { cache: 'no-store' });
    if (r.status === 502 && API) throw new Error('unreachable');
    if (r.status === 401 && API) throw Object.assign(new Error('password'), { code: 'password' });
    const info = r.ok ? await r.json() : null;
    if (!info || !info.server) { if (API) throw new Error('not a Lumen server'); return; }
    server = info;
    $('openBtn').lastChild.textContent = 'Browse library';
    $('modelFolder').hidden = true;
    const insecure = !android && location.protocol === 'http:' && info.https;
    $('libHint').textContent = insecure
      ? `For VR headsets use https://${location.hostname}:${info.https}`
      : `Lumen server ${info.version}`;
    if (insecure && $('vrBtn').disabled) $('vrBtn').title = `VR needs the secure address: https://${location.hostname}:${info.https}`;
    if (android) {
      showServerNote(`Using your server <b>${esc(hostName)}</b> · <button id="usePhone">Use this phone's videos instead</button>`);
      $('serverStatus').textContent = `Connected to ${hostName} (server ${info.version})`;
    }
    refreshModelList();
    renderHome();
  } catch (e) {
    if (!API) return;   // plain static hosting, nothing to do
    let why = `Can't reach your server <b>${esc(hostName)}</b>. Check that it's on, that this phone is on the same Wi-Fi, and that the address and port are right (usually 8095).`;
    if (e.code === 'password') why = `Your server <b>${esc(hostName)}</b> has a password, which the phone app doesn't support yet. Remove LUMEN_PASSWORD on the server, or use the phone's own videos.`;
    else if (e.message === 'not a Lumen server') why = `<b>${esc(hostName)}</b> answered, but it isn't a Lumen server. Check the port (usually 8095).`;
    showServerNote(`${why} <button id="serverRetry">Try again</button> · <button id="serverChange">Change address</button> · <button id="usePhone">Use this phone's videos</button>`);
    $('serverChange').onclick = () => $('serverConnectBtn').click();
    $('serverRetry').onclick = () => { $('serverNote').innerHTML = 'Connecting…'; detectServer(); };
  }
}
function showServerNote(html) {
  const note = $('serverNote');
  note.hidden = false;
  note.innerHTML = html;
  const b = $('usePhone');
  if (b) b.onclick = () => android.disconnectServer();
}
detectServer();

// ------------------------------------------------------------------------------------------------
// Updates (desktop app only)
const upd = (host && host.updates) || (android ? androidUpdater() : null);

/** Android: check GitHub Releases for a newer APK and offer to download it. */
function androidUpdater() {
  let cb = () => {}, status = { state: 'idle', current: android.getVersion(), mode: 'manual', packaged: true }, timer = 0;
  const send = (s) => { status = { ...s, current: android.getVersion(), mode: 'manual', packaged: true }; cb(status); };
  const cmp = (a, b) => {
    const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0), pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
    return 0;
  };
  async function check() {
    send({ state: 'checking' });
    try {
      const r = await fetch('https://api.github.com/repos/unknownleaves/lumen-vr-player/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
      if (r.status === 404) return send({ state: 'up-to-date' });
      if (!r.ok) throw new Error('GitHub responded ' + r.status);
      const rel = await r.json();
      const v = String(rel.tag_name || '').replace(/^v/, '');
      const apk = (rel.assets || []).find((a) => a.name.toLowerCase().endsWith('.apk'));
      if (v && apk && cmp(v, android.getVersion()) > 0) send({ state: 'available', version: v, url: apk.browser_download_url, notes: (rel.body || '').slice(0, 600) });
      else send({ state: 'up-to-date' });
    } catch (e) { send({ state: 'error', message: /fetch|network/i.test(e.message) ? 'No internet connection' : e.message }); }
  }
  return {
    get: async () => status,
    check,
    install: async () => android.openUrl(status.url || 'https://github.com/unknownleaves/lumen-vr-player/releases/latest'),
    openPage: async () => android.openUrl('https://github.com/unknownleaves/lumen-vr-player/releases/latest'),
    setAuto: async (on) => { clearInterval(timer); if (on) { setTimeout(check, 3000); timer = setInterval(check, 6 * 3600 * 1000); } return true; },
    onStatus: (f) => { cb = f; },
    onShow: () => {},
  };
}
let updPackaged = true, updDismissed = '';
function renderUpdate(s) {
  if (!s) return;
  if (s.packaged === false) updPackaged = false;
  $('verText').textContent = (s.current || '—') + (updPackaged ? '' : ' (development build)');
  const st = $('updStatus'), act = $('updActionBtn'), banner = $('updBanner');
  const manual = s.mode === 'manual';
  let text = 'Updates come from GitHub Releases.', cls = '', action = '';
  switch (s.state) {
    case 'checking': text = 'Checking for updates…'; break;
    case 'up-to-date': text = "You're on the latest version."; cls = 'ok'; break;
    case 'downloading': text = `Downloading version ${s.version}… ${s.percent || 0}%`; break;
    case 'ready': text = `Version ${s.version} is downloaded. Restart to install it (or it installs when you quit).`; cls = 'ok'; action = 'Restart & update'; break;
    case 'available': text = `Version ${s.version} is available.` + (manual ? ' This copy can’t update itself, so download the new version.' : ''); cls = 'ok'; action = 'Download'; break;
    case 'error': text = `Couldn’t check for updates: ${s.message}`; cls = 'err'; break;
    default: if (!updPackaged) text = 'Updates are checked in installed builds, not when running from source.';
  }
  if (s.notes && (s.state === 'ready' || s.state === 'available')) text += '\n\n' + s.notes.split('\n').slice(0, 6).join('\n');
  st.textContent = text;
  st.className = 'status' + (cls ? ' ' + cls : '');
  act.hidden = !action;
  act.textContent = action;
  $('updProgress').hidden = s.state !== 'downloading';
  $('updBar').style.width = (s.percent || 0) + '%';
  $('updCheckBtn').disabled = s.state === 'checking' || s.state === 'downloading';
  const showBanner = (s.state === 'ready' || s.state === 'available') && updDismissed !== s.version;
  banner.hidden = !showBanner;
  if (showBanner) {
    $('updBannerText').textContent = s.state === 'ready' ? `Lumen ${s.version} is ready to install` : `Lumen ${s.version} is available`;
    $('updBannerBtn').textContent = action;
    $('updBannerBtn').dataset.version = s.version;
  }
}
if (!upd) {
  $('updSection').hidden = true;
} else {
  const autoOn = load('lumen.autoUpdate', true);
  $('autoUpdChk').checked = autoOn;
  upd.setAuto(autoOn);
  $('autoUpdChk').onchange = (e) => { save('lumen.autoUpdate', e.target.checked); upd.setAuto(e.target.checked); };
  $('updCheckBtn').onclick = () => upd.check();
  $('updActionBtn').onclick = () => upd.install();
  $('updBannerBtn').onclick = () => upd.install();
  $('updBannerClose').onclick = () => { updDismissed = $('updBannerBtn').dataset.version || ''; $('updBanner').hidden = true; };
  upd.onShow(() => { $('panel').hidden = false; $('updSection').scrollIntoView({ block: 'nearest' }); });
  upd.onStatus(renderUpdate);
  upd.get().then(renderUpdate);
}

window.__lumenBack = () => {
  for (const id of ['help', 'streamDlg', 'serverDlg', 'library', 'panel', 'queue', 'endCard']) {
    if (!$(id).hidden) {
      $(id).hidden = true; syncPlaylistButtons();
      if (id === 'endCard') goHome();
      return true;
    }
  }
  if (document.fullscreenElement) { document.exitFullscreen(); return true; }
  if (zoom > 1) { resetZoom(false); return true; }
  if (document.body.classList.contains('loaded')) { goHome(); return true; }
  return false;
};

renderHome();
syncUI();
if (S.upscale === 'ai') { S.upscale = 'gpu'; syncUI(); }   // AI is re-enabled explicitly each session (model load can be slow)

// Expose for automated tests / debugging.
window.__lumen = { renderer, ai, F, S, queue, cur, zoomAt, panBy, resetZoom, zoomState: () => ({ zoom, zu, zv, rect: flatRect() }), setFormat, setUpscale, openPayload, addAndPlay, seekTo, loadModel, state: () => ({ yaw, pitch, aiValid, lastScale, time: curTime(), total: totalTime() }) };
