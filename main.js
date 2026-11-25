'use strict';
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileResponse, safeJoin } = require('./lib/serve');

const APP_ROOT = __dirname;
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv'];
// Cross-origin isolation lets ONNX Runtime use multi-threaded WASM (SharedArrayBuffer).
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// ---- Chromium feature switches -------------------------------------------------
// WebXR through OpenXR (SteamVR, Meta Quest Link/Air Link, Windows Mixed Reality, Pico Connect…)
app.commandLine.appendSwitch('enable-features', 'WebXR,OpenXR,Vulkan,VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,PlatformHEVCDecoderSupport');
// WebGPU powers the AI upscaler. It is on by default on Windows/macOS; Linux still needs this.
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('force_high_performance_gpu');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// Only files the user explicitly opened (or the models folders) can be served to the renderer.
const allowedFiles = new Set();
let mainWindow = null;
let pendingOpen = [];

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
  const payload = { url: fileUrl(p), name: path.basename(p), path: p };
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
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
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
        { label: 'Open Video…', accelerator: 'CmdOrCtrl+O', click: () => openVideoDialog().then((r) => r && mainWindow.webContents.send('open-file', r)) },
        { label: 'Open AI Models Folder', click: () => shell.openPath(modelDirs()[0]) },
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
    title: 'Open video',
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const p = res.filePaths[0];
  return { url: fileUrl(p), name: path.basename(p), path: p };
}

// ---- IPC -----------------------------------------------------------------------
ipcMain.handle('open-video-dialog', () => openVideoDialog());
ipcMain.handle('register-path', (_e, p) => (typeof p === 'string' && fs.existsSync(p) ? { url: fileUrl(p), name: path.basename(p), path: p } : null));
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
    buildMenu();
    createWindow();
    const p = process.argv.slice(app.isPackaged ? 1 : 2).find(isVideoPath);
    if (p) sendOpen(p);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
