import {
  WebGLRenderer,
  PCFShadowMap,
  ACESFilmicToneMapping,
  SRGBColorSpace
} from 'three';
import { settings } from '../config/settings.js';

/**
 * Thin wrapper around WebGLRenderer that owns canvas sizing, pixel-ratio
 * budgeting and the render-quality knobs the rest of the app never touches.
 */
export class Renderer {
  constructor(canvas) {
    /**
     * Multiplier applied on top of the pixel-ratio cap, owned by
     * `AdaptiveResolution`. 1 unless the device has proved it cannot keep up.
     */
    this.resolutionScale = 1;

    this.gl = new WebGLRenderer({
      canvas,
      // Deliberately off. Every pixel this app draws lands in one of the
      // composer's render targets, which are not multisampled; the only thing
      // ever drawn to the default framebuffer is the grade pass' full-screen
      // quad, whose single edge is the edge of the screen. Asking for MSAA
      // here therefore buys no antialiasing at all and costs a 4x
      // multisampled back buffer plus a full resolve on every swap. Edge AA,
      // if it is ever wanted, belongs in the composer (SMAA/FXAA).
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false
    });

    this.gl.setPixelRatio(this.targetPixelRatio());
    this.gl.setSize(window.innerWidth, window.innerHeight, false);

    this.gl.shadowMap.enabled = true;
    // `PCFSoftShadowMap` is deprecated as of r185 — three downgrades it to
    // `PCFShadowMap` internally and warns once — so ask for it by name.
    this.gl.shadowMap.type = PCFShadowMap;
    // The frame renders the scene several times (depth prepass, distortion,
    // contact shadows, main pass). Automatic updates would rebuild the cascade
    // shadow maps for every one of them, so the app flags a single update per
    // frame instead.
    this.gl.shadowMap.autoUpdate = false;

    // Tone mapping is executed by the post pipeline's OutputPass, which reads
    // these two properties from the renderer.
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = settings.post.exposure;
    this.gl.outputColorSpace = SRGBColorSpace;

    this.gl.info.autoReset = false;

    this._onResize = null;
  }

  /** Cap the pixel ratio: 4K + heavy transparency is not worth the fill rate. */
  targetPixelRatio() {
    const cap = Math.min(window.devicePixelRatio || 1, Math.max(0.5, settings.performance.pixelRatio));
    // `syncSettings` compares this against the live ratio every frame, so a
    // change to either the cap or the scale is picked up on the next one.
    return Math.max(0.5, cap * this.resolutionScale);
  }

  get domElement() {
    return this.gl.domElement;
  }

  get size() {
    return this.gl.getSize({ width: 0, height: 0 });
  }

  onResize(callback) {
    this._onResize = callback;
    window.addEventListener('resize', this.handleResize, { passive: true });
  }

  handleResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setPixelRatio(this.targetPixelRatio());
    this.gl.setSize(w, h, false);
    this._onResize?.(w, h, this.gl.getPixelRatio());
  };

  /** Called once per frame before rendering so the editor can drive exposure. */
  syncSettings() {
    this.gl.toneMappingExposure = settings.post.exposure;
    if (this.gl.getPixelRatio() !== this.targetPixelRatio()) this.handleResize();
  }

  dispose() {
    window.removeEventListener('resize', this.handleResize);
    this.gl.dispose();
  }
}
