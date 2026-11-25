// WebXR headset playback (OpenXR runtimes: SteamVR, Meta Quest Link / Air Link, WMR, Pico, Varjo…).
import { multiply, invert, stripTranslation, rotY, yawFromQuat } from './math.js';

export class XRPlayer {
  constructor(renderer, hooks) {
    this.r = renderer;
    this.hooks = hooks;   // { frame(xrFrameTime) -> processes video, getView() -> view settings, onSelect, onEnd }
    this.session = null;
    this.yaw0 = 0;
    this._lastPose = null;
  }

  static async supported() {
    try { return !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')); } catch { return false; }
  }

  get active() { return !!this.session; }

  async enter() {
    const gl = this.r.gl;
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    await gl.makeXRCompatible();
    const layer = new XRWebGLLayer(session, gl, { antialias: false, depth: false, framebufferScaleFactor: 1.2 });
    session.updateRenderState({ baseLayer: layer, depthNear: 0.05, depthFar: 100 });
    this.ref = await session.requestReferenceSpace('local');
    this.session = session;
    this.yaw0 = 0;
    this._recenterNext = true;
    session.addEventListener('select', () => this.hooks.onSelect && this.hooks.onSelect());
    session.addEventListener('squeeze', () => { this._recenterNext = true; });
    session.addEventListener('end', () => { this.session = null; this.hooks.onEnd && this.hooks.onEnd(); });
    session.requestAnimationFrame((t, f) => this._frame(t, f));
  }

  recenter() { this._recenterNext = true; }

  async exit() { if (this.session) await this.session.end(); }

  _frame(t, frame) {
    const session = frame.session;
    if (!this.session) return;
    session.requestAnimationFrame((tt, ff) => this._frame(tt, ff));
    const pose = frame.getViewerPose(this.ref);
    if (!pose) return;
    if (this._recenterNext) { this.yaw0 = yawFromQuat(pose.transform.orientation); this._recenterNext = false; }
    this.hooks.frame(true);
    const layer = session.renderState.baseLayer;
    const view = this.hooks.getView();
    const recenter = rotY(this.yaw0);
    for (const v of pose.views) {
      const vp = layer.getViewport(v);
      const V = multiply(stripTranslation(v.transform.inverse.matrix), recenter);
      const invVP = invert(multiply(v.projectionMatrix, V));
      this.r.draw({
        ...view,
        fbo: layer.framebuffer,
        viewport: [vp.x, vp.y, vp.width, vp.height],
        eye: v.eye === 'right' ? 1 : 0,
        anaglyph: false,
        invVP,
        split: null,
      });
    }
  }
}
