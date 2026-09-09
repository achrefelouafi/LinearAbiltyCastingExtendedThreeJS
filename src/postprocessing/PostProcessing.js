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
const DISTORTION_MASK = 1 << LAYER.DISTORTION;

/**
 * Is there a visible mesh on the distortion layer anywhere under `node`?
 *
 * `Object3D#traverseVisible` would do this in one line but cannot stop at the
 * first hit, and the answer here is a boolean: the pooled abilities put a few
 * hundred nodes in the scene and this runs every frame.
 */
function hasVisibleDistortion(node) {
  if (node.visible === false) return false;
  if (node.isMesh === true && (node.layers.mask & DISTORTION_MASK) !== 0) return true;

  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    if (hasVisibleDistortion(children[i])) return true;
  }
  return false;
}

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
 * low-frequency data, so full resolution would be wasted fill rate. They are
 * also both *conditional* — see `render`.
 *
 * One subtlety ties the three together: `WebGLShadowMap` picks its casters by
 * testing them against the layers of the camera the frame is being *rendered*
 * with, not against the shadow camera's. Passes 1 and 2 pin the camera to a
 * single layer, so whichever of them happens to run first would decide what
 * ends up in the sun's shadow map — dropping every `LAYER.SHAPED` caster in
 * the depth prepass' case. Both therefore hold the flag back and let the main
 * pass, the only one that still sees the whole scene, build the map.
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

    // Not this pass' job (see the class comment).
    const shadowsPending = gl.shadowMap.needsUpdate;
    gl.shadowMap.needsUpdate = false;

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
    gl.shadowMap.needsUpdate = shadowsPending;
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

    // Not this pass' job either (see the class comment).
    const shadowsPending = gl.shadowMap.needsUpdate;
    gl.shadowMap.needsUpdate = false;

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
    gl.shadowMap.needsUpdate = shadowsPending;
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

    // `enabled` is not set here: `render` owns it, because whether the pass has
    // anything to composite is only known once the scene has been walked.
    this.distortionPass.uniforms.uScale.value = post.enabled ? post.distortion : 0;
  }

  /**
   * Draw the frame.
   *
   * Both auxiliary passes are skipped when nothing on screen can consume them,
   * which on an idle stage is every frame:
   *
   * - the depth buffer is sampled only by ability, particle and burst
   *   materials, so with none of them alive the prepass is a full render of
   *   the opaque world into a texture nobody reads;
   * - the distortion buffer is written only by proxies parented to an ability,
   *   and the pass that composites it is a full-screen read of an image that
   *   is uniformly "no offset".
   *
   * @param {boolean} live whether any depth-sampling effect is on screen —
   *   see `App#_liveEffects`. Defaults to true so the boot-time warm-up draws
   *   the complete pipeline.
   */
  render(live = true, active = true) {
    this.bloomPass.enabled = settings.post.enabled && settings.post.bloomStrength > 0.001
      && (active || settings.performance.idleBloom);
    if (live) this._renderDepth();

    const post = settings.post;
    const hasDistortion =
      live && post.enabled && post.distortion !== 0 && hasVisibleDistortion(this.scene);

    this.distortionPass.enabled = hasDistortion;
    if (hasDistortion) this._renderDistortion();

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
