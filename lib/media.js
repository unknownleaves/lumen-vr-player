'use strict';
// FFmpeg integration shared by the desktop app and the server edition:
//   probe()  – read container, codecs, duration and VR metadata of any video file
//   plan()   – decide whether the viewer's browser can play it directly, or it needs remuxing / transcoding
//   stream() – start an FFmpeg process that outputs browser-playable fragmented MP4 from a given time

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let ffmpegPath;   // undefined = not looked up yet, null = unavailable

/** Find a working ffmpeg: $LUMEN_FFMPEG, the system one, then the copy bundled with the app. */
function findFfmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const candidates = [];
  if (process.env.LUMEN_FFMPEG) candidates.push(process.env.LUMEN_FFMPEG);
  candidates.push(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  try {
    let bundled = require('ffmpeg-static');
    if (bundled) candidates.push(bundled.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep));
  } catch { /* not installed (server image uses the system ffmpeg) */ }
  ffmpegPath = null;
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 8000, windowsHide: true });
      if (r.status === 0) { ffmpegPath = c; break; }
    } catch { /* try next */ }
  }
  return ffmpegPath;
}

function parseProbe(text) {
  const out = { duration: 0, container: '', video: null, audio: null, spherical: null, stereo: null };
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) out.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
  const c = /Input #0, (.+?), from /.exec(text);
  if (c) out.container = c[1];
  for (const line of text.split('\n')) {
    if (!out.video && /Stream #0:\d+.*?: Video: /.test(line) && !/attached pic/.test(line)) {
      const m = /Video: (\w+)/.exec(line);
      const s = /, (\d{2,5})x(\d{2,5})[,\s[]/.exec(line);
      out.video = { codec: m[1], width: s ? +s[1] : 0, height: s ? +s[2] : 0 };
    } else if (!out.audio && /Stream #0:\d+.*?: Audio: /.test(line)) {
      out.audio = { codec: /Audio: (\w+)/.exec(line)[1] };
    }
  }
  const sph = /spherical: ([^\n]+)/i.exec(text);
  if (sph) {
    const t = sph[1].toLowerCase();
    out.spherical = t.includes('fisheye') ? 'fisheye180' : (t.includes('tiled') || t.includes('half') ? 'equi180' : 'equi360');
  }
  const st = /stereo3d: ([^\n]+)/i.exec(text);
  if (st) {
    const t = st[1].toLowerCase();
    out.stereo = t.includes('top') ? 'tb' : t.includes('side') ? 'sbs' : null;
  }
  return out;
}

