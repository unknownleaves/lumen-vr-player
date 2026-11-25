import { Renderer } from './gl.js';
import { XRPlayer } from './xr.js';
import { AIUpscaler } from './ai.js';
import { detectFormat, eyeAspect } from './detect.js';
import { perspective, multiply, invert, rotX, rotY } from './math.js';

const $ = (id) => document.getElementById(id);
const host = window.lumen || null;            // Electron bridge (absent when opened in a plain browser)
let server = null;                            // set when served by the Docker / NAS server edition
const video = $('video');
const canvas = $('stage');

// ------------------------------------------------------------------------------------------------
// State
const DEFAULTS = {
  upscale: 'gpu', scale: 'auto', sharpness: 0.5, desktopStereo: 'left',
  aiApply: 'paused', tile: 256, backend: 'auto', fov: 90, volume: 1, muted: false, lastModel: '',
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
async function openPayload(p) {
  if (!p) return;
  fileName = p.name || 'video';
  video.src = p.url;
  video.load();
  document.body.classList.add('loaded');
  $('title').textContent = fileName;
  aiInvalidate();
  yaw = 0; pitch = 0;
  video.addEventListener('loadedmetadata', () => {
    const remembered = load('lumen.fmt.' + fileName, null);
    Object.assign(F, remembered || detectFormat(fileName, video.videoWidth, video.videoHeight));
    syncUI();
    video.play().catch(() => { /* autoplay may be blocked until user gesture */ });
  }, { once: true });
}

async function openFile(file) {
  if (!file) return;
  if (host && host.registerDroppedFile) {
    const p = await host.registerDroppedFile(file);
    if (p) return openPayload(p);
  }
  openPayload({ url: URL.createObjectURL(file), name: file.name });
}

async function openDialog() {
  if (host) openPayload(await host.openVideoDialog());
  else if (server) openLibrary();
  else $('fileInput').click();
}

$('fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('openBtn').onclick = openDialog;
if (host) {
  host.onOpenFile(openPayload);
  host.onShowHelp(() => { $('help').hidden = false; });
}

video.addEventListener('error', () => {
  const err = video.error;
  toast(err && err.code === 4
    ? 'This codec/container is not supported. Try MP4 (H.264/H.265/AV1) or WebM (VP9/AV1).'
    : 'Could not play this file.', 6000);
});

// Drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (f.name.toLowerCase().endsWith('.onnx')) loadModelFile(f);
  else openFile(f);
});

// ------------------------------------------------------------------------------------------------
// Frame tracking
function watchFrames() {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
  const cb = () => { newFrame = true; video.requestVideoFrameCallback(cb); };
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

function flatRect() {
  const cw = canvas.width, ch = canvas.height;
  const a = eyeAspect(video.videoWidth, video.videoHeight, F.stereo);
  let w = cw, h = cw / a;
  if (h > ch) { h = ch; w = ch * a; }
  return [Math.round((cw - w) / 2), Math.round((ch - h) / 2), Math.round(w), Math.round(h)];
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

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
}

function drawDesktop() {
  const cw = canvas.width, ch = canvas.height;
  const P = perspective(S.fov * Math.PI / 180, cw / ch);
  const V = multiply(rotX(-pitch), rotY(-yaw));
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
  if (server) { try { return await (await fetch('/api/models')).json(); } catch { return []; } }
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
$('statsBtn').onclick = toggleStats;
$('helpBtn').onclick = () => { $('help').hidden = false; };
$('helpClose').onclick = () => { $('help').hidden = true; };
$('help').onclick = (e) => { if (e.target.id === 'help') $('help').hidden = true; };
$('gearBtn').onclick = () => { $('panel').hidden = !$('panel').hidden; };
$('panelClose').onclick = () => { $('panel').hidden = true; };

// Transport
function togglePlay() {
  if (!video.src) return openDialog();
  if (video.paused) video.play(); else video.pause();
}
function seekBy(s) { if (video.duration) video.currentTime = Math.max(0, Math.min(video.duration - 0.05, video.currentTime + s)); }
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
function setSpeed(dir) {
  const i = Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(video.playbackRate) + dir));
  video.playbackRate = SPEEDS[i] ?? 1;
  $('speedBtn').textContent = video.playbackRate + '×';
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
}
function recenter() { yaw = 0; pitch = 0; if (xr.active) xr.recenter(); }
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
$('speedBtn').onclick = () => { const i = SPEEDS.indexOf(video.playbackRate); video.playbackRate = SPEEDS[(i + 1) % SPEEDS.length]; $('speedBtn').textContent = video.playbackRate + '×'; };
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
$('seek').addEventListener('input', (e) => { seeking = true; if (video.duration) video.currentTime = (e.target.value / 1000) * video.duration; });
$('seek').addEventListener('change', () => { seeking = false; });
$('seek').addEventListener('mousemove', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  $('seekTip').style.left = f * 100 + '%';
  $('seekTip').textContent = fmt(f * (video.duration || 0));
});
function updateTimeline() {
  const d = video.duration || 0;
  const f = d ? video.currentTime / d : 0;
  $('played').style.width = f * 100 + '%';
  if (!seeking) $('seek').value = Math.round(f * 1000);
  $('cur').textContent = fmt(video.currentTime);
  $('dur').textContent = fmt(d);
  if (d && video.buffered.length) $('buffered').style.width = (video.buffered.end(video.buffered.length - 1) / d) * 100 + '%';
}

