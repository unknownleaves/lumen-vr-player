// M3U / M3U8 handling.
// Two very different things share these extensions:
//   • an HLS stream playlist (#EXT-X-… tags, lists media segments) → play it as one video/live stream
//   • a channel / media list (IPTV, #EXTINF entries pointing at streams or files) → browse it like a library

const HLS_TAGS = /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|MEDIA|PLAYLIST-TYPE|KEY|MAP|I-FRAME-STREAM-INF|INDEPENDENT-SEGMENTS|VERSION)/i;

export function isHlsPlaylist(text) {
  return HLS_TAGS.test(String(text || '').slice(0, 20000));
}

const isAbsolute = (u) => /^[a-z][a-z0-9+.-]*:\/\//i.test(u);

function resolve(ref, base) {
  if (isAbsolute(ref)) return ref;
  if (base && isAbsolute(base)) {
    try { return new URL(ref, base).href; } catch { /* fall through */ }
  }
  return ref;   // relative to a local file: the caller decides
}

function attrs(s) {
  const out = {};
  const re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2];
  return out;
}

function nameFromUrl(u) {
  try {
    const p = decodeURIComponent((isAbsolute(u) ? new URL(u).pathname : u).split(/[\\/]/).pop() || '');
    return p || u;
  } catch { return u; }
}

/**
 * Parse a channel/media list.
 * Returns [{ name, url, group, logo, duration }] — url may be relative (for local playlists).
 */
export function parseM3U(text, baseUrl = '') {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const items = [];
  let pending = null;
  let groupFromExtgrp = '';
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const colon = line.indexOf(':');
      const body = colon >= 0 ? line.slice(colon + 1) : '';
      // The title starts after the first comma that is outside quoted attributes (titles may contain commas).
      let inQ = false, cut = -1;
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '"') inQ = !inQ;
        else if (body[i] === ',' && !inQ) { cut = i; break; }
      }
      const head = cut >= 0 ? body.slice(0, cut) : body;
      const title = cut >= 0 ? body.slice(cut + 1).trim() : '';
      const a = attrs(head);
      const dur = parseFloat(head);
      pending = { name: title || a['tvg-name'] || '', group: a['group-title'] || '', logo: a['tvg-logo'] || '', duration: isFinite(dur) && dur > 0 ? dur : 0 };
      continue;
    }
    if (line.startsWith('#EXTGRP:')) { groupFromExtgrp = line.slice(8).trim(); continue; }
    if (line.startsWith('#')) continue;   // other tags (#EXTM3U, #EXTVLCOPT, …)
    // Placeholders such as "[NO PUBLIC STREAM]" or free text are not links: skip the entry.
    if (/^\[.*\]$/.test(line) || (!isAbsolute(line) && /\s/.test(line))) { pending = null; groupFromExtgrp = ''; continue; }
    const url = resolve(line, baseUrl);
    const it = pending || { name: '', group: '', logo: '', duration: 0 };
    if (!it.group && groupFromExtgrp) it.group = groupFromExtgrp;
    it.name = it.name || nameFromUrl(line);
    it.url = url;
    items.push(it);
    pending = null;
    groupFromExtgrp = '';
  }
  return items;
}

/** Group names in first-seen order with counts. */
export function groupsOf(items) {
  const map = new Map();
  for (const it of items) map.set(it.group || '', (map.get(it.group || '') || 0) + 1);
  return [...map.entries()].map(([name, count]) => ({ name, count }));
}

