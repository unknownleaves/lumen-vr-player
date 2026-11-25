// WebGL2 rendering pipeline:
//   video frame ─► (optional AI texture) ─► EASU edge-adaptive upscale ─► RCAS sharpen ─► projection (flat / 360 / 180 / fisheye, mono / SBS / TB)
// The EASU + RCAS passes follow the published algorithm of AMD FidelityFX Super Resolution 1.0 (MIT licensed).

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// EASU: 12-tap, edge-direction-aware Lanczos-2 upscale with de-ringing.
const EASU_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec2 uDstSize;
out vec4 outColor;

float L(vec3 c) { return dot(c, vec3(0.5, 1.0, 0.5)); }   // cheap luma, same weights as FSR

vec3 fetch(ivec2 p) {
  ivec2 mx = ivec2(uSrcSize) - 1;
  return texelFetch(uSrc, clamp(p, ivec2(0), mx), 0).rgb;
}

void tap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * -dir.y + off.y * dir.x);
  v *= len;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB; wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  aC += c * w; aW += w;
}

// Accumulate direction & edge-length for one of the four centre texels.
void setDL(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
  // lA up, lB left, lC centre, lD right, lE down
  float dc = lD - lC, cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = lenX > 0.0 ? 1.0 / lenX : 0.0;
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0); lenX *= lenX;
  len += lenX * w;
  float ec = lE - lC, ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = lenY > 0.0 ? 1.0 / lenY : 0.0;
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0); lenY *= lenY;
  len += lenY * w;
}

