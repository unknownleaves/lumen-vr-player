// AI super-resolution with ONNX Runtime Web (WebGPU, falling back to WASM).
// Works with image super-resolution models that take  float32/float16 NCHW RGB in [0,1]
// and return the same layout at N× resolution (Real-ESRGAN, SRVGGNetCompact, SPAN, Compact, …).

const ORT_DIR = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url).href;

// ---- float16 helpers --------------------------------------------------------------------------
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) return sign;                       // flush tiny values (inputs are 0..1)
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >>> 13);
}
function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}

/** Bilinear RGBA8 resample (used when the model's output would exceed the GPU texture limit). */
export function resampleRGBA(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), sw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, sw - 1), tx = fx - x0;
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src[a + k] + (src[b + k] - src[a + k]) * tx;
        const bot = src[c + k] + (src[d + k] - src[c + k]) * tx;
        out[o + k] = top + (bot - top) * ty;
      }
    }
  }
  return out;
}

export class AIUpscaler {
  constructor() {
    this.ort = null;
    this.session = null;
    this.modelName = '';
    this.backend = '';
    this.scale = 0;
    this.fixedSize = null;   // [h, w] when the model has a static input shape
    this.inputType = 'float32';
    this.busy = false;
    this._canvas = null;
  }

  get ready() { return !!this.session; }

  async loadRuntime(ortModule) {
    if (this.ort) return this.ort;
    if (ortModule) { this.ort = ortModule; return this.ort; }
    let mod;
    try {
      mod = await import(ORT_DIR + 'ort.webgpu.min.mjs');
    } catch (e) {
      throw new Error('ONNX Runtime Web is not installed. Run "npm install" in the app folder. (' + e.message + ')');
    }
    const ort = mod.default && mod.default.InferenceSession ? mod.default : mod;
    ort.env.wasm.wasmPaths = ORT_DIR;
    ort.env.wasm.numThreads = Math.min(8, navigator.hardwareConcurrency || 4);
    this.ort = ort;
    return ort;
  }

  /** model: ArrayBuffer | Uint8Array | URL string */
  async loadModel(model, name = 'model.onnx', preferred = 'auto') {
    const ort = await this.loadRuntime();
    let bytes = model;
    if (typeof model === 'string') {
      const r = await fetch(model);
      if (!r.ok) throw new Error('Could not read model: HTTP ' + r.status);
      bytes = new Uint8Array(await r.arrayBuffer());
    } else if (model instanceof ArrayBuffer) bytes = new Uint8Array(model);

    if (this.session) { try { await this.session.release(); } catch { /* ignore */ } }
    this.session = null;

    const order = preferred === 'wasm' ? ['wasm'] : ('gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm']);
    let lastErr;
    for (const ep of order) {
      try {
        this.session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        this.backend = ep === 'webgpu' ? 'WebGPU' : 'CPU (WASM)';
        break;
      } catch (e) { lastErr = e; }
    }
    if (!this.session) throw lastErr || new Error('Could not create inference session');