/** Probe a file with ffmpeg. Resolves to null when ffmpeg is unavailable. */
function probe(file) {
  const ff = findFfmpeg();
  if (!ff) return Promise.resolve(null);
  return new Promise((resolve) => {
    const p = spawn(ff, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (b) => { if (err.length < 200000) err += b; });
    const t = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('close', () => { clearTimeout(t); resolve(parseProbe(err)); });
    p.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const COPY_AUDIO_TO_MP4 = new Set(['aac', 'mp3', 'opus']);

function videoPlayable(codec, caps) {
  if (['h264', 'vp8', 'vp9'].includes(codec)) return true;
  if (codec === 'av1') return caps.av1 !== false;
  if (codec === 'hevc') return !!caps.hevc;
  return false;
}

/**
 * Decide how to deliver a file.
 *   direct    – the browser can play the original file (fast seeking, no CPU cost)
 *   remux     – re-wrap the original video into MP4 (cheap); audio copied or converted to AAC
 *   transcode – convert the video to H.264 (CPU heavy; for old/unsupported codecs)
 * caps: { hevc, av1 } as reported by the viewer's browser.
 */
function plan(info, file, caps = {}) {
  const ext = path.extname(file).toLowerCase();
  if (!info || !info.video) {
    return { mode: 'direct', reason: info ? 'no video stream found' : 'ffmpeg unavailable' };
  }
  const v = info.video.codec, a = info.audio ? info.audio.codec : null;
  const vOk = videoPlayable(v, caps);
  const aOk = !a || DIRECT_AUDIO.has(a);
  const container = info.container || '';
  const isMp4 = /mov|mp4/.test(container) && ['.mp4', '.m4v', '.mov'].includes(ext);
  const isWebm = ext === '.webm' || (/webm/.test(container) && ['vp8', 'vp9', 'av1'].includes(v) && (!a || ['opus', 'vorbis'].includes(a)) && ext !== '.mkv');
  const isOgg = /ogg/.test(container);
  if (vOk && aOk && (isMp4 || isWebm || isOgg)) return { mode: 'direct' };
  if (vOk) return { mode: 'remux', copyAudio: !a || COPY_AUDIO_TO_MP4.has(a), reason: `${container} container` + (aOk ? '' : `, ${a} audio`) };
  return { mode: 'transcode', copyAudio: !a || COPY_AUDIO_TO_MP4.has(a), reason: `${v} video` };
}

let encoderCache;
/** Pick the fastest working H.264 encoder: the GPU's (NVIDIA / Intel / AMD / Apple) or x264 on the CPU. */
function pickEncoder() {
  if (encoderCache !== undefined) return encoderCache;
  encoderCache = 'libx264';
  const ff = findFfmpeg();
  if (!ff || process.env.LUMEN_ENCODER === 'libx264') return encoderCache;
  if (process.env.LUMEN_ENCODER) return (encoderCache = process.env.LUMEN_ENCODER);
  const candidates = process.platform === 'darwin' ? ['h264_videotoolbox']
    : process.platform === 'win32' ? ['h264_nvenc', 'h264_qsv', 'h264_amf'] : ['h264_nvenc', 'h264_qsv'];
  for (const enc of candidates) {
    try {
      const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=0.3',
        ...encoderArgs(enc, 1920), '-f', 'null', '-'], { timeout: 15000, windowsHide: true });
      if (r.status === 0) { encoderCache = enc; break; }
    } catch { /* not available */ }
  }
  return encoderCache;
}

function encoderArgs(enc, maxWidth) {
  const mbps = maxWidth > 2000 ? 20 : 8;
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p3', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-pix_fmt', 'nv12'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24', '-pix_fmt', 'yuv420p'];
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-b:v', `${mbps}M`, '-maxrate', `${mbps * 1.5}M`, '-bufsize', `${mbps * 2}M`, '-pix_fmt', 'yuv420p'];
    default: return ['-c:v', 'libx264', '-preset', 'superfast', '-tune', 'fastdecode', '-crf', '22', '-pix_fmt', 'yuv420p'];
  }
}

function ffmpegArgs(file, { mode, copyAudio, start = 0, codec, maxWidth = 0, encoder = 'libx264' }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  // GPU decoding where available (HEVC/AV1/VP9 are expensive on the CPU); ffmpeg falls back to software by itself.
  if (mode === 'transcode') args.push('-hwaccel', 'auto');
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');
  if (mode === 'transcode') {
    // CPU encoding is capped at 1080p so it can keep up in real time; GPU encoders can do 4K.
    const width = maxWidth || (encoder === 'libx264' ? 1920 : 3840);
    args.push(...encoderArgs(encoder, width), '-vf', `scale='min(${width},iw)':-2`, '-g', '60', '-bf', '0');
  } else {
    args.push('-c:v', 'copy');
    if (codec === 'hevc') args.push('-tag:v', 'hvc1');
  }
  if (copyAudio) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}

/** Spawn ffmpeg; returns the child process (stdout = fragmented MP4). Caller must kill it on disconnect. */
function stream(file, opts) {
  const ff = findFfmpeg();
  if (!ff) throw new Error('FFmpeg is not available');
  if (!fs.existsSync(file)) throw new Error('File not found');
  const args = ffmpegArgs(file, { ...opts, encoder: opts.mode === 'transcode' ? pickEncoder() : 'libx264' });
  const child = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (b) => { const s = String(b).trim(); if (s) console.warn('[ffmpeg]', s.slice(0, 300)); });
  return child;
}

/** Everything the player needs to know about a file, in one call. */
async function describe(file, caps) {
  const info = await probe(file);
  let p = plan(info, file, caps);
  if (caps && caps.force === 'transcode' && info && info.video) p = { mode: 'transcode', copyAudio: !info.audio || ['aac', 'mp3', 'opus'].includes(info.audio.codec), reason: 'forced' };
  return {
    duration: info ? info.duration : 0,
    width: info && info.video ? info.video.width : 0,
    height: info && info.video ? info.video.height : 0,
    videoCodec: info && info.video ? info.video.codec : '',
    audioCodec: info && info.audio ? info.audio.codec : '',
    spherical: info ? info.spherical : null,
    stereo: info ? info.stereo : null,
    ffmpeg: !!findFfmpeg(),
    encoder: p.mode === 'transcode' ? pickEncoder() : null,
    ...p,
  };
}

module.exports = { findFfmpeg, pickEncoder, probe, parseProbe, plan, ffmpegArgs, stream, describe };
