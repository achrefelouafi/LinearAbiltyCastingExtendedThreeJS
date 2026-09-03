import {
  WebGLRenderTarget,
  MeshDepthMaterial,
  RGBADepthPacking,
  Vector2,
  Color,
  HalfFloatType
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GradeShader } from './GradeShader.js';
import { DistortionShader } from './DistortionShader.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';

const DISTORTION_CLEAR = new Color(0.5, 0.5, 0.0);

/**
 * The full render pipeline.
 *
 * Per frame:
 *   1. depth prepass  — opaque WORLD layer into a packed-depth buffer, which
 *                       every VFX shader samples for soft intersections
 *   2. distortion     — DISTORTION layer into an offset buffer
 *   3. composer       — scene → refraction → bloom → tone map → grade
 *
 * Passes 1 and 2 run at half resolution: both are only ever read as smooth,
 * low-frequency data, so full resolution would be wasted fill rate.
 */
export class PostProcessing {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.gl = renderer.gl;
    this.scene = scene;
    this.camera = camera;

    const size = this.gl.getSize(new Vector2());
    const pixelRatio = this.gl.getPixelRatio();
    const width = Math.floor(size.x * pixelRatio);
    const height = Math.floor(size.y * pixelRatio);

    /* ---- auxiliary buffers ---- */
    this.depthTarget = new WebGLRenderTarget(Math.floor(width / 2), Math.floor(height / 2));
    this.depthTarget.texture.generateMipmaps = false;
    this.depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

    this.distortionTarget = new WebGLRenderTarget(Math.floor(width / 2), Math.floor(height / 2), {
      type: HalfFloatType
    });
    this.distortionTarget.texture.generateMipmaps = false;

    frame.uSceneDepth.value = this.depthTarget.texture;
    frame.uCameraNear.value = camera.near;
    frame.uCameraFar.value = camera.far;
    frame.uResolution.value.set(width, height);

    /* ---- composer ---- */
    this.composer = new EffectComposer(this.gl);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.distortionPass = new ShaderPass(DistortionShader);
    this.distortionPass.uniforms.tDistortion.value = this.distortionTarget.texture;
    this.composer.addPass(this.distortionPass);

    this.bloomPass = new UnrealBloomPass(
      new Vector2(size.x, size.y),
      settings.post.bloomStrength,
      settings.post.bloomRadius,
      settings.post.bloomThreshold
    );
    this.composer.addPass(this.bloomPass);

    // Tone mapping + sRGB conversion happen here; everything before is linear HDR.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.uniforms.uFlashColor.value = new Color(1, 1, 1);
    this.gradePass.renderToScreen = true;
    this.composer.addPass(this.gradePass);

    this._clearColor = new Color();
  }

  /** Opaque depth for soft particles. */
  _renderDepth() {
    const gl = this.gl;
    const scene = this.scene;
    const camera = this.camera;

    const previousBackground = scene.background;
    const previousOverride = scene.overrideMaterial;
    const mask = camera.layers.mask;
    gl.getClearColor(this._clearColor);
    const previousAlpha = gl.getClearAlpha();

    scene.background = null;
    scene.overrideMaterial = this.depthMaterial;
    camera.layers.set(LAYER.WORLD);

    gl.setRenderTarget(this.depthTarget);
    gl.setClearColor(0xffffff, 1); // "infinitely far"
    gl.clear();
    gl.render(scene, camera);

    scene.background = previousBackground;
    scene.overrideMaterial = previousOverride;
    camera.layers.mask = mask;
    gl.setClearColor(this._clearColor, previousAlpha);
  }

  /** Screen-space refraction offsets. */
  _renderDistortion() {
    const gl = this.gl;
    const scene = this.scene;
    const camera = this.camera;

    const previousBackground = scene.background;
    const mask = camera.layers.mask;
    gl.getClearColor(this._clearColor);
    const previousAlpha = gl.getClearAlpha();

    scene.background = null;
    camera.layers.set(LAYER.DISTORTION);

    gl.setRenderTarget(this.distortionTarget);
    gl.setClearColor(DISTORTION_CLEAR, 0); // 0.5 = "no offset", alpha 0 = no coverage
    gl.clear();
    gl.render(scene, camera);

    scene.background = previousBackground;
    camera.layers.mask = mask;
    gl.setClearColor(this._clearColor, previousAlpha);
    gl.setRenderTarget(null);
  }

  /** Push editor values into the passes. Called once per frame. */
  sync(elapsed, flash) {
    const post = settings.post;

    this.bloomPass.strength = post.bloomStrength;
    this.bloomPass.radius = post.bloomRadius;
    this.bloomPass.threshold = post.bloomThreshold;
    this.bloomPass.enabled = post.enabled && post.bloomStrength > 0.001;

    const u = this.gradePass.uniforms;
    u.uTime.value = elapsed;
    u.uAberration.value = post.enabled ? post.chromaticAberration : 0;
    u.uVignette.value = post.enabled ? post.vignette : 0;
    u.uContrast.value = post.enabled ? post.contrast : 1;
    u.uSaturation.value = post.enabled ? post.saturation : 1;
    u.uTemperature.value = post.enabled ? post.temperature : 0;
    u.uLift.value = post.lift;
    u.uGain.value = post.gain;
    u.uGrain.value = post.enabled ? post.grain : 0;
    u.uFlashStrength.value = flash.strength;
    u.uFlashColor.value.copy(flash.color);

    this.distortionPass.uniforms.uScale.value = post.enabled ? post.distortion : 0;
    this.distortionPass.enabled = post.enabled;
  }

  render() {
    this._renderDepth();
    this._renderDistortion();
    // Tone mapping is applied by OutputPass: three automatically disables the
    // in-material tone mapping while rendering into the composer's targets.
    this.composer.render();
    this.gl.setRenderTarget(null);
  }

  setSize(width, height, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);

    const w = Math.floor(width * pixelRatio);
    const h = Math.floor(height * pixelRatio);
    this.depthTarget.setSize(Math.max(2, Math.floor(w / 2)), Math.max(2, Math.floor(h / 2)));
    this.distortionTarget.setSize(Math.max(2, Math.floor(w / 2)), Math.max(2, Math.floor(h / 2)));
    frame.uResolution.value.set(w, h);
  }

  dispose() {
    this.depthTarget.dispose();
    this.distortionTarget.dispose();
    this.depthMaterial.dispose();
    this.composer.dispose();
  }
}
