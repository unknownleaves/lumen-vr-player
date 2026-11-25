'use strict';
// Pure Node helpers for the app:// protocol: MIME types and HTTP Range support.
// Kept free of Electron imports so it can be unit-tested with plain Node.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.vtt': 'text/vtt',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Parse a single "bytes=a-b" range. Returns {start,end} | 'invalid' | null (no range). */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start, end;
  if (m[1] === '') {            // suffix range: last N bytes
    const n = parseInt(m[2], 10);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Build a WHATWG Response for a file on disk, honouring Range requests (needed for video seeking). */
async function fileResponse(filePath, rangeHeader, extraHeaders = {}) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const size = stat.size;
  const type = mimeFor(filePath);
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  if (range) {
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Accept-Ranges': 'bytes',
        ...extraHeaders,
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', ...extraHeaders },
  });
}

/** Resolve a URL path inside root, refusing anything that escapes it. */
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = path.resolve(root, decoded);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

module.exports = { mimeFor, parseRange, fileResponse, safeJoin };
