import {
  WebGLRenderer,
  PCFSoftShadowMap,
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
    this.gl = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false
    });

    this.gl.setPixelRatio(this.targetPixelRatio());
    this.gl.setSize(window.innerWidth, window.innerHeight, false);

    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = PCFSoftShadowMap;
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
    return Math.min(window.devicePixelRatio || 1, 1.75);
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
  }

  dispose() {
    window.removeEventListener('resize', this.handleResize);
    this.gl.dispose();
  }
}