function renderStats() {
  const o = renderer.output;
  const lines = [
    `source   ${video.videoWidth}×${video.videoHeight}  ${fmtLabel()}`,
    `output   ${o ? o.w + '×' + o.h : '-'}  (${S.upscale}${S.upscale !== 'off' ? ' ' + lastScale + '×' : ''})`,
    `frames   ${stats.fps.toFixed(1)} fps decoded`,
    `display  ${canvas.width}×${canvas.height}  fov ${S.fov}°`,
  ];
  if (ai.ready) lines.push(`ai       ${ai.modelName} ${ai.scale}× ${ai.backend}`, `ai frame ${(stats.aiMs / 1000).toFixed(2)} s / ${stats.aiTiles} tiles`);
  if (xr.active) lines.push('xr       headset active');
  $('stats').textContent = lines.join('\n');
  updateUpBadge();
}

// Look-around, compare divider, click-to-play
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const nearSplit = compare && S.upscale !== 'off' && Math.abs(e.clientX - splitPos * canvas.clientWidth) < 14;
  drag = { x: e.clientX, y: e.clientY, moved: false, split: nearSplit };
  if (F.projection !== 'flat' && !nearSplit) canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (compare) canvas.style.cursor = Math.abs(e.clientX - splitPos * canvas.clientWidth) < 14 ? 'ew-resize' : '';
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.split) { splitPos = Math.max(0.02, Math.min(0.98, e.clientX / canvas.clientWidth)); }
  else if (F.projection !== 'flat') {
    const k = (S.fov * Math.PI / 180) / canvas.clientHeight;
    yaw += dx * k;
    pitch = Math.max(-1.55, Math.min(1.55, pitch + dy * k));
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
canvas.addEventListener('pointerup', () => {
  if (drag && !drag.moved && !drag.split) {
    pendingClick = setTimeout(togglePlay, 220);   // cancelled by dblclick
  }
  drag = null;
  canvas.classList.remove('dragging');
});
let pendingClick = 0;
canvas.addEventListener('dblclick', () => { clearTimeout(pendingClick); toggleFullscreen(); });
canvas.addEventListener('wheel', (e) => {
  if (F.projection === 'flat') return;
  e.preventDefault();
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
window.addEventListener('keydown', wake);
video.addEventListener('pause', wake);

// Keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text], input[type=search], select') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  const handled = true;
  switch (k) {
    case ' ': case 'k': case 'K': togglePlay(); break;
    case 'ArrowLeft': seekBy(-5); break;
    case 'ArrowRight': seekBy(5); break;
    case 'j': case 'J': seekBy(-10); break;
    case 'l': case 'L': seekBy(10); break;
    case ',': stepFrame(-1); break;
    case '.': stepFrame(1); break;
    case 'ArrowUp': S.volume = Math.min(1, S.volume + 0.05); S.muted = false; persist(); syncUI(); toast(`Volume ${Math.round(S.volume * 100)}%`); break;
    case 'ArrowDown': S.volume = Math.max(0, S.volume - 0.05); persist(); syncUI(); toast(`Volume ${Math.round(S.volume * 100)}%`); break;
    case 'm': case 'M': $('muteBtn').click(); break;
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
    case '[': setSpeed(-1); toast(`Speed ${video.playbackRate}×`); break;
    case ']': setSpeed(1); toast(`Speed ${video.playbackRate}×`); break;
    case '?': $('help').hidden = !$('help').hidden; break;
    case 'Escape': $('help').hidden = true; $('panel').hidden = true; $('library').hidden = true; closePops(); break;
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
// Server edition: media library
let libPath = load('lumen.libPath', '/');
const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="currentColor" opacity=".85"/></svg>';
const ICON_VIDEO = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor"/></svg>';
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
function vrTag(name) {
  const f = detectFormat(name, 0, 0);
  if (f.projection === 'flat') return f.stereo === 'mono' ? '' : '3D';
  return { equi360: '360°', equi180: '180°', fisheye180: '180°' }[f.projection] + (f.stereo !== 'mono' ? ' 3D' : '');
}

async function openLibrary(path = libPath) {
  $('library').hidden = false;
  if (!$('libSearch').value) await showFolder(path);
  setTimeout(() => $('libSearch').focus(), 50);
}

async function showFolder(path, query = '') {
  const list = $('libList');
  list.innerHTML = '<div class="empty">Loading…</div>';
  let data;
  try {
    const r = await fetch(query ? '/api/library?q=' + encodeURIComponent(query) : '/api/library?path=' + encodeURIComponent(path));
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
  for (const v of data.videos) {
    const b = document.createElement('button');
    const tag = vrTag(v.name);
    b.innerHTML = `${ICON_VIDEO}<span class="name">${esc(v.name)}</span>${tag ? `<span class="tag">${tag}</span>` : ''}<span class="meta">${fmtSize(v.size)}</span>`;
    b.onclick = () => { $('library').hidden = true; openPayload({ url: v.url, name: v.name }); };
    list.append(b);
  }
  if (!data.folders.length && !data.videos.length) list.innerHTML += `<div class="empty">${query ? 'No matching videos.' : 'No videos in this folder.'}</div>`;
}

let libSearchTimer = 0;
$('libSearch').addEventListener('input', (e) => {
  clearTimeout(libSearchTimer);
  const q = e.target.value.trim();
  libSearchTimer = setTimeout(() => showFolder(libPath, q), 250);
});
$('libClose').onclick = () => { $('library').hidden = true; };
$('library').onclick = (e) => { if (e.target.id === 'library') $('library').hidden = true; };
$('libLocal').onclick = () => { $('library').hidden = true; $('fileInput').click(); };

async function detectServer() {
  if (host) return;
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    const info = r.ok ? await r.json() : null;
    if (!info || !info.server) return;
    server = info;
    $('openBtn').lastChild.textContent = 'Browse library';
    $('modelFolder').hidden = true;
    const insecure = location.protocol === 'http:' && info.https;
    $('libHint').textContent = insecure
      ? `For VR headsets use https://${location.hostname}:${info.https}`
      : `Lumen server ${info.version}`;
    if (insecure && $('vrBtn').disabled) $('vrBtn').title = `VR needs the secure address: https://${location.hostname}:${info.https}`;
    refreshModelList();
  } catch { /* plain static hosting */ }
}
detectServer();

// ------------------------------------------------------------------------------------------------
// Updates (desktop app only)
const upd = host && host.updates;
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

syncUI();
if (S.upscale === 'ai') { S.upscale = 'gpu'; syncUI(); }   // AI is re-enabled explicitly each session (model load can be slow)

// Expose for automated tests / debugging.
window.__lumen = { renderer, ai, F, S, setFormat, setUpscale, openPayload, loadModel, state: () => ({ yaw, pitch, aiValid, lastScale }) };