void main() {
  vec2 pp = gl_FragCoord.xy / uDstSize * uSrcSize - 0.5;
  vec2 fp = floor(pp);
  vec2 f = pp - fp;
  ivec2 i0 = ivec2(fp);
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  vec3 b = fetch(i0 + ivec2(0, -1)), c = fetch(i0 + ivec2(1, -1));
  vec3 e = fetch(i0 + ivec2(-1, 0)), F = fetch(i0 + ivec2(0, 0)), g = fetch(i0 + ivec2(1, 0)), h = fetch(i0 + ivec2(2, 0));
  vec3 i = fetch(i0 + ivec2(-1, 1)), j = fetch(i0 + ivec2(0, 1)), k = fetch(i0 + ivec2(1, 1)), l = fetch(i0 + ivec2(2, 1));
  vec3 n = fetch(i0 + ivec2(0, 2)), o = fetch(i0 + ivec2(1, 2));
  float bL = L(b), cL = L(c), eL = L(e), fL = L(F), gL = L(g), hL = L(h);
  float iL = L(i), jL = L(j), kL = L(k), lL = L(l), nL = L(n), oL = L(o);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  setDL(dir, len, (1.0 - f.x) * (1.0 - f.y), bL, eL, fL, gL, jL);
  setDL(dir, len, f.x * (1.0 - f.y),         cL, fL, gL, hL, kL);
  setDL(dir, len, (1.0 - f.x) * f.y,         fL, iL, jL, kL, nL);
  setDL(dir, len, f.x * f.y,                 gL, jL, kL, lL, oL);

  float dirR = dot(dir, dir);
  bool zro = dirR < 1.0 / 32768.0;
  dirR = zro ? 1.0 : inversesqrt(dirR);
  dir.x = zro ? 1.0 : dir.x;
  dir *= dirR;
  len = len * 0.5; len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;

  vec3 aC = vec3(0.0); float aW = 0.0;
  tap(aC, aW, vec2( 0.0, -1.0) - f, dir, len2, lob, clp, b);
  tap(aC, aW, vec2( 1.0, -1.0) - f, dir, len2, lob, clp, c);
  tap(aC, aW, vec2(-1.0,  1.0) - f, dir, len2, lob, clp, i);
  tap(aC, aW, vec2( 0.0,  1.0) - f, dir, len2, lob, clp, j);
  tap(aC, aW, vec2( 0.0,  0.0) - f, dir, len2, lob, clp, F);
  tap(aC, aW, vec2(-1.0,  0.0) - f, dir, len2, lob, clp, e);
  tap(aC, aW, vec2( 1.0,  1.0) - f, dir, len2, lob, clp, k);
  tap(aC, aW, vec2( 2.0,  1.0) - f, dir, len2, lob, clp, l);
  tap(aC, aW, vec2( 2.0,  0.0) - f, dir, len2, lob, clp, h);
  tap(aC, aW, vec2( 1.0,  0.0) - f, dir, len2, lob, clp, g);
  tap(aC, aW, vec2( 1.0,  2.0) - f, dir, len2, lob, clp, o);
  tap(aC, aW, vec2( 0.0,  2.0) - f, dir, len2, lob, clp, n);

  vec3 mn = min(min(F, g), min(j, k));
  vec3 mx = max(max(F, g), max(j, k));
  vec3 col = clamp(aC / max(aW, 1e-5), mn, mx);   // de-ring
  outColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// RCAS: robust contrast-adaptive sharpening (+ optional light noise suppression).
const RCAS_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSize;
uniform float uSharp;    // 0..1 linear
out vec4 outColor;
vec3 at(ivec2 p) { return texelFetch(uSrc, clamp(p, ivec2(0), ivec2(uSize) - 1), 0).rgb; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 b = at(p + ivec2(0, -1));
  vec3 d = at(p + ivec2(-1, 0));
  vec3 e = at(p);
  vec3 f = at(p + ivec2(1, 0));
  vec3 h = at(p + ivec2(0, 1));
  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  vec3 hitMin = min(mn4, e) / (4.0 * mx4 + 1e-5);
  vec3 hitMax = (1.0 - max(mx4, e)) / (4.0 * mn4 - 4.0 - 1e-5);
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * uSharp;
  // Noise detection: soften sharpening on grainy areas (keeps compression noise from being amplified).
  float bL = dot(b, vec3(.5,1.,.5)), dL = dot(d, vec3(.5,1.,.5)), eL = dot(e, vec3(.5,1.,.5));
  float fL = dot(f, vec3(.5,1.,.5)), hL = dot(h, vec3(.5,1.,.5));
  float nz = 0.25 * (bL + dL + fL + hL) - eL;
  float rng = max(max(max(bL, dL), max(eL, fL)), hL) - min(min(min(bL, dL), min(eL, fL)), hL);
  nz = clamp(abs(nz) / max(rng, 1e-5), 0.0, 1.0);
  nz = -0.5 * nz + 1.0;
  lobe *= nz;
  vec3 col = (lobe * (b + d + h + f) + e) / (4.0 * lobe + 1.0);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Final projection to the screen or to an XR eye.
const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;      // processed (upscaled) frame
uniform sampler2D uRaw;      // original frame (for A/B compare)
uniform int uMode;           // 0 flat, 1 equirect 360, 2 equirect 180, 3 fisheye 180, 4 flat on a virtual screen (XR)
uniform int uStereo;         // 0 mono, 1 side-by-side, 2 top-bottom
uniform int uEye;            // 0 left, 1 right
uniform bool uAnaglyph;
uniform bool uSwap;
uniform mat4 uInvVP;
uniform vec4 uViewport;      // x, y, w, h (device px)
uniform vec4 uFlatRect;      // x, y, w, h of the video rectangle inside the viewport (flat mode)
uniform vec3 uScreen;        // half-width, half-height, distance (virtual screen, metres)
uniform float uSplit;        // compare divider x in viewport px, < 0 disables
uniform vec2 uTexSize;
uniform vec2 uRawSize;
uniform float uFisheyeFov;   // radians, usually PI (180°)
out vec4 outColor;
const float PI = 3.14159265358979;

vec2 eyeUV(vec2 uv, int eye, vec2 size) {
  int e = uSwap ? 1 - eye : eye;
  float fe = float(e);
  if (uStereo == 1) {
    float px = 0.5 / size.x;
    uv.x = clamp(uv.x * 0.5 + 0.5 * fe, 0.5 * fe + px, 0.5 * fe + 0.5 - px);
  } else if (uStereo == 2) {
    float py = 0.5 / size.y;
    uv.y = clamp(uv.y * 0.5 + 0.5 * fe, 0.5 * fe + py, 0.5 * fe + 0.5 - py);
  }
  return uv;
}

vec3 sampleEye(vec2 uv, int eye, bool raw) {
  return raw ? texture(uRaw, eyeUV(uv, eye, uRawSize)).rgb : texture(uTex, eyeUV(uv, eye, uTexSize)).rgb;
}

bool dirToUV(vec3 d, out vec2 uv) {
  uv = vec2(0.0);
  if (uMode == 1) {
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    uv = vec2(0.5 + lon / (2.0 * PI), 0.5 - lat / PI);
    return true;
  }
  if (uMode == 2) {
    float lon = atan(d.x, -d.z);
    if (abs(lon) > 0.5 * PI) return false;
    float lat = asin(clamp(d.y, -1.0, 1.0));
    uv = vec2(0.5 + lon / PI, 0.5 - lat / PI);
    return true;
  }
  if (uMode == 3) {
    float th = acos(clamp(-d.z, -1.0, 1.0));
    if (th > 0.5 * uFisheyeFov) return false;
    float r = th / uFisheyeFov;
    float ph = atan(d.y, d.x);
    uv = vec2(0.5 + r * cos(ph), 0.5 - r * sin(ph));
    return true;
  }
  if (uMode == 4) {
    if (d.z >= -1e-4) return false;
    float t = uScreen.z / -d.z;
    vec2 hit = d.xy * t;
    uv = vec2(hit.x / (2.0 * uScreen.x) + 0.5, 0.5 - hit.y / (2.0 * uScreen.y));
    return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  }
  return false;
}

void main() {
  vec2 frag = gl_FragCoord.xy - uViewport.xy;
  vec2 ndc = frag / uViewport.zw * 2.0 - 1.0;
  vec2 uv;
  bool ok;
  if (uMode == 0) {
    uv = (frag - uFlatRect.xy) / uFlatRect.zw;
    uv.y = 1.0 - uv.y;
    ok = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  } else {
    vec4 p = uInvVP * vec4(ndc, 1.0, 1.0);
    ok = dirToUV(normalize(p.xyz / p.w), uv);
  }
  if (!ok) { outColor = vec4(0.02, 0.02, 0.025, 1.0); return; }
  bool raw = uSplit >= 0.0 && frag.x < uSplit;
  vec3 c;
  if (uAnaglyph && uStereo != 0) {
    vec3 l = sampleEye(uv, 0, raw), r = sampleEye(uv, 1, raw);
    c = vec3(dot(l, vec3(0.299, 0.587, 0.114)), r.g, r.b);   // red/cyan
  } else {
    c = sampleEye(uv, uEye, raw);
  }
  if (uSplit >= 0.0 && abs(frag.x - uSplit) < 1.5) c = vec3(1.0);
  outColor = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile error: ' + log);
  }
  return s;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

function makeTex(gl, w, h, filter = gl.LINEAR) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (w && h) gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  return t;
}

class Target {
  constructor(gl) { this.gl = gl; this.w = 0; this.h = 0; this.tex = null; this.fbo = null; }
  ensure(w, h) {
    const gl = this.gl;
    if (this.w === w && this.h === h && this.tex) return;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.tex = makeTex(gl, w, h);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    this.w = w; this.h = h;
  }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, xrCompatible: true, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL 2 is not available on this system.');
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.easu = program(gl, EASU_FS);
    this.rcas = program(gl, RCAS_FS);
    this.present = program(gl, PRESENT_FS);
    this.videoTex = makeTex(gl, 0, 0);
    this.videoW = 0; this.videoH = 0;
    this.aiTex = null; this.aiW = 0; this.aiH = 0;
    this.tA = new Target(gl);
    this.tB = new Target(gl);
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    this.output = null;        // {tex, w, h} result of the last process() call
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** Upload the current video frame. Returns true when a frame was available. */
  uploadVideo(video) {
    const gl = this.gl;
    if (video.readyState < 2 || !video.videoWidth) return false;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    if (video.videoWidth !== this.videoW || video.videoHeight !== this.videoH) {
      // texStorage textures are immutable; recreate on size change.
      gl.deleteTexture(this.videoTex);
      this.videoTex = makeTex(gl, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      this.videoW = video.videoWidth; this.videoH = video.videoHeight;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    return true;
  }

  ensureAITexture(w, h) {
    const gl = this.gl;
    if (this.aiTex && this.aiW === w && this.aiH === h) return;
    if (this.aiTex) gl.deleteTexture(this.aiTex);
    this.aiTex = makeTex(gl, w, h);
    this.aiW = w; this.aiH = h;
  }

  /** Upload an RGBA8 block into the AI texture (rows top-first). */
  uploadAIRegion(x, y, w, h, rgba) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.aiTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  _pass(prog, target, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.vao);
    setup(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Run the enhancement chain.
   * opts: { useAI, enhance, scale (target/source ratio), sharpness 0..1 }
   */
  process(opts) {
    const gl = this.gl;
    let src = opts.useAI && this.aiTex
      ? { tex: this.aiTex, w: this.aiW, h: this.aiH }
      : { tex: this.videoTex, w: this.videoW, h: this.videoH };
    if (!src.w) { this.output = null; return null; }
    const baseW = this.videoW, baseH = this.videoH;

    if (opts.enhance) {
      // Target size is relative to the *original* video so AI output and GPU upscale compose sensibly.
      let s = Math.max(1, opts.scale || 1);
      let tw = Math.round(baseW * s), th = Math.round(baseH * s);
      const lim = Math.min(this.maxTex / tw, this.maxTex / th, 1);
      tw = Math.floor(tw * lim); th = Math.floor(th * lim);
      if (tw > src.w * 1.02 || th > src.h * 1.02) {
        this.tA.ensure(tw, th);
        this._pass(this.easu, this.tA, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, src.tex);
          gl.uniform1i(u.uSrc, 0);
          gl.uniform2f(u.uSrcSize, src.w, src.h);
          gl.uniform2f(u.uDstSize, tw, th);
        });
        src = { tex: this.tA.tex, w: tw, h: th };
      }
      if (opts.sharpness > 0.001) {
        this.tB.ensure(src.w, src.h);
        const sharp = Math.pow(2, -2.5 * (1 - opts.sharpness));   // FSR "stops" mapping
        this._pass(this.rcas, this.tB, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, src.tex);
          gl.uniform1i(u.uSrc, 0);
          gl.uniform2f(u.uSize, src.w, src.h);
          gl.uniform1f(u.uSharp, sharp);
        });
        src = { tex: this.tB.tex, w: src.w, h: src.h };
      }
    }
    this.output = src;
    return src;
  }

  /**
   * Draw the processed frame.
   * v: { fbo, viewport:[x,y,w,h], mode, stereo, eye, anaglyph, swap, invVP, flatRect:[x,y,w,h], screen:[hw,hh,d], split, fisheyeFov }
   */
  draw(v) {
    const gl = this.gl;
    const out = this.output;
    gl.bindFramebuffer(gl.FRAMEBUFFER, v.fbo || null);
    const [x, y, w, h] = v.viewport;
    gl.viewport(x, y, w, h);
    if (!out) {
      gl.clearColor(0.027, 0.031, 0.043, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const p = this.present;
    gl.useProgram(p.p);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, out.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(p.u.uRaw, 1);
    gl.uniform1i(p.u.uMode, v.mode);
    gl.uniform1i(p.u.uStereo, v.stereo);
    gl.uniform1i(p.u.uEye, v.eye || 0);
    gl.uniform1i(p.u.uAnaglyph, v.anaglyph ? 1 : 0);
    gl.uniform1i(p.u.uSwap, v.swap ? 1 : 0);
    if (p.u.uInvVP) gl.uniformMatrix4fv(p.u.uInvVP, false, v.invVP);
    gl.uniform4f(p.u.uViewport, x, y, w, h);
    const fr = v.flatRect || [0, 0, w, h];
    gl.uniform4f(p.u.uFlatRect, fr[0], fr[1], fr[2], fr[3]);
    const sc = v.screen || [2, 1.125, 3];
    gl.uniform3f(p.u.uScreen, sc[0], sc[1], sc[2]);
    gl.uniform1f(p.u.uSplit, v.split == null ? -1 : v.split);
    gl.uniform2f(p.u.uTexSize, out.w, out.h);
    gl.uniform2f(p.u.uRawSize, this.videoW, this.videoH);
    gl.uniform1f(p.u.uFisheyeFov, v.fisheyeFov || Math.PI);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
