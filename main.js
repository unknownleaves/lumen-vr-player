'use strict';
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileResponse, safeJoin } = require('./lib/serve');
const { setupUpdater } = require('./lib/updater');
const media = require('./lib/media');
const { Readable } = require('stream');

const APP_ROOT = __dirname;
const APP_ID = 'io.lumen.vrplayer';   // must match "appId" in package.json

// Windows groups taskbar buttons, pins and jump lists by AppUserModelID. Using the same ID as the
// installer's shortcuts means the running window, the Start-menu entry and a pinned taskbar icon
// are all recognised as one app and always show the Lumen icon.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
const WINDOW_ICON = path.join(APP_ROOT, 'src', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'vob', '3gp', 'divx', 'asf', 'f4v', 'rm', 'rmvb'];
// Cross-origin isolation lets ONNX Runtime use multi-threaded WASM (SharedArrayBuffer).
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// ---- Chromium feature switches -------------------------------------------------
// Keep Windows and macOS on Chromium's default, well-tested GPU and video paths. Forcing Vulkan or
// ignoring the GPU blocklist there causes video corruption and stutter on many drivers.
// WebXR through OpenXR: SteamVR, Meta Quest Link/Air Link, Windows Mixed Reality, Pico Connect…
const features = ['WebXR', 'OpenXR', 'PlatformHEVCDecoderSupport'];
if (process.platform === 'linux') {
  // Linux: hardware video decoding (VA-API) and Vulkan for WebGPU (AI upscaler) are opt-in.
  features.push('VaapiVideoDecoder', 'VaapiVideoDecodeLinuxGL', 'Vulkan');
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
}
app.commandLine.appendSwitch('enable-features', features.join(','));
app.commandLine.appendSwitch('force_high_performance_gpu');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// Only files the user explicitly opened (or the models folders) can be served to the renderer.
const allowedFiles = new Set();
let mainWindow = null;
let pendingOpen = [];
let updater = null;

function modelDirs() {
  const user = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(user, { recursive: true });
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(APP_ROOT, 'models');
  return [user, bundled];
}

function fileUrl(p) {
  allowedFiles.add(path.resolve(p));
  return 'app://file/' + encodeURIComponent(path.resolve(p));
}

function isVideoPath(p) {
  return typeof p === 'string' && VIDEO_EXT.includes(path.extname(p).slice(1).toLowerCase()) && fs.existsSync(p);
}

function sendOpen(p) {
  allowedFiles.add(path.resolve(p));
  const payload = { name: path.basename(p), path: path.resolve(p) };
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('open-file', payload);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingOpen.push(payload);
  }
}

function handleProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const range = request.headers.get('range');
    if (url.host === 'bundle') {
      const full = safeJoin(APP_ROOT, url.pathname);
      if (!full) return new Response('Forbidden', { status: 403 });
      return fileResponse(full, range, ISOLATION);
    }
    if (url.host === 'file') {
      const p = path.resolve(decodeURIComponent(url.pathname.slice(1)));
      const inModels = modelDirs().some((d) => !path.relative(d, p).startsWith('..') && !path.isAbsolute(path.relative(d, p)));
      if (!allowedFiles.has(p) && !inModels) return new Response('Forbidden', { status: 403 });
      return fileResponse(p, range, ISOLATION);
    }
    if (url.host === 'stream') {
      // On-the-fly remux / transcode through FFmpeg for formats Chromium can't play natively.
      const p = path.resolve(decodeURIComponent(url.pathname.slice(1)));
      if (!allowedFiles.has(p)) return new Response('Forbidden', { status: 403 });
      const q = url.searchParams;
      let child;
      try {
        child = media.stream(p, { mode: q.get('mode') === 'transcode' ? 'transcode' : 'remux', copyAudio: q.get('copyAudio') === '1', start: Math.max(0, +q.get('start') || 0), codec: q.get('codec') || '', maxWidth: Math.max(0, Math.min(7680, +q.get('maxWidth') || 0)) });
      } catch (e) {
        return new Response(e.message, { status: 500 });
      }
      const out = child.stdout;
      out.on('close', () => child.kill('SIGKILL'));
      return new Response(Readable.toWeb(out), { status: 200, headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', ...ISOLATION } });
    }
    return new Response('Not found', { status: 404 });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#07080b',
    title: 'Lumen VR Player',
    icon: WINDOW_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.loadURL('app://bundle/src/index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    for (const p of pendingOpen) mainWindow.webContents.send('open-file', p);
    pendingOpen = [];
  });
  // Never navigate away from the player or open arbitrary windows.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Grant permission requests (fullscreen, WebXR, …) only to the player's own bundled page.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, cb, details) => {
    cb((details.requestingUrl || '').startsWith('app://bundle/'));
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Videos…', accelerator: 'CmdOrCtrl+O', click: () => openVideoDialog().then((list) => list.forEach((r, i) => mainWindow.webContents.send('open-file', { ...r, enqueue: i > 0 }))) },
        { label: 'Open AI Models Folder', click: () => shell.openPath(modelDirs()[0]) },
        { label: 'Check for Updates…', click: () => { mainWindow.webContents.send('show-updates'); if (updater) updater.check(); } },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'reload' }, { role: 'toggleDevTools' }] },
    { role: 'help', submenu: [{ label: 'Keyboard shortcuts', click: () => mainWindow.webContents.send('show-help') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openVideoDialog() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open videos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => { allowedFiles.add(path.resolve(p)); return { name: path.basename(p), path: path.resolve(p) }; });
}

/** Probe a file and return the URL the player should load (direct file or FFmpeg stream). */
async function prepare(p, caps) {
  if (typeof p !== 'string' || !fs.existsSync(p)) return { error: 'File not found: ' + p };
  const full = path.resolve(p);
  allowedFiles.add(full);
  const d = await media.describe(full, caps || {});
  const url = d.mode === 'direct'
    ? fileUrl(full)
    : `app://stream/${encodeURIComponent(full)}?mode=${d.mode}&copyAudio=${d.copyAudio ? 1 : 0}&codec=${encodeURIComponent(d.videoCodec)}`;
  return { ...d, url, name: path.basename(full), path: full, streamed: d.mode !== 'direct' };
}

// ---- IPC -----------------------------------------------------------------------
ipcMain.handle('open-video-dialog', () => openVideoDialog());
ipcMain.handle('register-path', (_e, p) => {
  if (typeof p !== 'string' || !fs.existsSync(p)) return null;
  allowedFiles.add(path.resolve(p));
  return { name: path.basename(p), path: path.resolve(p) };
});
ipcMain.handle('prepare', (_e, p, caps) => prepare(p, caps));
ipcMain.handle('list-models', () => {
  const out = [];
  for (const dir of modelDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { /* missing */ }
    for (const f of entries) {
      if (f.toLowerCase().endsWith('.onnx')) out.push({ name: f, url: 'app://file/' + encodeURIComponent(path.join(dir, f)) });
    }
  }
  return out;
});
ipcMain.handle('open-models-folder', () => shell.openPath(modelDirs()[0]));
ipcMain.handle('open-model-dialog', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Load ONNX super-resolution model',
    properties: ['openFile'],
    filters: [{ name: 'ONNX model', extensions: ['onnx'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const p = res.filePaths[0];
  return { name: path.basename(p), url: fileUrl(p) };
});

// ---- App lifecycle -------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const p = argv.slice(1).reverse().find(isVideoPath);
    if (p) sendOpen(p);
    else if (mainWindow) mainWindow.focus();
  });
  // macOS: file dropped on dock icon / "Open With"
  app.on('open-file', (e, p) => { e.preventDefault(); sendOpen(p); });

  app.whenReady().then(() => {
    handleProtocol();
    updater = setupUpdater(() => mainWindow);
    buildMenu();
    createWindow();
    const p = process.argv.slice(app.isPackaged ? 1 : 2).find(isVideoPath);
    if (p) sendOpen(p);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