export const looksLikeM3U = (name) => /\.m3u8?(\?|#|$)/i.test(String(name || ''));
/** Any playlist file the app can open as a list: M3U/M3U8, PLS (Shoutcast), XSPF, ASX/WAX/WVX (Windows Media). */
export const looksLikeList = (name) => /\.(m3u8?|pls|xspf|asx|wax|wvx)(\?|#|$)/i.test(String(name || ''));
export const isDashUrl = (u) => /\.mpd(\?|#|$)/i.test(String(u || ''));
/** Stream links FFmpeg can open: HTTP(S) (HLS, DASH, MPEG-TS, Icecast…), RTSP, RTMP(S/T/TS), MMS, UDP/RTP/SRT/RIST, TCP. */
export const STREAM_SCHEMES = ['http', 'https', 'rtsp', 'rtsps', 'rtmp', 'rtmps', 'rtmpt', 'rtmpts', 'mms', 'mmsh', 'mmst', 'udp', 'udplite', 'rtp', 'srtp', 'srt', 'rist', 'tcp'];
const STREAM_RE = new RegExp('^(' + STREAM_SCHEMES.join('|') + '):\\/\\/', 'i');
export const isStreamUrl = (u) => STREAM_RE.test(String(u || ''));

// ---- Other playlist formats -------------------------------------------------------------------
/** PLS (Shoutcast / Winamp): File1=…, Title1=… */
export function parsePLS(text, baseUrl = '') {
  const files = {}, titles = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*(File|Title)(\d+)\s*=\s*(.*)$/i.exec(raw);
    if (!m) continue;
    (m[1].toLowerCase() === 'file' ? files : titles)[m[2]] = m[3].trim();
  }
  return Object.keys(files).sort((a, b) => a - b).map((k) => ({
    name: titles[k] || nameFromUrl(files[k]), url: resolve(files[k], baseUrl), group: '', logo: '', duration: 0,
  }));
}

const xmlText = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

/** XSPF (VLC and others): <track><location>…</location><title>…</title></track> */
export function parseXSPF(text, baseUrl = '') {
  const out = [];
  const re = /<track\b[^>]*>([\s\S]*?)<\/track>/gi;
  let m;
  while ((m = re.exec(text))) {
    const loc = /<location>([\s\S]*?)<\/location>/i.exec(m[1]);
    if (!loc) continue;
    const title = /<title>([\s\S]*?)<\/title>/i.exec(m[1]);
    const url = resolve(xmlText(loc[1]), baseUrl);
    out.push({ name: title ? xmlText(title[1]) : nameFromUrl(url), url, group: '', logo: '', duration: 0 });
  }
  return out;
}

/** ASX / WAX / WVX (Windows Media): <entry><title/><ref href="…"/></entry> */
export function parseASX(text, baseUrl = '') {
  const out = [];
  const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = re.exec(text))) {
    const ref = /<ref\b[^>]*href\s*=\s*"([^"]+)"/i.exec(m[1]);
    if (!ref) continue;
    const title = /<title>([\s\S]*?)<\/title>/i.exec(m[1]);
    const url = resolve(xmlText(ref[1]), baseUrl);
    out.push({ name: title ? xmlText(title[1]) : nameFromUrl(url), url, group: '', logo: '', duration: 0 });
  }
  return out;
}

/** Detect the list format from its content and parse it. */
export function parsePlaylist(text, baseUrl = '') {
  const head = String(text || '').replace(/^\uFEFF/, '').trimStart().slice(0, 400).toLowerCase();
  if (head.startsWith('[playlist]') || /^file1\s*=/m.test(head)) return parsePLS(text, baseUrl);
  if (head.includes('<playlist') && head.includes('xspf')) return parseXSPF(text, baseUrl);
  if (head.startsWith('<asx') || head.includes('<asx')) return parseASX(text, baseUrl);
  return parseM3U(text, baseUrl);
}

/** Links people copy from a browser → the file behind them (GitHub / GitLab "blob" pages, Dropbox shares). */
export function directListUrl(u) {
  const s = String(u || '').trim();
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i.exec(s);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3].replace(/[?#].*$/, '')}`;
  m = /^https?:\/\/gitlab\.com\/(.+?)\/-\/blob\/(.+)$/i.exec(s);
  if (m) return `https://gitlab.com/${m[1]}/-/raw/${m[2].replace(/[?#].*$/, '')}`;
  if (/^https?:\/\/(www\.)?dropbox\.com\//i.test(s)) return s.replace(/([?&])dl=0/, '$1dl=1') + (/[?&]dl=/.test(s) ? '' : (s.includes('?') ? '&' : '?') + 'dl=1');
  return s;
}

/** Web pages of video sites (not streams): they need site-specific tools no player engine has. */
export const isVideoSitePage = (u) => /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|twitch\.tv|facebook\.com|tiktok\.com|dailymotion\.com)\//i.test(String(u || ''));
