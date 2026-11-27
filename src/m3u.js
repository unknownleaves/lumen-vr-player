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
export const isStreamUrl = (u) => /^(https?|rtsps?|rtmps?|udp|srt|rtp):\/\//i.test(String(u || ''));
