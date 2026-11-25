// Plain-Node unit tests: node test/unit.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { detectFormat, eyeAspect } from '../src/detect.js';
import { perspective, multiply, invert, rotY, rotX, yawFromQuat } from '../src/math.js';
import { AIUpscaler, resampleRGBA } from '../src/ai.js';

const require = createRequire(import.meta.url);
const { parseRange, fileResponse, safeJoin, mimeFor } = require('../lib/serve.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n', e); process.exitCode = 1; }
}

console.log('serve.js');
await test('parseRange', () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=5-2', 100), 'invalid');
  assert.equal(parseRange('items=0-1', 100), 'invalid');
});
await test('fileResponse serves ranges', async () => {
  const f = path.join(os.tmpdir(), 'lumen-test.mp4');
  fs.writeFileSync(f, Buffer.from([...Array(256).keys()]));
  const full = await fileResponse(f, null);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal((await full.arrayBuffer()).byteLength, 256);
  const part = await fileResponse(f, 'bytes=16-31', { 'X-Test': '1' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 16-31/256');
  assert.equal(part.headers.get('x-test'), '1');
  const body = new Uint8Array(await part.arrayBuffer());
  assert.deepEqual([...body], [...Array(16).keys()].map((i) => i + 16));
  assert.equal((await fileResponse(f, 'bytes=999-')).status, 416);
  assert.equal((await fileResponse(f + '.missing', null)).status, 404);
});
await test('safeJoin blocks traversal', () => {
  assert.ok(safeJoin('/app', '/src/index.html').endsWith(path.join('app', 'src', 'index.html')));
  assert.equal(safeJoin('/app', '/../etc/passwd'), null);
  assert.equal(safeJoin('/app', '/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(mimeFor('a.WASM'), 'application/wasm');
});

console.log('detect.js');
await test('filename tags', () => {
  assert.deepEqual(detectFormat('beach_360_TB.mp4', 3840, 3840), { projection: 'equi360', stereo: 'tb', swap: false });
  assert.deepEqual(detectFormat('concert_180_LR.mp4', 5760, 2880), { projection: 'equi180', stereo: 'sbs', swap: false });
  assert.deepEqual(detectFormat('Movie.2019.3D.HSBS.1080p.mkv', 1920, 1080), { projection: 'flat', stereo: 'sbs', swap: false });
  assert.equal(detectFormat('vr180_clip.mp4', 4096, 2048).stereo, 'sbs');
  assert.equal(detectFormat('trip_fisheye_sbs.mp4', 7680, 3840).projection, 'fisheye180');
  assert.equal(detectFormat('holiday.mp4', 1920, 1080).projection, 'flat');
  assert.equal(detectFormat('pano.mp4', 3840, 1920).projection, 'equi360');
  assert.deepEqual(detectFormat('dive.mp4', 4096, 4096), { projection: 'equi360', stereo: 'tb', swap: false });
});
await test('eyeAspect handles half/full SBS & TB', () => {
  assert.ok(Math.abs(eyeAspect(1920, 1080, 'sbs') - 16 / 9) < 1e-6);
  assert.ok(Math.abs(eyeAspect(3840, 1080, 'sbs') - 16 / 9) < 1e-6);
  assert.ok(Math.abs(eyeAspect(1920, 1080, 'tb') - 16 / 9) < 1e-6);
  assert.ok(Math.abs(eyeAspect(1920, 2160, 'tb') - 16 / 9) < 1e-6);
});

console.log('math.js');
await test('invert(P*V) recovers view rays', () => {
  const yaw = 0.7, pitch = -0.3;
  const P = perspective(Math.PI / 2, 16 / 9);
  const V = multiply(rotX(-pitch), rotY(-yaw));
  const inv = invert(multiply(P, V));
  // Centre of screen should map to the camera's forward vector.
  const x = inv[8] + inv[12], y = inv[9] + inv[13], z = inv[10] + inv[14], w = inv[11] + inv[15];
  const d = [x / w, y / w, z / w];
  const n = Math.hypot(...d);
  const f = multiply(rotY(yaw), rotX(pitch));
  const fwd = [-f[8], -f[9], -f[10]];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(d[i] / n - fwd[i]) < 1e-4, `axis ${i}`);
});
await test('yawFromQuat', () => {
  const a = 1.1;
  const q = { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) };
  assert.ok(Math.abs(yawFromQuat(q) - a) < 1e-6);
});

console.log('ai.js (mock ONNX runtime)');
class MockTensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
function mockSession(scale, fixed) {
  return {
    inputNames: ['input'], outputNames: ['output'],
    inputMetadata: [{ type: 'float32', shape: fixed ? [1, 3, fixed[0], fixed[1]] : [1, 3, 'h', 'w'] }],
    async run(feeds) {
      const t = feeds.input;
      const [, , h, w] = t.dims;
      if (fixed) assert.deepEqual([h, w], fixed);
      const H = h * scale, W = w * scale, out = new Float32Array(3 * H * W);
      for (let c = 0; c < 3; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        out[c * H * W + y * W + x] = t.data[c * h * w + Math.floor(y / scale) * w + Math.floor(x / scale)];
      }
      return { output: new MockTensor('float32', out, [1, 3, H, W]) };
    },
    async release() {},
  };
}
function setup(scale, fixed) {
  const up = new AIUpscaler();
  up.ort = { Tensor: MockTensor, InferenceSession: { create: async () => mockSession(scale, fixed) }, env: { wasm: {} } };
  return up;
}
function synthetic(w, h) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    px[i] = (x * 7) & 255; px[i + 1] = (y * 13) & 255; px[i + 2] = ((x + y) * 3) & 255; px[i + 3] = 255;
  }
  return px;
}
async function runTiled(scale, fixed, W, H, opts = {}) {
  const up = setup(scale, fixed);
  const info = await up.loadModel(new Uint8Array(4), 'mock.onnx', 'wasm');
  assert.equal(info.scale, scale);
  const src = synthetic(W, H);
  up._grab = () => src;
  const plan = up.plan(W, H, opts.maxOut || 8192);
  const out = new Uint8Array(plan.outW * plan.outH * 4);
  const covered = new Uint8Array(plan.outW * plan.outH);
  const res = await up.upscale(null, W, H, {
    tile: opts.tile || 40, overlap: 6, maxOut: opts.maxOut || 8192,
    onTile: (x, y, w, h, rgba) => {
      for (let r = 0; r < h; r++) {
        out.set(rgba.subarray(r * w * 4, (r + 1) * w * 4), ((y + r) * plan.outW + x) * 4);
        covered.fill(1, (y + r) * plan.outW + x, (y + r) * plan.outW + x + w);
      }
    },
  });
  return { src, out, covered, plan, res };
}
await test('dynamic-shape model: tiles reassemble exactly (2×)', async () => {
  const W = 97, H = 61, s = 2;
  const { src, out, covered, plan, res } = await runTiled(s, null, W, H);
  assert.equal(plan.outW, W * s); assert.equal(plan.outH, H * s);
  assert.ok(covered.every((v) => v === 1), 'every output pixel written');
  assert.ok(res.tiles > 4);
  for (let y = 0; y < H * s; y++) for (let x = 0; x < W * s; x++) {
    const si = (Math.floor(y / s) * W + Math.floor(x / s)) * 4, di = (y * W * s + x) * 4;
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(out[di + c] - src[si + c]) <= 1, `pixel ${x},${y}`);
  }
});
await test('fixed-shape model (64×64 input, 4×) with edge padding', async () => {
  const W = 150, H = 70, s = 4;
  const { src, out, covered } = await runTiled(s, [64, 64], W, H);
  assert.ok(covered.every((v) => v === 1));
  for (let y = 0; y < H * s; y += 3) for (let x = 0; x < W * s; x += 3) {
    const si = (Math.floor(y / s) * W + Math.floor(x / s)) * 4, di = (y * W * s + x) * 4;
    assert.ok(Math.abs(out[di] - src[si]) <= 1);
  }
});
await test('output capped by GPU texture limit', async () => {
  const W = 120, H = 60;
  const { plan, covered } = await runTiled(4, null, W, H, { maxOut: 300 });
  assert.equal(plan.outW, 300); assert.equal(plan.outH, 150);
  assert.ok(covered.every((v) => v === 1));
});
await test('resampleRGBA keeps constant colour', () => {
  const src = new Uint8ClampedArray(8 * 8 * 4).fill(200);
  const r = resampleRGBA(src, 8, 8, 5, 3);
  assert.equal(r.length, 5 * 3 * 4);
  assert.ok(r.every((v) => v === 200));
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