    this.inputName = this.session.inputNames[0];
    this.outputName = this.session.outputNames[0];
    const meta = this.session.inputMetadata && this.session.inputMetadata[0];
    this.fixedSize = null;
    this.inputType = 'float32';
    if (meta) {
      if (meta.type) this.inputType = meta.type;
      const sh = meta.shape;
      if (Array.isArray(sh) && sh.length === 4 && typeof sh[2] === 'number' && typeof sh[3] === 'number' && sh[2] > 0 && sh[3] > 0) {
        this.fixedSize = [sh[2], sh[3]];
      }
    }
    // Probe once to learn the scale factor.
    const ph = this.fixedSize ? this.fixedSize[0] : 32, pw = this.fixedSize ? this.fixedSize[1] : 32;
    const probe = await this._run(new Float32Array(3 * ph * pw).fill(0.5), pw, ph);
    this.scale = Math.round(probe.dims[2] / ph);
    if (!(this.scale >= 1) || probe.dims[1] !== 3) {
      throw new Error(`Unsupported model output ${JSON.stringify(probe.dims)} (expected [1,3,H×s,W×s])`);
    }
    this.modelName = name;
    return { scale: this.scale, backend: this.backend, fixed: this.fixedSize };
  }

  async _run(chw, w, h) {
    const ort = this.ort;
    let tensor;
    if (this.inputType === 'float16') {
      const half = new Uint16Array(chw.length);
      for (let i = 0; i < chw.length; i++) half[i] = toHalf(chw[i]);
      tensor = new ort.Tensor('float16', half, [1, 3, h, w]);
    } else {
      tensor = new ort.Tensor('float32', chw, [1, 3, h, w]);
    }
    const res = await this.session.run({ [this.inputName]: tensor });
    const out = res[this.outputName];
    let data = out.data;
    if (out.type === 'float16') {
      const f = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) f[i] = fromHalf(data[i]);
      data = f;
    }
    if (typeof out.dispose === 'function') out.dispose();
    return { data, dims: out.dims };
  }

  _grab(source, w, h) {
    if (!this._canvas || this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    }
    this._ctx.imageSmoothingQuality = 'high';
    this._ctx.drawImage(source, 0, 0, w, h);
    return this._ctx.getImageData(0, 0, w, h).data;
  }

  /** Plan output size; keeps the model's native scale unless the GPU texture limit forces a reduction. */
  plan(srcW, srcH, maxOut) {
    const s = this.scale;
    const outScale = Math.min(s, maxOut / srcW, maxOut / srcH);
    return { inW: srcW, inH: srcH, outW: Math.floor(srcW * outScale), outH: Math.floor(srcH * outScale), outScale };
  }

  /**
   * Upscale one frame in tiles.
   * onTile(x, y, w, h, rgba) receives each finished region in output pixels.
   * shouldAbort() is polled between tiles.
   */
  async upscale(source, srcW, srcH, { maxOut = 8192, tile = 256, overlap = 12, onTile, shouldAbort } = {}) {
    if (!this.session) throw new Error('No AI model loaded');
    this.busy = true;
    const t0 = performance.now();
    try {
      const { inW, inH, outW, outH, outScale } = this.plan(srcW, srcH, maxOut);
      const px = this._grab(source, inW, inH);
      const s = this.scale;
      const fixed = this.fixedSize;
      const tileW = fixed ? fixed[1] - 2 * overlap : tile;
      const tileH = fixed ? fixed[0] - 2 * overlap : tile;
      if (tileW < 8 || tileH < 8) throw new Error('Model input is too small for tiling');
      let tiles = 0;
      for (let y0 = 0; y0 < inH; y0 += tileH) {
        for (let x0 = 0; x0 < inW; x0 += tileW) {
          if (shouldAbort && shouldAbort()) return { aborted: true };
          const x1 = Math.min(x0 + tileW, inW), y1 = Math.min(y0 + tileH, inH);
          const px0 = Math.max(0, x0 - overlap), py0 = Math.max(0, y0 - overlap);
          let px1 = Math.min(inW, x1 + overlap), py1 = Math.min(inH, y1 + overlap);
          const rw = fixed ? fixed[1] : px1 - px0;
          const rh = fixed ? fixed[0] : py1 - py0;
          // Build the NCHW tensor (edge-replicated when a fixed-size model needs padding).
          const plane = rw * rh;
          const chw = new Float32Array(3 * plane);
          for (let yy = 0; yy < rh; yy++) {
            const sy = Math.min(py0 + yy, inH - 1);
            for (let xx = 0; xx < rw; xx++) {
              const sx = Math.min(px0 + xx, inW - 1);
              const si = (sy * inW + sx) * 4, di = yy * rw + xx;
              chw[di] = px[si] / 255;
              chw[plane + di] = px[si + 1] / 255;
              chw[2 * plane + di] = px[si + 2] / 255;
            }
          }
          const out = await this._run(chw, rw, rh);
          const ow = out.dims[3], oPlane = out.dims[2] * ow;
          // Crop the core region (drop overlap) and convert to RGBA8.
          const cx = (x0 - px0) * s, cy = (y0 - py0) * s;
          const cw = (x1 - x0) * s, ch = (y1 - y0) * s;
          let rgba = new Uint8ClampedArray(cw * ch * 4);
          const d = out.data;
          for (let yy = 0; yy < ch; yy++) {
            for (let xx = 0; xx < cw; xx++) {
              const si = (cy + yy) * ow + cx + xx, di = (yy * cw + xx) * 4;
              rgba[di] = d[si] * 255;
              rgba[di + 1] = d[oPlane + si] * 255;
              rgba[di + 2] = d[2 * oPlane + si] * 255;
              rgba[di + 3] = 255;
            }
          }
          let dx = x0 * s, dy = y0 * s, dw = cw, dh = ch;
          if (outScale < s) {
            dx = Math.round(x0 * outScale); dy = Math.round(y0 * outScale);
            dw = Math.round(x1 * outScale) - dx; dh = Math.round(y1 * outScale) - dy;
            rgba = resampleRGBA(rgba, cw, ch, dw, dh);
          }
          if (onTile) onTile(dx, dy, dw, dh, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
          tiles++;
        }
      }
      return { outW, outH, tiles, ms: performance.now() - t0 };
    } finally {
      this.busy = false;
    }
  }
}
