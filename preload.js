'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lumen', {
  isDesktop: true,
  platform: process.platform,
  openVideoDialog: () => ipcRenderer.invoke('open-video-dialog'),
  openModelDialog: () => ipcRenderer.invoke('open-model-dialog'),
  listModels: () => ipcRenderer.invoke('list-models'),
  openModelsFolder: () => ipcRenderer.invoke('open-models-folder'),
  // Turn a dropped File into a streamable app:// URL (keeps seeking fast for huge VR files).
  prepare: (p, caps) => ipcRenderer.invoke('prepare', p, caps),
  fetchText: (u) => ipcRenderer.invoke('fetch-text', u),
  readText: (p) => ipcRenderer.invoke('read-text', p),
  allowPath: (p) => ipcRenderer.invoke('allow-path', p),
  onShowStreamDialog: (cb) => ipcRenderer.on('show-stream-dialog', () => cb()),
  registerDroppedFile: (file) => {
    try { return ipcRenderer.invoke('register-path', webUtils.getPathForFile(file)); } catch { return Promise.resolve(null); }
  },
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, payload) => cb(payload)),
  onShowHelp: (cb) => ipcRenderer.on('show-help', () => cb()),
  updates: {
    get: () => ipcRenderer.invoke('update-get'),
    check: () => ipcRenderer.invoke('update-check'),
    install: () => ipcRenderer.invoke('update-install'),
    openPage: () => ipcRenderer.invoke('update-open-page'),
    setAuto: (on) => ipcRenderer.invoke('update-set-auto', !!on),
    onStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
    onShow: (cb) => ipcRenderer.on('show-updates', () => cb()),
  },
});
