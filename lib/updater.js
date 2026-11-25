'use strict';
// In-app updates from GitHub Releases.
//
//  • Windows installer, Linux AppImage and Linux .deb: downloaded in the background with
//    electron-updater and installed on restart (or when the app quits).
//  • macOS (unsigned builds), Windows portable .exe and Linux .tar.gz can't replace
//    themselves, so the app checks GitHub and offers a "Download" button instead.

const { app, ipcMain, shell, net } = require('electron');
const fs = require('fs');
const path = require('path');

const OWNER = 'unknownleaves';
const REPO = 'lumen-vr-player';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const RECHECK_MS = 6 * 60 * 60 * 1000;

/** Compare "1.2.3" style versions (pre-release suffixes sort before the release). */
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre] = String(v).replace(/^v/i, '').split('-', 2);
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const d = (A.nums[i] || 0) - (B.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

/** Can this particular installation replace itself? */
function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux') {
    // AppImage sets $APPIMAGE; electron-builder writes resources/package-type for .deb/.rpm.
    return !!process.env.APPIMAGE || fs.existsSync(path.join(process.resourcesPath, 'package-type'));
  }
  return false;   // macOS auto-install requires a code-signed app
}

function setupUpdater(getWindow) {
  let status = { state: 'idle' };
  let autoUpdater = null;
  let timer = null;
  let checking = false;
  const selfUpdate = canSelfUpdate();

  const send = (s) => {
    status = { ...s, current: app.getVersion(), mode: selfUpdate && autoUpdater ? 'auto' : 'manual' };
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('update-status', status);
  };

  if (selfUpdate) {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease = false;
      autoUpdater.logger = null;
      autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
      autoUpdater.on('update-available', (info) => send({ state: 'downloading', version: info.version, percent: 0, notes: notesText(info.releaseNotes) }));
      autoUpdater.on('update-not-available', () => send({ state: 'up-to-date' }));
      autoUpdater.on('download-progress', (p) => send({ ...status, state: 'downloading', percent: Math.round(p.percent || 0), bps: p.bytesPerSecond }));
      autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version, notes: notesText(info.releaseNotes) }));
      autoUpdater.on('error', (e) => {
        // Fall back to a plain GitHub check so the user still hears about new versions.
        manualCheck().catch(() => send({ state: 'error', message: shortError(e) }));
      });
    } catch {
      autoUpdater = null;   // electron-updater missing (e.g. dev checkout without npm install)
    }
  }

  async function manualCheck() {
    send({ state: 'checking' });
    const res = await net.fetch(API_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${REPO}/${app.getVersion()}` } });
    if (res.status === 404) { send({ state: 'up-to-date' }); return; }   // no releases published yet
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    if (latest && compareVersions(latest, app.getVersion()) > 0) {
      send({ state: 'available', version: latest, notes: notesText(rel.body), url: pickAsset(rel) || rel.html_url || RELEASES_URL });
    } else {
      send({ state: 'up-to-date' });
    }
  }

  async function check() {
    if (checking) return status;
    checking = true;
    try {
      if (selfUpdate && autoUpdater) await autoUpdater.checkForUpdates();
      else await manualCheck();
    } catch (e) {
      try { await manualCheck(); } catch { send({ state: 'error', message: shortError(e) }); }
    } finally {
      checking = false;
    }
    return status;
  }

  ipcMain.handle('update-get', () => ({ ...status, current: app.getVersion(), mode: selfUpdate && autoUpdater ? 'auto' : 'manual', packaged: app.isPackaged }));
  ipcMain.handle('update-check', () => check());
  ipcMain.handle('update-install', () => {
    if (status.state === 'ready' && autoUpdater) { setImmediate(() => autoUpdater.quitAndInstall(false, true)); return true; }
    shell.openExternal(status.url || RELEASES_URL);
    return false;
  });
  ipcMain.handle('update-open-page', () => shell.openExternal(status.url || RELEASES_URL));
  ipcMain.handle('update-set-auto', (_e, enabled) => {
    clearInterval(timer);
    timer = null;
    if (enabled && app.isPackaged) {
      setTimeout(check, 4000);
      timer = setInterval(check, RECHECK_MS);
    }
    return true;
  });

  return { check };
}

function notesText(n) {
  if (!n) return '';
  if (Array.isArray(n)) n = n.map((x) => x.note || '').join('\n');
  return String(n).replace(/<[^>]+>/g, '').trim().slice(0, 1200);
}

function shortError(e) {
  const m = String((e && e.message) || e || 'Unknown error');
  if (/ENOTFOUND|ENETUNREACH|ECONNREFUSED|ERR_INTERNET_DISCONNECTED|net::/.test(m)) return 'No internet connection';
  return m.split('\n')[0].slice(0, 200);
}

/** Direct link to the right download for this OS, when the release has one. */
function pickAsset(rel) {
  const assets = rel.assets || [];
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const tests = {
    darwin: [/\.dmg$/i],
    win32: [new RegExp(`portable.*\\.exe$`, 'i'), /\.exe$/i],
    linux: [/\.AppImage$/i, /\.deb$/i],
  }[process.platform] || [];
  for (const t of tests) {
    const matches = assets.filter((a) => t.test(a.name));
    const best = matches.find((a) => a.name.includes(arch)) || matches[0];
    if (best) return best.browser_download_url;
  }
  return null;
}

module.exports = { setupUpdater, compareVersions };
