import GUI from 'lil-gui';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { PresetManager } from './PresetManager.js';

/**
 * Real-time VFX editor.
 *
 * Every control binds straight to a field in `config/settings.js`. Because all
 * shaders, particle systems, lights and post passes *read* those fields each
 * frame, no controller needs an onChange handler: moving a slider updates the
 * ice field that is already standing, the bolt that is already in the air, the
 * next cast, the environment and the post stack simultaneously, with no rebuild
 * and no shader recompilation.
 *
 * That holds while the simulation is paused (`P`), which is the point — the
 * silhouette of a frozen eruption and the shape of a frozen bolt are the things
 * worth tuning, and both abilities re-resolve themselves from these values on a
 * zero-length frame.
 */
export class Editor {
  /**
   * @param {object} hooks { onClear, onToast }
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.presets = new PresetManager();

    this.gui = new GUI({ title: 'VFX Editor', width: 330 });
    this.gui.domElement.style.setProperty('--title-height', '30px');

    this._presetState = { name: 'My preset', selected: this.presets.names[0] ?? '' };

    this._buildPresets();
    this._buildGlobal();
    this._buildAim();
    this._buildZone();
    this._buildIce();
    this._buildThunder();
    this._buildMeteor();
    this._buildBeam();
    this._buildSnare();
    this._buildGlacier();
    this._buildWard();
    this._buildAcid();
    this._buildEnvironment();
    this._buildPost();
    this._buildCamera();
    this._buildCharacter();
    this._buildDummies();

    // Everything starts collapsed, top-level folders included. There are enough
    // controls here that any folder left open pushes the rest off the screen,
    // so the panel opens as a list of sections and the user picks one.
    this.gui.foldersRecursive().forEach((folder) => folder.close());
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  static range(folder, object, key, min, max, step, label) {
    return folder.add(object, key, min, max, step).name(label ?? key);
  }

  /**
   * Which clip the body throws when this ability fires.
   *
   * One per ability, because the gesture is part of how a spell reads — the
   * beam and the snare should not be cast the same way. `App` reads the value
   * at the moment of the cast, so switching it applies to the very next click.
   */
  static castAnimation(folder, object) {
    return folder.add(object, 'castAnim', CAST_ANIMATIONS).name('cast animation');
  }

  /**
   * The four colour stops of a particle system's lifetime gradient.
   *
   * `ParticleSystem#setGradient` samples them across a particle's own life, so
   * they are labelled by *when* they are seen rather than by what they are —
   * `A` is the instant it is born, `D` is the moment it dies.
   *
   * @param {string} prefix settings key without the A/B/C/D suffix
   */
  static gradient(folder, object, prefix, title) {
    const group = folder.addFolder(title);
    group.addColor(object, `${prefix}A`).name('birth');
    group.addColor(object, `${prefix}B`).name('early');
    group.addColor(object, `${prefix}C`).name('late');
    group.addColor(object, `${prefix}D`).name('death');
    return group;
  }

  refresh() {
    this.gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  }

  toggle() {
    this._hidden = !this._hidden;
    this.gui.show(!this._hidden);
  }

  /* ------------------------------------------------------------------ */
  /* folders                                                             */
  /* ------------------------------------------------------------------ */

  _buildPresets() {
    const folder = this.gui.addFolder('Presets');
    const state = this._presetState;

    let selector = folder
      .add(state, 'selected', this.presets.names.length ? this.presets.names : [''])
      .name('preset');

    // lil-gui rebuilds the controller when the option list changes, so the
    // reference has to be replaced rather than mutated.
    const refreshOptions = () => {
      const names = this.presets.names;
      selector = selector.options(names.length ? names : ['']).name('preset');
      selector.setValue(names.includes(state.selected) ? state.selected : (names[0] ?? ''));
    };

    folder.add(state, 'name').name('name');

    folder
      .add(
        {
          save: () => {
            this.presets.save(state.name);
            state.selected = state.name;
            refreshOptions();
            this.hooks.onToast?.(`Saved preset "${state.name}"`);
          }
        },
        'save'
      )
      .name('Save preset');

    folder
      .add(
        {
          load: () => {
            if (this.presets.load(state.selected)) {
              this.refresh();
              this.hooks.onToast?.(`Loaded "${state.selected}"`);
            }
          }
        },
        'load'
      )
      .name('Load preset');

    folder
      .add(
        {
          duplicate: () => {
            const copy = this.presets.duplicate(state.selected);
            if (copy) {
              state.selected = copy;
              refreshOptions();
              this.hooks.onToast?.(`Duplicated to "${copy}"`);
            }
          }
        },
        'duplicate'
      )
      .name('Duplicate');

    folder
      .add(
        {
          remove: () => {
            if (this.presets.remove(state.selected)) {
              refreshOptions();
              this.hooks.onToast?.('Preset deleted');
            }
          }
        },
        'remove'
      )
      .name('Delete');

    folder.add({ exportOne: () => this.presets.exportJSON() }, 'exportOne').name('Export current (JSON)');
    folder.add({ exportAll: () => this.presets.exportAll() }, 'exportAll').name('Export all presets');

    folder
      .add(
        {
          import: async () => {
            const result = await this.presets.importFromFile();
            refreshOptions();
            this.refresh();
            this.hooks.onToast?.(
              result.applied
                ? 'Settings imported'
                : result.imported.length
                  ? `Imported ${result.imported.length} preset(s)`
                  : 'Nothing imported'
            );
          }
        },
        'import'
      )
      .name('Import JSON…');

    folder
      .add(
        {
          reset: () => {
            this.presets.reset();
            this.refresh();
            this.hooks.onToast?.('Reset to defaults');
          }
        },
        'reset'
      )
      .name('Reset to defaults');

    this.presetFolder = folder;
  }

  _buildGlobal() {
    const folder = this.gui.addFolder('Global');
    const g = settings.global;
    const R = Editor.range;

    R(folder, g, 'timeScale', 0.02, 2, 0.01, 'time scale');
    R(folder, g, 'speed', 0.1, 4, 0.01, 'cast speed');
    R(folder, g, 'lifetime', 0.1, 4, 0.01, 'lifetime');
    R(folder, g, 'glow', 0, 5, 0.01, 'glow intensity');
    R(folder, g, 'shaderIntensity', 0, 2, 0.01, 'shader intensity');
    R(folder, g, 'opacity', 0, 2, 0.01, 'opacity');
    R(folder, g, 'noiseFrequency', 0.1, 4, 0.01, 'noise frequency');
    R(folder, g, 'noiseSpeed', 0, 4, 0.01, 'noise speed');
    R(folder, g, 'turbulence', 0, 4, 0.01, 'turbulence');
    R(folder, g, 'randomness', 0, 2, 0.01, 'randomness');
    R(folder, g, 'fresnel', 0, 3, 0.01, 'fresnel strength');
    R(folder, g, 'distortion', 0, 3, 0.01, 'heat distortion');

    const particles = folder.addFolder('Particles');
    R(particles, g, 'particleCount', 0, 3, 0.01, 'count');
    R(particles, g, 'particleLifetime', 0.1, 3, 0.01, 'lifetime');
    R(particles, g, 'particleSpeed', 0.1, 3, 0.01, 'speed');
    R(particles, g, 'particleSize', 0.1, 3, 0.01, 'size');
    R(particles, g, 'emissionRate', 0, 3, 0.01, 'emission rate');

    const lighting = folder.addFolder('Lighting & impact');
    R(lighting, g, 'lightIntensity', 0, 4, 0.01, 'light intensity');
    R(lighting, g, 'lightRadius', 0.1, 4, 0.01, 'light radius');
    R(lighting, g, 'explosionIntensity', 0, 3, 0.01, 'impact intensity');
    R(lighting, g, 'cameraShake', 0, 3, 0.01, 'camera shake');
    R(lighting, g, 'animationSpeed', 0, 3, 0.01, 'animation speed');

    this.globalFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildAim() {
    const folder = this.gui.addFolder('➤  Aim indicator');
    const a = settings.aim;
    const R = Editor.range;

    const shape = folder.addFolder('Silhouette (metres)');
    R(shape, a, 'shaftWidth', 0.05, 2, 0.01, 'shaft half-width');
    R(shape, a, 'headLength', 0.2, 8, 0.05, 'head length');
    R(shape, a, 'headWidth', 0.1, 5, 0.01, 'head half-width');
    R(shape, a, 'round', 0, 0.6, 0.01, 'corner rounding');
    R(shape, a, 'startOffset', 0, 5, 0.05, 'gap at the caster');
    R(shape, a, 'height', 0.005, 0.4, 0.005, 'hover height');

    const look = folder.addFolder('Rendering');
    R(look, a, 'edge', 0.01, 0.5, 0.005, 'outline thickness');
    R(look, a, 'edgeGlow', 0, 8, 0.05, 'outline glow');
    R(look, a, 'softness', 0.005, 0.5, 0.005, 'edge softness');
    R(look, a, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(look, a, 'fillFalloff', 0.1, 4, 0.05, 'fill falloff');
    R(look, a, 'opacity', 0, 2, 0.01, 'opacity');
    look.addColor(a, 'colorCore').name('core colour');
    look.addColor(a, 'colorEdge').name('edge colour');
    look.addColor(a, 'colorInvalid').name('too-close colour');

    const energy = folder.addFolder('Energy & frost');
    R(energy, a, 'stripes', 0, 4, 0.01, 'chevrons / metre');
    R(energy, a, 'stripeSharp', 0, 1, 0.01, 'chevron sharpness');
    R(energy, a, 'stripeDepth', 0, 1, 0.01, 'chevron depth');
    R(energy, a, 'scrollSpeed', -10, 10, 0.05, 'scroll speed');
    R(energy, a, 'pulse', 0, 1, 0.01, 'pulse');
    R(energy, a, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');
    R(energy, a, 'noise', 0, 1.5, 0.01, 'frost noise');
    R(energy, a, 'noiseScale', 0.1, 8, 0.05, 'noise scale');
    R(energy, a, 'noiseSpeed', 0, 3, 0.01, 'noise speed');
    R(energy, a, 'crystals', 0, 2, 0.01, 'frost plates');
    R(energy, a, 'crystalScale', 0.2, 10, 0.05, 'plate scale');

    const furniture = folder.addFolder('Rings & rosette');
    R(furniture, a, 'baseRing', 0, 3, 0.01, 'base ring radius');
    R(furniture, a, 'baseRingWidth', 0.005, 0.4, 0.005, 'base ring width');
    R(furniture, a, 'tipGlyph', 0, 2, 0.01, 'tip rosette');
    R(furniture, a, 'tipGlyphSize', 0.1, 4, 0.05, 'rosette radius');
    R(furniture, a, 'tipSpin', -3, 3, 0.01, 'rosette spin');
    R(furniture, a, 'rangeArc', 0, 2, 0.01, 'range arc');
    R(furniture, a, 'reveal', 0.01, 1, 0.005, 'sweep-out time');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The far-cast indicator — the circle every zone ability is aimed with.
   *
   * Shared, like the arrow: it is a property of the *targeting*, not of any one
   * ability, so a second far cast inherits the whole thing and brings only its
   * own `zoneRadius`. The two controls worth reaching for first are `boundary`
   * (how thick the footprint edge reads) and `snap` (how hard it overshoots on
   * the way out), which between them decide whether the circle feels like a UI
   * overlay or like something the caster is doing.
   */
  _buildZone() {
    const folder = this.gui.addFolder('◎  Far-cast circle');
    const z = settings.zone;
    const R = Editor.range;

    const edge = folder.addFolder('The boundary (metres)');
    R(edge, z, 'boundary', 0.02, 2, 0.01, 'band thickness');
    R(edge, z, 'boundaryBias', 0, 1, 0.01, 'band bias out/in');
    R(edge, z, 'boundaryGlow', 0, 8, 0.05, 'band glow');
    R(edge, z, 'liner', 0.005, 0.4, 0.005, 'inner liner');
    R(edge, z, 'softness', 0.005, 0.4, 0.005, 'edge softness');
    R(edge, z, 'height', 0.005, 0.4, 0.005, 'hover height');

    const inside = folder.addFolder('The interior');
    R(inside, z, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(inside, z, 'fillFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(inside, z, 'rings', 0, 12, 0.1, 'contour rings');
    R(inside, z, 'ringWidth', 0.005, 0.5, 0.005, 'ring width');
    R(inside, z, 'ringSpeed', -4, 4, 0.01, 'ring speed');
    R(inside, z, 'crawl', 0, 3, 0.01, 'filaments');
    R(inside, z, 'crawlScale', 0.1, 8, 0.05, 'filaments / metre');
    R(inside, z, 'crawlSpeed', -4, 4, 0.01, 'filament crawl');
    R(inside, z, 'noise', 0, 1.5, 0.01, 'break-up');
    R(inside, z, 'noiseScale', 0.1, 8, 0.05, 'break-up scale');

    const furniture = folder.addFolder('Ticks, sweep & reticle');
    R(furniture, z, 'ticks', 0, 96, 1, 'boundary ticks');
    R(furniture, z, 'tickLength', 0.05, 3, 0.01, 'tick length');
    R(furniture, z, 'tickWidth', 0.02, 0.9, 0.01, 'tick duty');
    R(furniture, z, 'tickSpin', -2, 2, 0.005, 'tick spin');
    R(furniture, z, 'sweep', 0, 3, 0.01, 'radar sweep');
    R(furniture, z, 'sweepSpeed', -3, 3, 0.01, 'sweep speed');
    R(furniture, z, 'core', 0, 3, 0.01, 'centre mark');
    R(furniture, z, 'coreSize', 0.05, 3, 0.01, 'centre size');
    R(furniture, z, 'crosshair', 0, 3, 0.01, 'reticle arms');
    R(furniture, z, 'crosshairLength', 0.1, 6, 0.05, 'arm length');
    R(furniture, z, 'pulse', 0, 1, 0.01, 'pulse');
    R(furniture, z, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');

    const reach = folder.addFolder('The reach ring');
    R(reach, z, 'reach', 0, 3, 0.01, 'reach brightness');
    R(reach, z, 'reachWidth', 0.005, 0.5, 0.005, 'reach width');
    R(reach, z, 'reachDashes', 0, 200, 1, 'dashes');
    R(reach, z, 'reachDashGap', 0, 0.95, 0.01, 'dash gap');
    R(reach, z, 'reachSpin', -1, 1, 0.005, 'dash creep');
    R(reach, z, 'reachLead', 0, 3, 0.01, 'lead marker');

    const look = folder.addFolder('Rendering');
    R(look, z, 'opacity', 0, 2, 0.01, 'opacity');
    R(look, z, 'reveal', 0.01, 1, 0.005, 'snap-out time');
    R(look, z, 'snap', 1, 2, 0.01, 'snap overshoot');
    look.addColor(z, 'colorCore').name('core colour');
    look.addColor(z, 'colorEdge').name('fill colour');
    look.addColor(z, 'colorInvalid').name('too-close colour');
  }

  /* ------------------------------------------------------------------ */

  _buildIce() {
    const folder = this.gui.addFolder('❄  Frost Lance');
    const c = settings.ice;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 2, 40, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 2, 80, 0.5, 'front speed');
    R(cast, c, 'lifetime', 0.2, 12, 0.1, 'field lifetime');
    R(cast, c, 'cooldown', 0, 6, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const field = folder.addFolder('Footprint');
    R(field, c, 'widthNear', 0.05, 6, 0.01, 'width at caster');
    R(field, c, 'width', 0.1, 10, 0.05, 'width at target');
    R(field, c, 'widthCurve', 0.2, 4, 0.01, 'width curve');
    R(field, c, 'spikeCount', 4, 288, 1, 'crystal count');
    R(field, c, 'density', 0.05, 1, 0.01, 'density');
    R(field, c, 'clumping', 0.3, 4, 0.01, 'pull to centre');
    R(field, c, 'scatter', 0, 2, 0.01, 'lateral scatter');
    R(field, c, 'frontBias', 0.3, 3, 0.01, 'crowd toward target');

    const shape = folder.addFolder('Silhouette');
    R(shape, c, 'heightNear', 0.05, 6, 0.01, 'height at caster');
    R(shape, c, 'height', 0.1, 12, 0.05, 'height at target');
    R(shape, c, 'heightCurve', 0.2, 5, 0.01, 'height curve');
    R(shape, c, 'heightJitter', 0, 1.5, 0.01, 'height jitter');
    R(shape, c, 'crown', 0, 0.95, 0.01, 'flank falloff');
    R(shape, c, 'peak', 1, 4, 0.01, 'swell at target');
    R(shape, c, 'peakWidth', 0.02, 1, 0.01, 'swell width');
    R(shape, c, 'rubble', 0, 1, 0.01, 'rubble fraction');
    R(shape, c, 'rubbleScale', 0.05, 1, 0.01, 'rubble height');

    // These four regenerate the crystal geometry — see IceAbility#_syncGeometry.
    const crystal = folder.addFolder('The crystal');
    R(crystal, c, 'radius', 0.02, 1.5, 0.01, 'base radius');
    R(crystal, c, 'radiusJitter', 0, 1.5, 0.01, 'radius jitter');
    R(crystal, c, 'taper', 0.01, 0.8, 0.01, 'tip taper');
    R(crystal, c, 'facets', 3, 10, 1, 'facets');
    R(crystal, c, 'roughness', 0, 1, 0.01, 'surface roughness');
    R(crystal, c, 'bend', 0, 1.5, 0.01, 'bend');
    R(crystal, c, 'lean', 0, 1.4, 0.01, 'lean from caster');
    R(crystal, c, 'leanJitter', 0, 1.5, 0.01, 'lean jitter');
    R(crystal, c, 'twist', 0, 1, 0.01, 'random yaw');

    const rise = folder.addFolder('The eruption');
    R(rise, c, 'riseTime', 0.02, 1.5, 0.01, 'rise time');
    R(rise, c, 'riseOvershoot', 0, 1, 0.01, 'punch overshoot');
    R(rise, c, 'riseStagger', 0, 1, 0.005, 'stagger');
    R(rise, c, 'settle', 0.05, 2, 0.01, 'settle time');
    R(rise, c, 'shatterDelay', 0, 4, 0.05, 'hold before sinking');
    R(rise, c, 'sinkTime', 0.1, 4, 0.05, 'sink time');

    const material = folder.addFolder('Ice material');
    material.addColor(c, 'colorDeep').name('deep');
    material.addColor(c, 'colorIce').name('body');
    material.addColor(c, 'colorRim').name('rim');
    material.addColor(c, 'colorCore').name('inner light');
    R(material, c, 'opacity', 0, 1, 0.01, 'opacity');
    R(material, c, 'depthTint', 0, 3, 0.01, 'thickness tint');
    R(material, c, 'fresnel', 0, 6, 0.01, 'fresnel');
    R(material, c, 'fresnelPower', 0.5, 6, 0.05, 'fresnel power');
    R(material, c, 'translucency', 0, 4, 0.01, 'translucency');
    R(material, c, 'envIntensity', 0, 3, 0.01, 'reflection');
    R(material, c, 'facetSharp', 0, 1.5, 0.01, 'facet contrast');
    R(material, c, 'fracture', 0, 2, 0.01, 'internal cracks');
    R(material, c, 'fractureScale', 0.5, 20, 0.1, 'crack scale');
    R(material, c, 'veins', 0, 2, 0.01, 'feather frost');
    R(material, c, 'veinScale', 0.2, 10, 0.05, 'frost scale');
    R(material, c, 'glint', 0, 5, 0.01, 'surface glint');
    R(material, c, 'glintScale', 4, 90, 0.5, 'glint scale');
    R(material, c, 'glintSpeed', 0, 4, 0.01, 'glint speed');
    R(material, c, 'frostLine', 0, 1.5, 0.01, 'rime at the base');
    R(material, c, 'glow', 0, 5, 0.01, 'glow');
    R(material, c, 'edgeGlow', 0, 6, 0.01, 'edge glow');
    R(material, c, 'birthGlow', 0, 10, 0.05, 'birth flash');
    R(material, c, 'birthFade', 0.02, 2, 0.01, 'birth flash time');

    const ground = folder.addFolder('Frost on the ground');
    R(ground, c, 'frostSpread', 0.1, 5, 0.01, 'patch radius');
    R(ground, c, 'frostRate', 0.2, 12, 0.1, 'patches / metre');
    R(ground, c, 'frostLife', 0.5, 20, 0.1, 'patch lifetime');
    R(ground, c, 'frostIntensity', 0, 2, 0.01, 'intensity');
    R(ground, c, 'frostCrystals', 0, 4, 0.01, 'snow grain');
    R(ground, c, 'shockRadius', 0.5, 20, 0.1, 'shockwave radius');
    ground.addColor(c, 'colorFrost').name('snow');
    ground.addColor(c, 'colorFrostEdge').name('snow shadow');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');

    const mist = folder.addFolder('Mist, chips & glitter');
    R(mist, c, 'mistRate', 0, 900, 1, 'mist rate');
    R(mist, c, 'mistSize', 0.05, 4, 0.01, 'mist size');
    R(mist, c, 'mistSpeed', 0, 8, 0.05, 'mist speed');
    R(mist, c, 'mistLifetime', 0.2, 8, 0.05, 'mist lifetime');
    R(mist, c, 'mistOpacity', 0, 2, 0.01, 'mist opacity');
    R(mist, c, 'mistRise', -2, 4, 0.01, 'mist rise');
    R(mist, c, 'shardRate', 0, 500, 1, 'chip rate');
    R(mist, c, 'shardSize', 0.005, 0.5, 0.005, 'chip size');
    R(mist, c, 'shardSpeed', 0, 25, 0.1, 'chip speed');
    R(mist, c, 'shardLifetime', 0.1, 5, 0.05, 'chip lifetime');
    R(mist, c, 'shardGravity', -40, 0, 0.1, 'chip gravity');
    R(mist, c, 'sparkleRate', 0, 600, 1, 'glitter rate');
    R(mist, c, 'sparkleSize', 0.005, 0.4, 0.005, 'glitter size');
    R(mist, c, 'sparkleSpeed', 0, 12, 0.05, 'glitter speed');
    R(mist, c, 'sparkleLifetime', 0.2, 8, 0.05, 'glitter lifetime');
    R(mist, c, 'sparkleRise', -2, 8, 0.05, 'glitter rise');
    R(mist, c, 'sparkleTurbulence', 0, 3, 0.01, 'glitter turbulence');
    Editor.gradient(mist, c, 'colorMist', 'Mist colour');
    Editor.gradient(mist, c, 'colorShard', 'Chip colour');
    Editor.gradient(mist, c, 'colorSparkle', 'Glitter colour');

    const impact = folder.addFolder('Impact');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, 'burst size');
    R(impact, c, 'burstIntensity', 0, 4, 0.01, 'burst intensity');
    R(impact, c, 'burstShards', 0, 400, 1, 'burst chips');
    R(impact, c, 'impactShake', 0, 3, 0.01, 'shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'impactFlash', 0, 2, 0.01, 'screen flash');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    impact.addColor(c, 'colorBurstA').name('vapour shell');
    impact.addColor(c, 'colorBurstB').name('shell body');
    impact.addColor(c, 'colorBurstC').name('plates & rim');
    impact.addColor(c, 'colorFlash').name('screen flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 80, 0.1, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 40, 0.1, 'light radius');
    light.addColor(c, 'lightColor').name('light colour');

    this.iceFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Storm Lance.
   *
   * Every control here is read by the vertex shader on the frame it changes, so
   * the whole folder reshapes a bolt that is already in the air. The ones worth
   * reaching for first are `jitter` and `jitterScale` (how violently it kinks),
   * `strands` and `spread` (how wide the bundle reads) and `restrike` (how hard
   * it strobes) — those four carry the character of the effect.
   */
  _buildThunder() {
    const folder = this.gui.addFolder('⚡  Storm Lance');
    const c = settings.thunder;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 2, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 400, 1, 'strike speed');
    R(cast, c, 'lifetime', 0.05, 6, 0.01, 'bolt lifetime');
    R(cast, c, 'fadeTime', 0.05, 4, 0.01, 'blow-out time');
    R(cast, c, 'cooldown', 0, 6, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const anchor = folder.addFolder('Where it leaves the hand');
    R(anchor, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(anchor, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(anchor, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(anchor, c, 'endHeight', 0, 4, 0.01, 'height at target');
    R(anchor, c, 'sag', -3, 3, 0.01, 'mid-span bow');

    const bundle = folder.addFolder('The bundle');
    R(bundle, c, 'strands', 1, 24, 1, 'filaments');
    R(bundle, c, 'spread', 0, 5, 0.01, 'fan at target');
    R(bundle, c, 'spreadNear', 0, 2, 0.01, 'fan at hand');
    R(bundle, c, 'spreadCurve', 0.2, 5, 0.01, 'fan curve');
    R(bundle, c, 'twist', -4, 4, 0.01, 'twist over length');
    R(bundle, c, 'twistSpeed', -6, 6, 0.01, 'twist speed');
    R(bundle, c, 'branchDim', 0, 1, 0.01, 'outer filament dim');

    const shape = folder.addFolder('The filament');
    R(shape, c, 'jitter', 0, 3, 0.01, 'kink amplitude');
    R(shape, c, 'jitterScale', 0.05, 6, 0.01, 'kinks / metre');
    R(shape, c, 'octaves', 1, 5, 1, 'octaves');
    R(shape, c, 'jitterFalloff', 0.1, 0.95, 0.01, 'octave falloff');
    R(shape, c, 'crawl', -20, 20, 0.1, 'kink crawl');
    R(shape, c, 'pinch', 0.01, 0.5, 0.005, 'end pinch');
    R(shape, c, 'converge', 0, 1, 0.01, 'lock onto target');

    const ribbon = folder.addFolder('The ribbon');
    R(ribbon, c, 'width', 0.005, 0.6, 0.005, 'width at hand');
    R(ribbon, c, 'widthTip', 0.02, 3, 0.01, 'width at target');
    R(ribbon, c, 'widthCurve', 0.1, 4, 0.01, 'taper curve');
    R(ribbon, c, 'coreWidth', 1, 6, 0.01, 'spine thickness');
    R(ribbon, c, 'coreSharp', 0.5, 12, 0.05, 'core sharpness');
    R(ribbon, c, 'glowWidth', 1, 30, 0.1, 'halo width');
    R(ribbon, c, 'glowFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(ribbon, c, 'glowOpacity', 0, 2, 0.01, 'halo opacity');
    R(ribbon, c, 'softFade', 0.02, 3, 0.01, 'soft intersection');

    const strobe = folder.addFolder('Flicker & restrike');
    R(strobe, c, 'restrike', 0.5, 90, 0.5, 'restrikes / sec');
    R(strobe, c, 'flicker', 0, 1, 0.01, 'brightness stutter');
    R(strobe, c, 'flickerSpeed', 1, 120, 1, 'stutter rate');
    R(strobe, c, 'strandFlash', 0, 1, 0.01, 'filament blink');
    R(strobe, c, 'tipGlow', 0, 8, 0.05, 'leading-edge glow');
    R(strobe, c, 'tipLength', 0.005, 0.5, 0.005, 'leading-edge length');

    const material = folder.addFolder('Bolt colour');
    material.addColor(c, 'colorCore').name('core');
    material.addColor(c, 'colorInner').name('inner');
    material.addColor(c, 'colorOuter').name('outer');
    material.addColor(c, 'colorHalo').name('halo');
    R(material, c, 'glow', 0, 8, 0.01, 'glow');
    R(material, c, 'opacity', 0, 2, 0.01, 'opacity');

    const ground = folder.addFolder('Burns on the ground');
    R(ground, c, 'arcRate', 0.05, 8, 0.05, 'burns / metre');
    R(ground, c, 'arcRadius', 0.1, 8, 0.05, 'burn radius');
    R(ground, c, 'arcLife', 0.05, 5, 0.05, 'burn lifetime');
    R(ground, c, 'arcIntensity', 0, 3, 0.01, 'burn intensity');
    R(ground, c, 'arcBranches', 0, 3, 0.01, 'branch detail');
    R(ground, c, 'scorchRadius', 0.05, 4, 0.05, 'scorch radius');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, 'scorch lifetime');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, 'scorch intensity');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, 'shockwave radius');
    ground.addColor(c, 'colorArc').name('burn');
    ground.addColor(c, 'colorEmber').name('ember');
    ground.addColor(c, 'colorScorch').name('scorch');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');

    const sparks = folder.addFolder('Sparks & motes');
    R(sparks, c, 'sparkRate', 0, 1200, 1, 'spark rate');
    R(sparks, c, 'sparkSize', 0.005, 0.8, 0.005, 'spark size');
    R(sparks, c, 'sparkSpeed', 0, 40, 0.1, 'spark speed');
    R(sparks, c, 'sparkLifetime', 0.05, 4, 0.01, 'spark lifetime');
    R(sparks, c, 'sparkGravity', -50, 5, 0.1, 'spark gravity');
    R(sparks, c, 'sparkStretch', 0, 3, 0.01, 'spark stretch');
    R(sparks, c, 'moteRate', 0, 600, 1, 'mote rate');
    R(sparks, c, 'moteSize', 0.005, 0.4, 0.005, 'mote size');
    R(sparks, c, 'moteSpeed', 0, 12, 0.05, 'mote speed');
    R(sparks, c, 'moteLifetime', 0.1, 8, 0.05, 'mote lifetime');
    R(sparks, c, 'moteRise', -3, 8, 0.05, 'mote rise');
    R(sparks, c, 'moteTurbulence', 0, 3, 0.01, 'mote turbulence');
    Editor.gradient(sparks, c, 'colorSpark', 'Spark colour');
    Editor.gradient(sparks, c, 'colorMote', 'Mote colour');

    const dust = folder.addFolder('Smoke & debris');
    R(dust, c, 'smokeRate', 0, 500, 1, 'smoke rate');
    R(dust, c, 'smokeSize', 0.05, 4, 0.01, 'smoke size');
    R(dust, c, 'smokeSpeed', 0, 8, 0.05, 'smoke speed');
    R(dust, c, 'smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime');
    R(dust, c, 'smokeOpacity', 0, 1, 0.005, 'smoke opacity');
    R(dust, c, 'smokeRise', -2, 4, 0.01, 'smoke rise');
    R(dust, c, 'debrisRate', 0, 300, 1, 'debris rate');
    R(dust, c, 'debrisSize', 0.005, 0.4, 0.005, 'debris size');
    R(dust, c, 'debrisSpeed', 0, 25, 0.1, 'debris speed');
    R(dust, c, 'debrisLifetime', 0.1, 5, 0.05, 'debris lifetime');
    R(dust, c, 'debrisGravity', -50, 0, 0.1, 'debris gravity');
    Editor.gradient(dust, c, 'colorSmoke', 'Smoke colour');
    Editor.gradient(dust, c, 'colorDebris', 'Debris colour');

    const impact = folder.addFolder('Muzzle & impact');
    R(impact, c, 'muzzleSize', 0.05, 6, 0.05, 'muzzle size');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'muzzle intensity');
    R(impact, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    impact.addColor(c, 'colorMuzzleA').name('muzzle shell');
    impact.addColor(c, 'colorMuzzleB').name('muzzle body');
    impact.addColor(c, 'colorMuzzleC').name('muzzle arcs');
    impact.addColor(c, 'colorCastFlash').name('release flash colour');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, 'burst size');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, 'burst intensity');
    R(impact, c, 'burstSparks', 0, 600, 1, 'burst sparks');
    R(impact, c, 'burstDebris', 0, 300, 1, 'burst debris');
    R(impact, c, 'impactShake', 0, 3, 0.01, 'shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'impactFlash', 0, 2, 0.01, 'screen flash');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    impact.addColor(c, 'colorBurstA').name('burst shell');
    impact.addColor(c, 'colorBurstB').name('burst body');
    impact.addColor(c, 'colorBurstC').name('burst arcs');
    impact.addColor(c, 'colorFlash').name('impact flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightFlicker', 0, 1, 0.01, 'light gutter');
    R(light, c, 'lightFlickerSpeed', 1, 90, 1, 'gutter rate');
    light.addColor(c, 'lightColor').name('light colour');

    this.thunderFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Cinder Fall.
   *
   * The seven controls under "The rock" regenerate real geometry — see
   * `MeteorAbility#_syncGeometry` — and everything else is read by a shader or
   * resolved from scratch on the frame it changes, so the whole folder reshapes
   * a meteor that is already in the air. The ones worth reaching for first are
   * `arc` (how hard it is lobbed), `crackWidth` and `chargeCurve` (how the lava
   * seams open on the way in), `trailSpan` and `trailWidth` (how much fire
   * streams off it) and `chunkSpeed` (how far the wreckage is thrown).
   */
  _buildMeteor() {
    const folder = this.gui.addFolder('☄  Cinder Fall');
    const c = settings.meteor;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 2, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 3, 90, 0.5, 'travel speed');
    R(cast, c, 'lifetime', 0.2, 10, 0.1, 'crater lifetime');
    R(cast, c, 'fadeTime', 0.1, 6, 0.05, 'clear-out time');
    R(cast, c, 'cooldown', 0, 6, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const path = folder.addFolder('The flight path');
    R(path, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(path, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(path, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(path, c, 'endHeight', 0, 4, 0.01, 'height at target');
    R(path, c, 'arc', -4, 12, 0.05, 'lob height');
    R(path, c, 'arcCurve', 0.1, 4, 0.01, 'lob curve');

    // Everything down to `craterSize` rebuilds the asteroid geometry. `cuts` is
    // the one that decides whether it reads as stone: it slices flat fracture
    // faces off the ball, which no amount of noise can fake.
    const rock = folder.addFolder('The rock');
    R(rock, c, 'radius', 0.05, 3, 0.01, 'radius');
    R(rock, c, 'facets', 0, 3, 1, 'subdivisions');
    R(rock, c, 'lumpiness', 0, 0.8, 0.01, 'lumpiness');
    R(rock, c, 'lumpScale', 0.2, 6, 0.05, 'lumps / radius');
    R(rock, c, 'surfaceRoughness', 0, 1, 0.01, 'surface roughness');
    R(rock, c, 'cuts', 0, 16, 1, 'fracture faces');
    R(rock, c, 'cutDepth', 0, 0.5, 0.01, 'fracture depth');
    R(rock, c, 'craters', 0, 14, 1, 'craters');
    R(rock, c, 'craterDepth', 0, 0.6, 0.01, 'crater depth');
    R(rock, c, 'craterSize', 0.05, 1.4, 0.01, 'crater size');
    R(rock, c, 'spin', -20, 20, 0.1, 'tumble rate');

    const seams = folder.addFolder('Lava seams');
    R(seams, c, 'chargeCurve', 0.1, 5, 0.01, 'heat-up curve');
    R(seams, c, 'crackScale', 0.3, 10, 0.05, 'seams / radius');
    R(seams, c, 'crackWidth', 0.005, 0.5, 0.005, 'seam width');
    R(seams, c, 'crackBranches', 0, 1.5, 0.01, 'branch seams');
    R(seams, c, 'crackGlow', 0, 10, 0.05, 'seam glow');
    R(seams, c, 'crackFlow', 0, 1, 0.01, 'magma crawl');
    R(seams, c, 'crackFlowSpeed', 0, 5, 0.01, 'crawl speed');
    R(seams, c, 'rockScale', 0.2, 10, 0.05, 'rock mottling');
    R(seams, c, 'facetTint', 0, 1.2, 0.01, 'per-facet tint');
    R(seams, c, 'cavity', 0, 1, 0.01, 'cavity shading');
    R(seams, c, 'soot', 0, 1.5, 0.01, 'soot around seams');
    R(seams, c, 'rimHeat', 0, 4, 0.01, 'heat sheath');
    R(seams, c, 'leadGlow', 0, 6, 0.01, 'leading-face heat');
    R(seams, c, 'leadSharp', 0.5, 8, 0.05, 'leading-face falloff');
    R(seams, c, 'glow', 0, 4, 0.01, 'glow');
    R(seams, c, 'envIntensity', 0, 3, 0.01, 'reflection');
    seams.addColor(c, 'colorRock').name('rock');
    seams.addColor(c, 'colorChar').name('char');
    seams.addColor(c, 'colorCrack').name('seam');
    seams.addColor(c, 'colorHot').name('white hot');

    // The trail is a raymarched volume, so these are volume parameters, not
    // surface ones — see `materials/VolumetricFireMaterial.js`. `trailWidth`,
    // `trailPlume` and `trailSpan` set its shape; `trailSteps` is the cost dial.
    const trail = folder.addFolder('The fire trail');
    R(trail, c, 'trailSpan', 0.5, 30, 0.1, 'trail length');
    R(trail, c, 'trailWidth', 0.02, 2, 0.01, 'tube radius');
    R(trail, c, 'trailHeadSize', 0.5, 5, 0.01, 'head size');
    R(trail, c, 'trailPlume', 0.3, 4, 0.01, 'upward stretch');
    R(trail, c, 'trailWakeSpread', 0, 3, 0.01, 'wake spread');
    R(trail, c, 'trailRise', 0, 3, 0.01, 'wake rise');
    R(trail, c, 'trailDetachment', 0, 1.5, 0.01, 'tail break-up');
    R(trail, c, 'trailSoftness', 0.05, 1, 0.01, 'surface softness');
    R(trail, c, 'trailBurnout', 0.05, 4, 0.05, 'burn-out time');
    R(trail, c, 'trailTailFade', 0.01, 0.8, 0.01, 'tail burn-out');

    // Metre-scale lobes. Without these the outline stays a capsule no matter how
    // much fine turbulence is piled on top of it.
    const silhouette = trail.addFolder('Silhouette');
    R(silhouette, c, 'trailBulge', 0, 1, 0.01, 'lobe depth');
    R(silhouette, c, 'trailBulgeScale', 0.05, 2, 0.01, 'lobes / metre');
    R(silhouette, c, 'trailShred', 0, 4, 0.01, 'fringe shred');
    R(silhouette, c, 'trailWisps', 0, 2, 0.01, 'wisps');
    R(silhouette, c, 'trailLick', 0, 8, 0.05, 'radial shear');

    const motion = trail.addFolder('Motion & turbulence');
    R(motion, c, 'trailSpeed', 0, 12, 0.01, 'flow speed');
    R(motion, c, 'trailBuoyancy', 0, 10, 0.01, 'buoyancy');
    R(motion, c, 'trailTurbulence', 0, 8, 0.01, 'turbulence');
    R(motion, c, 'trailNoiseStrength', 0, 4, 0.01, 'noise strength');
    R(motion, c, 'trailNoiseFrequency', 0.1, 10, 0.01, 'noise frequency');
    R(motion, c, 'trailWarp', 0, 1.5, 0.01, 'domain warp');
    R(motion, c, 'trailCurl', 0, 3, 0.01, 'axial swirl');
    R(motion, c, 'trailVortex', 0, 2, 0.01, 'vortex roll-up');
    R(motion, c, 'trailRingFrequency', 0, 3, 0.01, 'rings / metre');
    R(motion, c, 'trailRingSpeed', 0, 10, 0.05, 'ring speed');
    R(motion, c, 'trailTongue', 0.2, 3, 0.01, 'tongue stretch');
    R(motion, c, 'trailStreamStretch', 0.2, 3, 0.01, 'streamwise stretch');
    R(motion, c, 'trailFlicker', 0, 2, 0.01, 'flicker');
    R(motion, c, 'trailOctaves', 1, 5, 1, 'detail octaves');

    // The flame is shaded as a Planckian radiator: colour comes out of the
    // temperature. `trailPalette` blends toward the hand-authored stops instead.
    const heat = trail.addFolder('Temperature & radiance');
    R(heat, c, 'trailTempCore', 1000, 5000, 10, 'core temperature (K)');
    R(heat, c, 'trailTempEdge', 1000, 4000, 10, 'edge temperature (K)');
    R(heat, c, 'trailEmissionCurve', 1, 6, 0.01, 'radiance exponent');
    R(heat, c, 'trailHeatFocus', 0.05, 3, 0.01, 'heat focus');
    R(heat, c, 'trailHeatFalloff', 0.05, 4, 0.01, 'heat falloff');
    R(heat, c, 'trailHeatFollow', 0, 1, 0.01, 'heat follows noise');
    R(heat, c, 'trailTailHeat', 0, 1, 0.01, 'spent-gas heat');
    R(heat, c, 'trailScatter', 0, 4, 0.01, 'scatter');
    R(heat, c, 'trailScatterFalloff', 0.2, 8, 0.05, 'scatter falloff');
    R(heat, c, 'trailPalette', 0, 1, 0.01, 'palette vs physics');
    heat.addColor(c, 'colorFlameMid').name('flame mid');
    heat.addColor(c, 'colorFlameEdge').name('flame edge');
    heat.addColor(c, 'colorFlameSmoke').name('flame smoke');

    const march = trail.addFolder('Volume rendering');
    R(march, c, 'trailDensity', 0, 6, 0.01, 'density');
    R(march, c, 'trailSoot', 0, 5, 0.01, 'soot absorption');
    R(march, c, 'trailCoreClarity', 0, 1, 0.01, 'core clarity');
    R(march, c, 'trailGlow', 0, 8, 0.01, 'glow');
    R(march, c, 'trailOpacity', 0, 2, 0.01, 'opacity');
    R(march, c, 'trailSteps', 6, 72, 1, 'raymarch steps');

    const chunks = folder.addFolder('The wreckage');
    R(chunks, c, 'chunkCount', 0, 28, 1, 'chunks');
    R(chunks, c, 'chunkScale', 0.05, 0.8, 0.01, 'chunk size');
    R(chunks, c, 'chunkSpeed', 0, 30, 0.1, 'throw speed');
    R(chunks, c, 'chunkForward', 0, 2, 0.01, 'downrange bias');
    R(chunks, c, 'chunkLoft', 0, 1.5, 0.01, 'loft');
    R(chunks, c, 'chunkGravity', -50, -1, 0.1, 'gravity');
    R(chunks, c, 'chunkSpin', 0, 20, 0.1, 'tumble rate');
    R(chunks, c, 'chunkCool', 0.1, 8, 0.05, 'cool-down time');
    R(chunks, c, 'chunkLinger', 0, 4, 0.05, 'hold before sinking');
    R(chunks, c, 'chunkSink', 0.1, 4, 0.05, 'sink time');

    const embers = folder.addFolder('Embers & sparks');
    R(embers, c, 'emberRate', 0, 900, 1, 'ember rate');
    R(embers, c, 'emberSize', 0.005, 0.5, 0.005, 'ember size');
    R(embers, c, 'emberSpeed', 0, 15, 0.05, 'ember speed');
    R(embers, c, 'emberLifetime', 0.1, 8, 0.05, 'ember lifetime');
    R(embers, c, 'emberRise', -3, 8, 0.05, 'ember rise');
    R(embers, c, 'emberGlow', 0, 4, 0.01, 'ember glow');
    R(embers, c, 'emberTurbulence', 0, 3, 0.01, 'ember turbulence');
    R(embers, c, 'sparkRate', 0, 900, 1, 'spark rate');
    R(embers, c, 'sparkSize', 0.005, 0.8, 0.005, 'spark size');
    R(embers, c, 'sparkSpeed', 0, 40, 0.1, 'spark speed');
    R(embers, c, 'sparkLifetime', 0.05, 4, 0.01, 'spark lifetime');
    R(embers, c, 'sparkGravity', -50, 5, 0.1, 'spark gravity');
    R(embers, c, 'sparkStretch', 0, 3, 0.01, 'spark stretch');
    Editor.gradient(embers, c, 'colorEmber', 'Ember colour');
    Editor.gradient(embers, c, 'colorSpark', 'Spark colour');

    const dust = folder.addFolder('Smoke & grit');
    R(dust, c, 'smokeRate', 0, 500, 1, 'smoke rate');
    R(dust, c, 'smokeSize', 0.05, 4, 0.01, 'smoke size');
    R(dust, c, 'smokeSpeed', 0, 8, 0.05, 'smoke speed');
    R(dust, c, 'smokeLifetime', 0.2, 10, 0.05, 'smoke lifetime');
    R(dust, c, 'smokeOpacity', 0, 1, 0.005, 'smoke opacity');
    R(dust, c, 'smokeRise', -2, 5, 0.01, 'smoke rise');
    R(dust, c, 'debrisSize', 0.005, 0.4, 0.005, 'grit size');
    R(dust, c, 'debrisSpeed', 0, 25, 0.1, 'grit speed');
    R(dust, c, 'debrisLifetime', 0.1, 5, 0.05, 'grit lifetime');
    R(dust, c, 'debrisGravity', -50, 0, 0.1, 'grit gravity');
    Editor.gradient(dust, c, 'colorSmoke', 'Smoke colour');
    Editor.gradient(dust, c, 'colorDebris', 'Grit colour');

    const cracks = folder.addFolder('Molten cracks');
    R(cracks, c, 'fissureRadius', 0.5, 16, 0.05, 'reach');
    R(cracks, c, 'fissureLife', 0.5, 25, 0.1, 'lifetime');
    R(cracks, c, 'fissureArms', 2, 12, 1, 'main cracks');
    R(cracks, c, 'fissureWander', 0, 6, 0.05, 'meander');
    R(cracks, c, 'fissureBranches', 0, 1, 0.01, 'branch density');
    R(cracks, c, 'fissureBranchLength', 0, 1, 0.01, 'branch length');
    R(cracks, c, 'fissureWidth', 0.01, 1, 0.005, 'seam width');
    R(cracks, c, 'fissureHeat', 0, 4, 0.01, 'core heat');
    R(cracks, c, 'fissurePulse', 0, 5, 0.01, 'heat-wave speed');
    R(cracks, c, 'fissureGrowth', 0.5, 40, 0.1, 'spread speed');
    R(cracks, c, 'fissureRockSize', 0, 1.2, 0.01, 'lip rubble size');

    const ground = folder.addFolder('The crater');
    R(ground, c, 'scorchRadius', 0.2, 12, 0.05, 'scorch radius');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, 'scorch lifetime');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, 'scorch intensity');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, 'shockwave radius');
    ground.addColor(c, 'colorScorch').name('scorch');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');

    const impact = folder.addFolder('Launch & detonation');
    R(impact, c, 'muzzleSize', 0, 6, 0.05, 'launch flare'); // 0 = no flare
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'launch intensity');
    R(impact, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    impact.addColor(c, 'colorCastFlash').name('release flash colour');
    R(impact, c, 'burstSize', 0.2, 18, 0.05, 'fireball size');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, 'fireball intensity');
    R(impact, c, 'burstTurbulence', 0, 4, 0.01, 'fireball turbulence');
    R(impact, c, 'burstEmbers', 0, 800, 1, 'burst embers');
    R(impact, c, 'burstSparks', 0, 600, 1, 'burst sparks');
    R(impact, c, 'burstDebris', 0, 400, 1, 'burst grit');
    R(impact, c, 'burstSmoke', 0, 300, 1, 'burst smoke');
    R(impact, c, 'impactShake', 0, 3, 0.01, 'shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'impactFlash', 0, 2, 0.01, 'screen flash');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    impact.addColor(c, 'colorFlash').name('impact flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightFlicker', 0, 1, 0.01, 'light gutter');
    R(light, c, 'lightFlickerSpeed', 1, 60, 0.5, 'gutter rate');
    light.addColor(c, 'lightColor').name('light colour');

    this.meteorFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Nova Beam.
   *
   * Every control here is read by a shader on the frame it changes, so the whole
   * folder reshapes a beam that is already burning — pause with **P** halfway
   * through the hold and the entire panel stays live. The ones worth reaching
   * for first are `radius` and `flare` (how heavy the column reads), `charge`
   * and `lifetime` (the wind-up and the hold, which are what make this ability
   * different from the other three), `coils` / `coilTurns` (the ribbons around
   * it) and `streak` / `flowSpeed` (how hard the energy streams downrange).
   */
  _buildBeam() {
    const folder = this.gui.addFolder('✦  Nova Beam');
    const c = settings.beam;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 2, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'charge', 0, 3, 0.01, 'wind-up time');
    R(cast, c, 'speed', 5, 400, 1, 'travel speed');
    R(cast, c, 'lifetime', 0.05, 8, 0.01, 'burn time');
    R(cast, c, 'fadeTime', 0.05, 4, 0.01, 'collapse time');
    R(cast, c, 'cooldown', 0, 6, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const anchor = folder.addFolder('Where it leaves the hands');
    R(anchor, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(anchor, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(anchor, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(anchor, c, 'endHeight', 0, 4, 0.01, 'height at target');

    const column = folder.addFolder('The column');
    R(column, c, 'radiusNear', 0.01, 3, 0.01, 'radius at hands');
    R(column, c, 'radius', 0.02, 5, 0.01, 'radius at target');
    R(column, c, 'radiusCurve', 0.1, 4, 0.01, 'radius curve');
    R(column, c, 'flare', 0, 4, 0.01, 'flare at target');
    R(column, c, 'flareWidth', 0.02, 1, 0.01, 'flare width');
    R(column, c, 'throb', 0, 0.6, 0.005, 'pressure waves');
    R(column, c, 'throbScale', 0, 12, 0.1, 'waves / length');
    R(column, c, 'throbSpeed', 0, 10, 0.05, 'wave speed');
    R(column, c, 'wander', 0, 1, 0.005, 'axis drift');
    R(column, c, 'wanderScale', 0.1, 6, 0.05, 'drift scale');
    R(column, c, 'wanderSpeed', 0, 5, 0.01, 'drift speed');

    // The three tube passes. `coreSharp` and `shellRim` are the pair that decide
    // whether the beam reads as a solid rod or as a lit pipe — see
    // `materials/BeamMaterial.js`.
    const layers = folder.addFolder('Core, sheath & halo');
    R(layers, c, 'coreWidth', 0.05, 1.5, 0.01, 'core width');
    R(layers, c, 'coreSharp', 0.1, 8, 0.05, 'core focus');
    R(layers, c, 'coreFill', 0, 3, 0.01, 'core fill');
    R(layers, c, 'shellWidth', 0.2, 3, 0.01, 'sheath width');
    R(layers, c, 'shellRim', 0, 3, 0.01, 'sheath rim');
    R(layers, c, 'shellFill', 0, 1.5, 0.01, 'sheath fill');
    R(layers, c, 'shellOpacity', 0, 2, 0.01, 'sheath opacity');
    R(layers, c, 'edgePower', 0.2, 8, 0.05, 'rim falloff');
    R(layers, c, 'haloWidth', 0.5, 8, 0.05, 'halo width');
    R(layers, c, 'haloRim', 0.5, 10, 0.05, 'halo falloff');
    R(layers, c, 'haloOpacity', 0, 2, 0.01, 'halo opacity');

    const surface = folder.addFolder('Surface & flow');
    R(surface, c, 'ripple', 0, 1, 0.005, 'surface ripple');
    R(surface, c, 'rippleBands', 0.1, 8, 0.05, 'ripples around');
    R(surface, c, 'rippleScale', 0.1, 12, 0.05, 'ripples along');
    R(surface, c, 'rippleSpeed', 0, 12, 0.05, 'ripple crawl');
    R(surface, c, 'streak', 0, 3, 0.01, 'filaments');
    R(surface, c, 'streakSharp', 0, 1, 0.01, 'filament sharpness');
    R(surface, c, 'streakScale', 0.2, 20, 0.1, 'filaments / length');
    R(surface, c, 'streakBands', 0.2, 10, 0.05, 'filaments around');
    R(surface, c, 'streakGlow', 0, 4, 0.01, 'filament heat');
    R(surface, c, 'flowSpeed', 0, 30, 0.1, 'flow speed');
    R(surface, c, 'mouthGlow', 0, 6, 0.05, 'muzzle heat');
    R(surface, c, 'mouthLength', 0.005, 0.5, 0.005, 'muzzle length');
    R(surface, c, 'tipGlow', 0, 6, 0.05, 'burning-end heat');
    R(surface, c, 'tipLength', 0.005, 0.5, 0.005, 'burning-end length');
    R(surface, c, 'softFade', 0.02, 3, 0.01, 'soft intersection');

    const material = folder.addFolder('Beam colour');
    material.addColor(c, 'colorCore').name('axis');
    material.addColor(c, 'colorInner').name('inner');
    material.addColor(c, 'colorOuter').name('sheath');
    material.addColor(c, 'colorHalo').name('halo');
    R(material, c, 'glow', 0, 8, 0.01, 'glow');
    R(material, c, 'opacity', 0, 2, 0.01, 'opacity');

    const coils = folder.addFolder('The coils');
    R(coils, c, 'coils', 0, 8, 1, 'ribbons');
    R(coils, c, 'coilTurns', -8, 8, 0.05, 'turns over length');
    R(coils, c, 'coilSpeed', -6, 6, 0.01, 'roll speed');
    R(coils, c, 'coilRadius', 0.2, 4, 0.01, 'ride radius');
    R(coils, c, 'coilFlare', 0, 4, 0.01, 'flare at target');
    R(coils, c, 'coilWidth', 0.005, 0.6, 0.005, 'width at hands');
    R(coils, c, 'coilWidthTip', 0.05, 6, 0.01, 'width at target');
    R(coils, c, 'coilSharp', 0.2, 8, 0.05, 'edge falloff');
    R(coils, c, 'coilPulse', 0, 1, 0.01, 'charge pulse');
    R(coils, c, 'coilPulseFreq', 0, 12, 0.05, 'pulses / length');
    R(coils, c, 'coilPulseSpeed', -8, 8, 0.05, 'pulse speed');
    // Headroom above the shipped values on purpose — they sit high, and a
    // control that starts pinned to its own maximum can only ever come down.
    R(coils, c, 'coilGlow', 0, 14, 0.01, 'glow');
    R(coils, c, 'coilOpacity', 0, 3, 0.01, 'opacity');
    coils.addColor(c, 'colorCoil').name('ribbon core');
    coils.addColor(c, 'colorCoilEdge').name('ribbon edge');

    const rings = folder.addFolder('Shock discs');
    R(rings, c, 'rings', 0, 12, 1, 'discs');
    R(rings, c, 'ringSpeed', 0, 6, 0.01, 'trips / second');
    R(rings, c, 'ringInner', 0.2, 4, 0.01, 'inner lip');
    R(rings, c, 'ringOuter', 0.3, 6, 0.01, 'outer lip');
    R(rings, c, 'ringSwell', 0, 3, 0.01, 'swell downrange');
    R(rings, c, 'ringFade', 0, 1, 0.01, 'fade downrange');
    R(rings, c, 'ringSharp', 0.2, 8, 0.05, 'band sharpness');
    R(rings, c, 'ringGlow', 0, 8, 0.01, 'glow');
    R(rings, c, 'ringOpacity', 0, 2, 0.01, 'opacity');
    rings.addColor(c, 'colorRing').name('disc colour');

    const orb = folder.addFolder('The charge');
    R(orb, c, 'orbSize', 0.02, 2, 0.01, 'orb radius');
    R(orb, c, 'orbThrob', 0, 0.6, 0.005, 'orb pulse');
    R(orb, c, 'orbThrobSpeed', 0, 20, 0.1, 'pulse rate');
    R(orb, c, 'orbTurbulence', 0, 1, 0.01, 'surface turbulence');
    R(orb, c, 'orbScale', 0.2, 8, 0.05, 'surface scale');
    R(orb, c, 'orbFlow', 0, 5, 0.01, 'surface crawl');
    R(orb, c, 'orbBands', 0.5, 15, 0.1, 'filament scale');
    R(orb, c, 'orbRim', 0.2, 6, 0.05, 'rim falloff');
    R(orb, c, 'orbGlow', 0, 8, 0.01, 'glow');
    R(orb, c, 'orbOpacity', 0, 2, 0.01, 'opacity');
    R(orb, c, 'intakeRate', 0, 900, 1, 'intake rate');
    R(orb, c, 'intakeRadius', 0.2, 8, 0.05, 'intake radius');
    R(orb, c, 'intakeSpeed', 0.5, 25, 0.1, 'intake speed');
    R(orb, c, 'chargeShake', 0, 0.5, 0.005, 'wind-up rumble');

    const ground = folder.addFolder('What the floor does');
    R(ground, c, 'scorchRate', 0.05, 8, 0.05, 'burns / metre');
    R(ground, c, 'scorchRadius', 0.05, 4, 0.05, 'burn radius');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, 'burn lifetime');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, 'burn intensity');
    R(ground, c, 'dustRate', 0, 20, 0.1, 'dust rings / sec');
    R(ground, c, 'dustRadius', 0.2, 10, 0.05, 'dust ring radius');
    R(ground, c, 'dustLife', 0.1, 5, 0.05, 'dust ring lifetime');
    R(ground, c, 'shockRate', 0, 20, 0.1, 'shock rings / sec');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, 'shockwave radius');
    ground.addColor(c, 'colorScorch').name('scorch');
    ground.addColor(c, 'colorEmber').name('ember');
    ground.addColor(c, 'colorDustA').name('dust');
    ground.addColor(c, 'colorDustB').name('dust crest');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');

    const sparks = folder.addFolder('Sparks & motes');
    R(sparks, c, 'sparkRate', 0, 1200, 1, 'spark rate');
    R(sparks, c, 'sparkSize', 0.005, 0.8, 0.005, 'spark size');
    R(sparks, c, 'sparkSpeed', 0, 40, 0.1, 'spark speed');
    R(sparks, c, 'sparkLifetime', 0.05, 4, 0.01, 'spark lifetime');
    R(sparks, c, 'sparkGravity', -50, 5, 0.1, 'spark gravity');
    R(sparks, c, 'sparkStretch', 0, 3, 0.01, 'spark stretch');
    R(sparks, c, 'sparkForward', 0, 4, 0.01, 'downrange drag');
    R(sparks, c, 'moteRate', 0, 600, 1, 'mote rate');
    R(sparks, c, 'moteSize', 0.005, 0.4, 0.005, 'mote size');
    R(sparks, c, 'moteSpeed', 0, 12, 0.05, 'mote speed');
    R(sparks, c, 'moteLifetime', 0.1, 8, 0.05, 'mote lifetime');
    R(sparks, c, 'moteRise', -3, 8, 0.05, 'mote rise');
    R(sparks, c, 'moteTurbulence', 0, 3, 0.01, 'mote turbulence');
    Editor.gradient(sparks, c, 'colorSpark', 'Spark colour');
    Editor.gradient(sparks, c, 'colorMote', 'Mote colour');

    const dust = folder.addFolder('Steam & debris');
    R(dust, c, 'smokeRate', 0, 500, 1, 'steam rate');
    R(dust, c, 'smokeSize', 0.05, 4, 0.01, 'steam size');
    R(dust, c, 'smokeSpeed', 0, 8, 0.05, 'steam speed');
    R(dust, c, 'smokeLifetime', 0.2, 8, 0.05, 'steam lifetime');
    R(dust, c, 'smokeOpacity', 0, 1, 0.005, 'steam opacity');
    R(dust, c, 'smokeRise', -2, 4, 0.01, 'steam rise');
    R(dust, c, 'debrisRate', 0, 300, 1, 'debris rate');
    R(dust, c, 'debrisSize', 0.005, 0.4, 0.005, 'debris size');
    R(dust, c, 'debrisSpeed', 0, 25, 0.1, 'debris speed');
    R(dust, c, 'debrisLifetime', 0.1, 5, 0.05, 'debris lifetime');
    R(dust, c, 'debrisGravity', -50, 0, 0.1, 'debris gravity');
    Editor.gradient(dust, c, 'colorSmoke', 'Steam colour');
    Editor.gradient(dust, c, 'colorDebris', 'Debris colour');

    const impact = folder.addFolder('Release, impact & burn');
    R(impact, c, 'muzzleSize', 0.05, 8, 0.05, 'release shell');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'release intensity');
    R(impact, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    impact.addColor(c, 'colorCastFlash').name('release flash colour');
    R(impact, c, 'burstSize', 0.2, 18, 0.05, 'impact shell');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, 'impact intensity');
    R(impact, c, 'burstSparks', 0, 800, 1, 'impact sparks');
    R(impact, c, 'burstDebris', 0, 400, 1, 'impact debris');
    R(impact, c, 'pulseRate', 0, 12, 0.1, 'burn shells / sec');
    R(impact, c, 'pulseSize', 0.1, 10, 0.05, 'burn shell size');
    R(impact, c, 'pulseIntensity', 0, 5, 0.01, 'burn shell intensity');
    R(impact, c, 'splashRate', 0, 900, 1, 'back-splash rate');
    R(impact, c, 'impactShake', 0, 3, 0.01, 'shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'impactFlash', 0, 2, 0.01, 'screen flash');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    R(impact, c, 'burnShake', 0, 0.5, 0.005, 'burn rumble');
    impact.addColor(c, 'colorBurstA').name('impact shell');
    impact.addColor(c, 'colorBurstB').name('impact body');
    impact.addColor(c, 'colorBurstC').name('impact arcs');
    impact.addColor(c, 'colorFlash').name('impact flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'beam intensity');
    R(light, c, 'lightRadius', 0.5, 60, 0.1, 'beam radius');
    R(light, c, 'lightPulse', 0, 1, 0.01, 'hum depth');
    R(light, c, 'lightPulseSpeed', 0, 30, 0.1, 'hum rate');
    R(light, c, 'muzzleLightIntensity', 0, 120, 0.5, 'hand intensity');
    R(light, c, 'muzzleLightRadius', 0.5, 40, 0.1, 'hand radius');
    light.addColor(c, 'lightColor').name('light colour');

    this.beamFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Voltaic Snare — the first far cast.
   *
   * `zoneRadius` is the control that matters most here and the only one that
   * reaches outside the ability: it is read by the circle indicator *and* by
   * the tendrils, the rim arcs and the burnt field, so dragging it re-scales
   * what you aim with and what you get at the same time. After that,
   * `snapTime` and `height` carry the moment the trap opens, and `tendrils` /
   * `rimArcs` / `strands` decide how much of the footprint is actually lit.
   */
  _buildSnare() {
    const folder = this.gui.addFolder('◈  Voltaic Snare');
    const c = settings.snare;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 300, 1, 'leash speed');
    R(cast, c, 'snapTime', 0.02, 1.5, 0.01, 'snap-open time');
    R(cast, c, 'lifetime', 0.1, 12, 0.05, 'hold time');
    R(cast, c, 'fadeTime', 0.05, 4, 0.01, 'collapse time');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const leash = folder.addFolder('The leash');
    R(leash, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(leash, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(leash, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(leash, c, 'leashStrands', 0, 6, 1, 'filaments');
    R(leash, c, 'leashSag', -3, 3, 0.01, 'mid-span bow');
    R(leash, c, 'leashSpread', 0, 2, 0.01, 'fan');
    R(leash, c, 'leashCling', 0, 1.5, 0.01, 'height at the tip');
    R(leash, c, 'leashKink', 0, 2, 0.01, 'kink amplitude');
    R(leash, c, 'leashWidth', 0.1, 4, 0.01, 'ribbon width');

    const column = folder.addFolder('The column');
    R(column, c, 'strands', 0, 16, 1, 'filaments');
    R(column, c, 'height', 0.5, 24, 0.1, 'height');
    R(column, c, 'heightCurve', 0.1, 4, 0.01, 'climb curve');
    R(column, c, 'throat', 0.005, 1, 0.005, 'throat, × footprint');
    R(column, c, 'columnSpread', 0.01, 1, 0.005, 'top, × footprint');
    R(column, c, 'columnCurve', 0.1, 5, 0.01, 'opening curve');
    R(column, c, 'columnFlare', 0, 1, 0.005, 'top flare');
    R(column, c, 'columnTwist', -4, 4, 0.01, 'twist over height');
    R(column, c, 'columnSpin', -4, 4, 0.01, 'spin');
    R(column, c, 'columnKink', 0, 2, 0.01, 'kink amplitude');
    R(column, c, 'columnWidth', 0.1, 6, 0.01, 'ribbon width');
    R(column, c, 'columnTaper', 0.05, 2, 0.01, 'taper to the top');

    const tendrils = folder.addFolder('The tendrils');
    R(tendrils, c, 'tendrils', 0, 20, 1, 'tendrils');
    R(tendrils, c, 'tendrilInner', 0, 1, 0.005, 'start, × footprint');
    R(tendrils, c, 'tendrilReach', 0.05, 1.6, 0.01, 'end, × footprint');
    R(tendrils, c, 'tendrilCurve', 0.1, 4, 0.01, 'reach curve');
    R(tendrils, c, 'tendrilWander', 0, 4, 0.01, 'veer');
    R(tendrils, c, 'tendrilArch', 0, 3, 0.01, 'hop off the floor');
    R(tendrils, c, 'tendrilHug', 0.005, 1, 0.005, 'floor clearance');
    R(tendrils, c, 'tendrilSpin', -2, 2, 0.005, 'fan rotation');
    R(tendrils, c, 'tendrilKink', 0, 2, 0.01, 'kink amplitude');
    R(tendrils, c, 'tendrilWidth', 0.05, 4, 0.01, 'ribbon width');
    R(tendrils, c, 'tendrilDim', 0, 1, 0.01, 'dim vs the column');

    const rim = folder.addFolder('The rim arcs');
    R(rim, c, 'rimArcs', 0, 14, 1, 'arcs');
    R(rim, c, 'rimSpan', 0.01, 1, 0.005, 'arc span, × the circle');
    R(rim, c, 'rimSpeed', -3, 3, 0.01, 'travel speed');
    R(rim, c, 'rimHeight', 0, 3, 0.01, 'hop height');
    R(rim, c, 'rimJitter', 0, 1, 0.01, 'radial wobble');
    R(rim, c, 'rimKink', 0, 2, 0.01, 'kink amplitude');
    R(rim, c, 'rimWidth', 0.05, 4, 0.01, 'ribbon width');
    R(rim, c, 'rimDim', 0, 1, 0.01, 'dim vs the column');

    const shape = folder.addFolder('Filaments & flicker');
    R(shape, c, 'jitter', 0, 4, 0.01, 'kink master');
    R(shape, c, 'jitterScale', 0.05, 8, 0.01, 'kinks / metre');
    R(shape, c, 'octaves', 1, 5, 1, 'octaves');
    R(shape, c, 'jitterFalloff', 0.1, 0.95, 0.01, 'octave falloff');
    R(shape, c, 'crawl', -20, 20, 0.1, 'kink crawl');
    R(shape, c, 'pinch', 0.01, 0.5, 0.005, 'end pinch');
    R(shape, c, 'restrike', 0.5, 90, 0.5, 'restrikes / sec');
    R(shape, c, 'flicker', 0, 1, 0.01, 'brightness stutter');
    R(shape, c, 'flickerSpeed', 1, 120, 1, 'stutter rate');
    R(shape, c, 'strandFlash', 0, 1, 0.01, 'filament blink');

    const ribbon = folder.addFolder('The ribbon & colour');
    R(ribbon, c, 'width', 0.005, 0.4, 0.001, 'filament width');
    R(ribbon, c, 'coreSharp', 0.5, 12, 0.05, 'core sharpness');
    R(ribbon, c, 'glowWidth', 1, 30, 0.1, 'halo width');
    R(ribbon, c, 'glowFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(ribbon, c, 'glowOpacity', 0, 2, 0.01, 'halo opacity');
    R(ribbon, c, 'softFade', 0.02, 3, 0.01, 'soft intersection');
    R(ribbon, c, 'glow', 0, 8, 0.01, 'glow');
    R(ribbon, c, 'opacity', 0, 2, 0.01, 'opacity');
    ribbon.addColor(c, 'colorCore').name('core');
    ribbon.addColor(c, 'colorInner').name('inner');
    ribbon.addColor(c, 'colorOuter').name('outer');
    ribbon.addColor(c, 'colorHalo').name('halo');

    const field = folder.addFolder('The field on the floor');
    R(field, c, 'fieldBoundary', 0.02, 2, 0.01, 'band thickness');
    R(field, c, 'fieldBoundaryGlow', 0, 8, 0.05, 'band glow');
    R(field, c, 'fieldFill', 0, 2, 0.01, 'interior fill');
    R(field, c, 'fieldFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(field, c, 'fieldVeins', 0, 3, 0.01, 'burnt veins');
    R(field, c, 'fieldVeinScale', 0.1, 8, 0.05, 'veins / metre');
    R(field, c, 'fieldVeinSharp', 0, 1, 0.01, 'vein sharpness');
    R(field, c, 'fieldWarp', 0, 2, 0.01, 'domain warp');
    R(field, c, 'fieldCrawl', -4, 4, 0.01, 'vein crawl');
    R(field, c, 'fieldRings', 0, 12, 0.1, 'pressure rings');
    R(field, c, 'fieldRingSpeed', -6, 6, 0.01, 'ring speed');
    R(field, c, 'fieldSpokes', 0, 96, 1, 'boundary ticks');
    R(field, c, 'fieldSpokeLength', 0.05, 3, 0.01, 'tick length');
    R(field, c, 'fieldSpin', -2, 2, 0.005, 'tick spin');
    R(field, c, 'fieldCore', 0, 4, 0.01, 'centre pool');
    R(field, c, 'fieldCoreSize', 0.02, 1, 0.005, 'pool size, × footprint');
    R(field, c, 'fieldPulse', 0, 1, 0.01, 'pulse');
    R(field, c, 'fieldPulseSpeed', 0, 10, 0.05, 'pulse speed');
    R(field, c, 'fieldOpacity', 0, 2, 0.01, 'opacity');
    R(field, c, 'fieldHeight', 0.005, 0.4, 0.005, 'hover height');
    field.addColor(c, 'colorField').name('field');
    field.addColor(c, 'colorFieldEdge').name('band & pool');

    const ground = folder.addFolder('Burns on the ground');
    R(ground, c, 'arcRate', 0, 30, 0.1, 'rim burns / sec');
    R(ground, c, 'arcRadius', 0.1, 8, 0.05, 'burn radius');
    R(ground, c, 'arcLife', 0.05, 5, 0.05, 'burn lifetime');
    R(ground, c, 'arcIntensity', 0, 3, 0.01, 'burn intensity');
    R(ground, c, 'arcBranches', 0, 3, 0.01, 'branch detail');
    R(ground, c, 'trailRate', 0.05, 8, 0.05, 'leash burns / metre');
    R(ground, c, 'scorchRadius', 0.05, 8, 0.05, 'scorch radius');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, 'scorch lifetime');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, 'scorch intensity');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, 'shockwave radius');
    R(ground, c, 'ringRate', 0, 12, 0.1, 'dust rings / sec');
    ground.addColor(c, 'colorArc').name('burn');
    ground.addColor(c, 'colorEmber').name('ember');
    ground.addColor(c, 'colorScorch').name('scorch');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');

    const sparks = folder.addFolder('Sparks & updraft');
    R(sparks, c, 'sparkRate', 0, 1200, 1, 'spark rate');
    R(sparks, c, 'sparkSize', 0.005, 0.8, 0.005, 'spark size');
    R(sparks, c, 'sparkSpeed', 0, 40, 0.1, 'spark speed');
    R(sparks, c, 'sparkLifetime', 0.05, 4, 0.01, 'spark lifetime');
    R(sparks, c, 'sparkGravity', -50, 5, 0.1, 'spark gravity');
    R(sparks, c, 'sparkStretch', 0, 3, 0.01, 'spark stretch');
    R(sparks, c, 'updraftRate', 0, 900, 1, 'updraft rate');
    R(sparks, c, 'updraftSize', 0.005, 0.4, 0.005, 'updraft size');
    R(sparks, c, 'updraftSpeed', 0, 25, 0.1, 'pull-in speed');
    R(sparks, c, 'updraftLifetime', 0.1, 8, 0.05, 'updraft lifetime');
    R(sparks, c, 'updraftRise', -5, 25, 0.1, 'lift');
    R(sparks, c, 'updraftInset', 0, 0.95, 0.01, 'pick-up inset');
    R(sparks, c, 'updraftTurbulence', 0, 3, 0.01, 'updraft swirl');
    Editor.gradient(sparks, c, 'colorSpark', 'Spark colour');
    Editor.gradient(sparks, c, 'colorUpdraft', 'Updraft colour');

    const dust = folder.addFolder('Smoke & debris');
    R(dust, c, 'smokeRate', 0, 500, 1, 'smoke rate');
    R(dust, c, 'smokeSize', 0.05, 4, 0.01, 'smoke size');
    R(dust, c, 'smokeSpeed', 0, 8, 0.05, 'smoke speed');
    R(dust, c, 'smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime');
    R(dust, c, 'smokeOpacity', 0, 1, 0.005, 'smoke opacity');
    R(dust, c, 'smokeRise', -2, 4, 0.01, 'smoke rise');
    R(dust, c, 'debrisRate', 0, 300, 1, 'debris rate');
    R(dust, c, 'debrisSize', 0.005, 0.4, 0.005, 'debris size');
    R(dust, c, 'debrisSpeed', 0, 25, 0.1, 'debris speed');
    R(dust, c, 'debrisLifetime', 0.1, 5, 0.05, 'debris lifetime');
    R(dust, c, 'debrisGravity', -50, 0, 0.1, 'debris gravity');
    Editor.gradient(dust, c, 'colorSmoke', 'Smoke colour');
    Editor.gradient(dust, c, 'colorDebris', 'Debris colour');

    const impact = folder.addFolder('Throw, snap & hold');
    R(impact, c, 'muzzleSize', 0.05, 6, 0.05, 'muzzle size');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'muzzle intensity');
    R(impact, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, 'snap shell size');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, 'snap shell intensity');
    R(impact, c, 'burstSparks', 0, 600, 1, 'snap sparks');
    R(impact, c, 'burstDebris', 0, 300, 1, 'snap debris');
    R(impact, c, 'pulseRate', 0, 12, 0.1, 'hold shells / sec');
    R(impact, c, 'pulseSize', 0.1, 10, 0.05, 'hold shell size');
    R(impact, c, 'pulseIntensity', 0, 5, 0.01, 'hold shell intensity');
    R(impact, c, 'impactShake', 0, 3, 0.01, 'shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, 'hold rumble');
    R(impact, c, 'impactFlash', 0, 2, 0.01, 'screen flash');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    impact.addColor(c, 'colorCastFlash').name('release flash colour');
    impact.addColor(c, 'colorBurstA').name('shell');
    impact.addColor(c, 'colorBurstB').name('shell body');
    impact.addColor(c, 'colorBurstC').name('shell arcs');
    impact.addColor(c, 'colorFlash').name('snap flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 1, 0.01, 'height up the column');
    R(light, c, 'lightFlicker', 0, 1, 0.01, 'light gutter');
    R(light, c, 'lightFlickerSpeed', 1, 90, 1, 'gutter rate');
    light.addColor(c, 'lightColor').name('light colour');

    this.snareFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Glacial Crown — the far cast that comes out of the floor.
   *
   * `zoneRadius` is again the control that reaches outside the ability: it is
   * read by the circle indicator *and* by the ring of blades, the sheet and the
   * curtain, so dragging it re-scales what you aim with and what you get
   * together. After that the two groups that carry the cast are **The bloom**,
   * where `sweepTime` decides how the ring closes, and **Freeze front &
   * shatter**, which is how the ice arrives and how it leaves.
   */
  _buildGlacier() {
    const folder = this.gui.addFolder('❆  Glacial Crown');
    const c = settings.glacier;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 200, 1, 'front speed');
    R(cast, c, 'snapTime', 0.02, 1.5, 0.01, 'freeze-out time');
    R(cast, c, 'lifetime', 0.2, 14, 0.05, 'hold time');
    R(cast, c, 'shatterDelay', 0, 4, 0.01, 'delay before it breaks');
    R(cast, c, 'shatterStagger', 0, 3, 0.01, 'break stagger');
    R(cast, c, 'sinkTime', 0.05, 5, 0.01, 'crumble time');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const hand = folder.addFolder('Where the front leaves the hand');
    R(hand, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(hand, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(hand, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(hand, c, 'muzzleSize', 0.05, 6, 0.05, 'muzzle size');
    R(hand, c, 'muzzleIntensity', 0, 5, 0.01, 'muzzle intensity');
    R(hand, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    hand.addColor(c, 'colorCastFlash').name('release flash colour');

    const fill = folder.addFolder('Filling the footprint');
    R(fill, c, 'spikeCount', 1, 320, 1, 'shards');
    R(fill, c, 'density', 0.1, 2, 0.01, 'density');
    R(fill, c, 'ringShare', 0, 1, 0.01, 'share on the wall');
    R(fill, c, 'coreShare', 0, 0.5, 0.01, 'share on the spire');
    R(fill, c, 'lateShare', 0, 0.5, 0.01, 'share held back');
    R(fill, c, 'ringSeat', 0.2, 1.4, 0.01, 'wall seat, × footprint');
    R(fill, c, 'ringScatter', 0, 0.6, 0.005, 'wall jitter, × footprint');
    R(fill, c, 'skirtSeat', 0, 1.4, 0.01, 'skirt inner lip, × footprint');
    R(fill, c, 'skirtBand', 0.02, 1.4, 0.01, 'skirt width, × footprint');
    R(fill, c, 'skirtBias', 0.2, 3, 0.01, 'skirt crowding');
    R(fill, c, 'coreSpread', 0.01, 0.6, 0.005, 'spire cluster, × footprint');

    const shape = folder.addFolder('Silhouette');
    R(shape, c, 'ringHeight', 0.2, 12, 0.05, 'wall height');
    R(shape, c, 'ringWave', 0, 1, 0.01, 'crest unevenness');
    R(shape, c, 'skirtHeight', 0.05, 6, 0.05, 'skirt height');
    R(shape, c, 'coreHeight', 0.2, 12, 0.05, 'spire height');
    R(shape, c, 'heightJitter', 0, 1.5, 0.01, 'height jitter');
    R(shape, c, 'ringLean', -1.5, 1.5, 0.01, 'wall lean (0 = a fence)');
    R(shape, c, 'skirtLean', -1.5, 1.5, 0.01, 'skirt lean');
    R(shape, c, 'coreLean', -1.5, 1.5, 0.01, 'spire lean');
    R(shape, c, 'leanJitter', 0, 3, 0.01, 'lean jitter');
    R(shape, c, 'fan', 0, 1.6, 0.01, 'splay off the radius');
    R(shape, c, 'twist', 0, 1, 0.01, 'random yaw');
    R(shape, c, 'rubble', 0, 1, 0.01, 'rubble fraction');
    R(shape, c, 'rubbleScale', 0.05, 1, 0.01, 'rubble height');

    const crystal = folder.addFolder('The crystal');
    R(crystal, c, 'radius', 0.05, 1.2, 0.005, 'base radius');
    R(crystal, c, 'radiusJitter', 0, 1.5, 0.01, 'radius jitter');
    R(crystal, c, 'taper', 0.01, 0.9, 0.01, 'tip taper');
    R(crystal, c, 'facets', 3, 12, 1, 'facets');
    R(crystal, c, 'roughness', 0, 1, 0.01, 'facet roughness');
    R(crystal, c, 'bend', 0, 1.5, 0.01, 'bend');

    const bloom = folder.addFolder('The bloom');
    R(bloom, c, 'sweepTime', 0, 3, 0.01, 'sweep around the ring');
    R(bloom, c, 'skirtDelay', 0, 2, 0.01, 'skirt delay');
    R(bloom, c, 'skirtWave', 0, 2, 0.01, 'skirt wave');
    R(bloom, c, 'coreDelay', 0, 2, 0.01, 'spire delay');
    R(bloom, c, 'stagger', 0, 1, 0.005, 'random stagger');
    R(bloom, c, 'bloomSpread', 0, 1, 0.01, 'late shards spread');
    R(bloom, c, 'riseTime', 0.02, 1.5, 0.01, 'rise time');
    R(bloom, c, 'riseOvershoot', 0, 1.5, 0.01, 'punch overshoot');
    R(bloom, c, 'settle', 0.05, 2, 0.01, 'settle');

    const material = folder.addFolder('Prismatic glass');
    R(material, c, 'opacity', 0, 1, 0.01, 'opacity');
    R(material, c, 'body', 0, 2, 0.01, 'body (0 = pure edges)');
    R(material, c, 'edgePower', 0.5, 8, 0.01, 'edge tightness');
    R(material, c, 'edgeGain', 0, 6, 0.01, 'edge gain');
    R(material, c, 'dispersion', 0, 1, 0.01, 'chromatic split');
    R(material, c, 'pipe', 0, 5, 0.01, 'piped light');
    R(material, c, 'tipBias', 0.2, 6, 0.01, 'crowding to the point');
    R(material, c, 'bands', 0, 8, 0.05, 'travelling bands');
    R(material, c, 'pulseSpeed', -4, 4, 0.01, 'band speed');
    R(material, c, 'tipStart', 0, 1, 0.01, 'tip start');
    R(material, c, 'tipGlow', 0, 6, 0.01, 'tip glow');
    R(material, c, 'stria', 0, 3, 0.01, 'flow lines');
    R(material, c, 'striaScale', 0.5, 24, 0.1, 'flow line scale');
    R(material, c, 'envIntensity', 0, 3, 0.01, 'env reflection');
    R(material, c, 'specular', 0, 8, 0.05, 'sun glint');
    R(material, c, 'glow', 0, 4, 0.01, 'glow');
    R(material, c, 'birthGlow', 0, 6, 0.01, 'birth flash');
    R(material, c, 'birthFade', 0.02, 3, 0.01, 'birth fade');
    material.addColor(c, 'colorGlass').name('body');
    material.addColor(c, 'colorEdge').name('edge & glint');
    material.addColor(c, 'colorPrismA').name('dispersion A');
    material.addColor(c, 'colorPrismB').name('dispersion B');
    material.addColor(c, 'colorCore').name('piped light');
    material.addColor(c, 'colorTip').name('tip');

    const growth = folder.addFolder('Freeze front & shatter');
    R(growth, c, 'frontRough', 0, 1.5, 0.01, 'front raggedness');
    R(growth, c, 'frontWidth', 0.01, 0.8, 0.01, 'front width');
    R(growth, c, 'frontGlow', 0, 8, 0.05, 'front glow');
    R(growth, c, 'shatterScale', 1, 24, 0.1, 'break-up cells');
    R(growth, c, 'shatterEdge', 0.005, 0.4, 0.005, 'break edge width');
    R(growth, c, 'shatterGlow', 0, 8, 0.05, 'break glow');

    const field = folder.addFolder('The sheet on the floor');
    R(field, c, 'fieldBoundary', 0.02, 2, 0.01, 'band thickness');
    R(field, c, 'fieldBoundaryGlow', 0, 8, 0.05, 'band glow');
    R(field, c, 'fieldFill', 0, 2, 0.01, 'interior fill');
    R(field, c, 'fieldFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(field, c, 'fieldPlates', 0, 3, 0.01, 'plate break-up');
    R(field, c, 'fieldPlateScale', 0.2, 10, 0.05, 'plates / metre');
    R(field, c, 'fieldSeam', 0, 3, 0.01, 'seam rime');
    R(field, c, 'fieldFingers', 0, 3, 0.01, 'frost fingers');
    R(field, c, 'fieldFingerScale', 0.1, 8, 0.05, 'fingers / metre');
    R(field, c, 'fieldWarp', 0, 2, 0.01, 'domain warp');
    R(field, c, 'fieldCrawl', -4, 4, 0.01, 'finger crawl');
    R(field, c, 'fieldRings', 0, 12, 0.1, 'pressure rings');
    R(field, c, 'fieldRingSpeed', -6, 6, 0.01, 'ring speed');
    R(field, c, 'fieldSweep', 0, 3, 0.01, 'cold sweep');
    R(field, c, 'fieldSweepSpeed', -2, 2, 0.01, 'sweep speed');
    R(field, c, 'fieldCore', 0, 4, 0.01, 'centre pool');
    R(field, c, 'fieldCoreSize', 0.02, 1, 0.005, 'pool size, × footprint');
    R(field, c, 'fieldPulse', 0, 1, 0.01, 'pulse');
    R(field, c, 'fieldPulseSpeed', 0, 10, 0.05, 'pulse speed');
    R(field, c, 'fieldOpacity', 0, 2, 0.01, 'opacity');
    R(field, c, 'fieldHeight', 0.005, 0.4, 0.005, 'hover height');
    field.addColor(c, 'colorField').name('sheet');
    field.addColor(c, 'colorFieldEdge').name('band & seams');

    const veil = folder.addFolder('The curtain of cold');
    R(veil, c, 'veil', 0, 2, 0.01, 'opacity (0 hides it)');
    R(veil, c, 'veilHeight', 0.1, 8, 0.05, 'height');
    R(veil, c, 'veilRadius', 0.5, 1.6, 0.005, 'seat, × footprint');
    R(veil, c, 'veilFlare', -0.5, 1.5, 0.01, 'outward lean');
    R(veil, c, 'veilBillow', 0, 1.5, 0.01, 'silhouette lobes');
    R(veil, c, 'veilScale', 0.1, 6, 0.05, 'noise / metre');
    R(veil, c, 'veilStretch', 0.05, 3, 0.01, 'vertical stretch');
    R(veil, c, 'veilFlow', -4, 4, 0.01, 'fall speed');
    R(veil, c, 'veilErode', 0, 1, 0.01, 'erosion with height');
    R(veil, c, 'veilFalloff', 0.2, 6, 0.05, 'thinning with height');
    R(veil, c, 'veilSpin', -1, 1, 0.005, 'rotation');
    R(veil, c, 'veilSoftFade', 0.02, 3, 0.01, 'soft intersection');
    veil.addColor(c, 'colorVeil').name('curtain');
    veil.addColor(c, 'colorVeilCrest').name('crest');

    const ground = folder.addFolder('Rime');
    R(ground, c, 'trailFrostRate', 0.05, 10, 0.05, 'trail rime / metre');
    R(ground, c, 'trailFrostRadius', 0.05, 6, 0.05, 'trail rime radius');
    R(ground, c, 'frostSpread', 0.2, 4, 0.05, 'impact rime, × footprint');
    R(ground, c, 'frostLife', 0.5, 20, 0.1, 'rime lifetime');
    R(ground, c, 'frostIntensity', 0, 2, 0.01, 'rime intensity');
    R(ground, c, 'frostCrystals', 0, 4, 0.01, 'snow grain');
    R(ground, c, 'frostCollar', 0, 8, 0.05, 'collar, × shard radius');
    R(ground, c, 'rimeRate', 0, 20, 0.1, 'rim rime / sec');
    R(ground, c, 'rimeRadius', 0.05, 6, 0.05, 'rim rime radius');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, 'shockwave radius');
    R(ground, c, 'ringRate', 0, 12, 0.1, 'pressure rings / sec');
    ground.addColor(c, 'colorFrost').name('snow');
    ground.addColor(c, 'colorFrostEdge').name('snow shadow');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');

    const air = folder.addFolder('Mist, glitter & snow');
    R(air, c, 'mistRate', 0, 900, 1, 'mist rate');
    R(air, c, 'mistSize', 0.05, 4, 0.01, 'mist size');
    R(air, c, 'mistSpeed', 0, 8, 0.05, 'mist speed');
    R(air, c, 'mistLifetime', 0.2, 8, 0.05, 'mist lifetime');
    R(air, c, 'mistOpacity', 0, 1, 0.005, 'mist opacity');
    R(air, c, 'mistRise', -3, 3, 0.01, 'mist rise (− falls)');
    R(air, c, 'mistTurbulence', 0, 3, 0.01, 'mist swirl');
    R(air, c, 'glitterRate', 0, 900, 1, 'glitter rate');
    R(air, c, 'glitterSize', 0.005, 0.4, 0.005, 'glitter size');
    R(air, c, 'glitterSpeed', 0, 20, 0.1, 'glitter speed');
    R(air, c, 'glitterLifetime', 0.1, 8, 0.05, 'glitter lifetime');
    R(air, c, 'glitterRise', -3, 8, 0.01, 'glitter lift');
    R(air, c, 'glitterTurbulence', 0, 3, 0.01, 'glitter swirl');
    R(air, c, 'glitterGlow', 0, 4, 0.01, 'glitter glow');
    R(air, c, 'snowRate', 0, 600, 1, 'snow rate');
    R(air, c, 'snowSize', 0.005, 0.4, 0.005, 'snow size');
    R(air, c, 'snowSpeed', 0, 10, 0.05, 'initial push');
    R(air, c, 'snowLifetime', 0.2, 10, 0.05, 'snow lifetime');
    R(air, c, 'snowFall', -12, 2, 0.05, 'snow gravity');
    R(air, c, 'snowTurbulence', 0, 3, 0.01, 'snow drift');
    R(air, c, 'snowGlow', 0, 4, 0.01, 'snow glow');
    R(air, c, 'snowInset', 0.05, 1.4, 0.01, 'fall inset, × footprint');
    R(air, c, 'snowHeight', 0.2, 4, 0.05, 'fall height, × wall');
    Editor.gradient(air, c, 'colorMist', 'Mist colour');
    Editor.gradient(air, c, 'colorGlitter', 'Glitter colour');
    Editor.gradient(air, c, 'colorSnow', 'Snow colour');

    const chips = folder.addFolder('Ice chips');
    R(chips, c, 'shardSize', 0.005, 0.5, 0.005, 'chip size');
    R(chips, c, 'shardSpeed', 0, 30, 0.1, 'chip speed');
    R(chips, c, 'shardLifetime', 0.1, 6, 0.05, 'chip lifetime');
    R(chips, c, 'shardGravity', -50, 0, 0.1, 'chip gravity');
    R(chips, c, 'breachShards', 0, 30, 1, 'chips on breach');
    R(chips, c, 'shatterShards', 0, 30, 1, 'chips on break-up');
    Editor.gradient(chips, c, 'colorShard', 'Chip colour');

    const impact = folder.addFolder('Bloom & hold');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, 'vapour shell size');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, 'vapour shell intensity');
    R(impact, c, 'burstShards', 0, 600, 1, 'bloom chips');
    R(impact, c, 'burstMist', 0, 400, 1, 'bloom mist');
    R(impact, c, 'burstGlitter', 0, 600, 1, 'bloom glitter');
    R(impact, c, 'vapourRate', 0, 12, 0.05, 'hold shells / sec');
    R(impact, c, 'vapourSize', 0.1, 10, 0.05, 'hold shell size');
    R(impact, c, 'vapourIntensity', 0, 5, 0.01, 'hold shell intensity');
    R(impact, c, 'impactShake', 0, 3, 0.01, 'shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, 'hold rumble');
    R(impact, c, 'impactFlash', 0, 2, 0.01, 'screen flash');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    impact.addColor(c, 'colorBurstA').name('shell');
    impact.addColor(c, 'colorBurstB').name('shell body');
    impact.addColor(c, 'colorBurstC').name('shell plates');
    impact.addColor(c, 'colorFlash').name('bloom flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 1, 0.01, 'height up the crown');
    light.addColor(c, 'lightColor').name('light colour');

    this.glacierFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The Volcanic Horror Ward.
   *
   * Grouped the way the reference sheet is: one folder per pass, in the order
   * you see them — the floor shatters, the obsidian comes up, the membrane
   * closes, the runes light, the flare fires. `The heartbeat` sits at the top
   * with the cast, because it is the one group that reaches into all of them:
   * drop `beatDepth` to zero and the ward flatlines, every pass at once.
   */
  _buildWard() {
    const folder = this.gui.addFolder('☣  Volcanic Ward');
    const c = settings.ward;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 300, 1, 'surge speed');
    R(cast, c, 'sealTime', 0.02, 2, 0.01, 'seal time');
    R(cast, c, 'lifetime', 0.2, 16, 0.05, 'hold time');
    R(cast, c, 'fadeTime', 0.05, 5, 0.01, 'collapse time');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const beat = folder.addFolder('The heartbeat');
    R(beat, c, 'bpm', 20, 200, 1, 'beats / minute');
    R(beat, c, 'beatDepth', 0, 2, 0.01, 'modulation depth');
    R(beat, c, 'beatEmbers', 0, 400, 1, 'embers / beat');
    R(beat, c, 'beatGore', 0, 80, 1, 'droplets / beat');
    R(beat, c, 'beatRing', 0, 2, 0.01, 'ring brightness');
    R(beat, c, 'beatFlare', 0, 2, 0.01, 'flare relight');
    R(beat, c, 'beatShake', 0, 0.6, 0.005, 'camera thump');

    const barrier = folder.addFolder('The barrier');
    R(barrier, c, 'height', 0.5, 16, 0.05, 'wall height');
    R(barrier, c, 'riseCurve', 0.2, 4, 0.01, 'rise curve');
    R(barrier, c, 'bulge', -0.5, 0.8, 0.005, 'waist bulge');
    R(barrier, c, 'flare', -0.3, 0.8, 0.005, 'rim flare');
    R(barrier, c, 'throb', 0, 0.4, 0.005, 'throb on a beat');
    R(barrier, c, 'density', 0, 1.5, 0.01, 'membrane opacity');
    R(barrier, c, 'innerDensity', 0, 2, 0.01, 'far wall opacity');
    R(barrier, c, 'innerGain', 0, 3, 0.01, 'far wall gain');
    R(barrier, c, 'fresnel', 0.2, 6, 0.05, 'rim falloff');
    R(barrier, c, 'fresnelGain', 0, 5, 0.01, 'rim gain');
    R(barrier, c, 'rimTop', 0, 0.5, 0.005, 'hoop at the rim');
    R(barrier, c, 'rimBase', 0, 0.5, 0.005, 'hoop at the floor');
    R(barrier, c, 'rimGlow', 0, 8, 0.05, 'hoop glow');
    R(barrier, c, 'swirl', -3, 3, 0.01, 'shear with height');
    R(barrier, c, 'spin', -2, 2, 0.005, 'wall spin');
    R(barrier, c, 'crest', 0, 6, 0.01, 'closing edge');
    R(barrier, c, 'dissolveEdge', 0.02, 1, 0.01, 'tear width');
    R(barrier, c, 'softFade', 0.02, 3, 0.01, 'soft intersection');
    R(barrier, c, 'barrierGlow', 0, 6, 0.01, 'glow');
    R(barrier, c, 'opacity', 0, 2, 0.01, 'opacity');

    const blood = folder.addFolder('Blood on the wall');
    R(blood, c, 'flowScale', 0.05, 6, 0.01, 'runs / metre');
    R(blood, c, 'flowStretch', 0.02, 2, 0.01, 'vertical stretch');
    R(blood, c, 'flowSpeed', -4, 4, 0.01, 'run speed');
    R(blood, c, 'flowSharp', 0, 1, 0.01, 'run sharpness');
    R(blood, c, 'flowGain', 0, 4, 0.01, 'run gain');
    R(blood, c, 'warp', 0, 2, 0.01, 'domain warp');
    R(blood, c, 'cells', 0, 2, 0.01, 'membrane cells');
    R(blood, c, 'cellScale', 0.1, 8, 0.05, 'cells / metre');
    R(blood, c, 'bands', 0, 12, 0.05, 'pressure rings');
    R(blood, c, 'bandSpeed', -4, 4, 0.01, 'ring speed');
    R(blood, c, 'bandWidth', 0.01, 1, 0.01, 'ring softness');
    blood.addColor(c, 'colorMembrane').name('membrane');
    blood.addColor(c, 'colorFlow').name('blood');
    blood.addColor(c, 'colorRim').name('hoops');
    blood.addColor(c, 'colorDeep').name('far wall');

    const runes = folder.addFolder('The rune bands');
    R(runes, c, 'runes', 1, 90, 1, 'glyphs');
    R(runes, c, 'runeSize', 0.05, 2, 0.01, 'band height');
    R(runes, c, 'runeInset', -0.3, 0.6, 0.005, 'stand-off');
    R(runes, c, 'runeWeight', 0.005, 0.25, 0.001, 'stroke weight');
    R(runes, c, 'runeStrokes', 0, 1, 0.01, 'strokes kept');
    R(runes, c, 'runeSpin', -1, 1, 0.005, 'ring spin');
    R(runes, c, 'runeSweep', 0, 3, 0.01, 'read head');
    R(runes, c, 'runeSweepSpeed', -2, 2, 0.005, 'head speed');
    R(runes, c, 'runeSweepWidth', 0.01, 0.5, 0.005, 'head width');
    R(runes, c, 'runeFlicker', 0, 1, 0.01, 'glyph stutter');
    R(runes, c, 'runeHalo', 0, 2, 0.01, 'halo');
    R(runes, c, 'runeGlow', 0, 8, 0.05, 'glow');
    R(runes, c, 'runeBase', 0, 2, 0.01, 'band at the floor');
    R(runes, c, 'runeTop', 0, 2, 0.01, 'band at the rim');
    runes.addColor(c, 'colorRune').name('rune');
    runes.addColor(c, 'colorRuneCore').name('rune core');

    const stones = folder.addFolder('The monoliths');
    R(stones, c, 'monoliths', 0, 24, 1, 'slabs');
    R(stones, c, 'monolithRing', 0, 1.2, 0.005, 'seat, × footprint');
    R(stones, c, 'monolithJitter', 0, 0.8, 0.005, 'radial scatter');
    R(stones, c, 'monolithSpread', 0, 2, 0.01, 'bearing scatter');
    R(stones, c, 'monolithHeight', 0.2, 8, 0.05, 'height');
    R(stones, c, 'monolithHeightJitter', 0, 1, 0.01, 'height variance');
    R(stones, c, 'monolithWidth', 0.05, 3, 0.01, 'width');
    R(stones, c, 'monolithThin', 0.05, 1.5, 0.01, 'slab flatness');
    R(stones, c, 'monolithLean', -0.8, 0.8, 0.005, 'outward lean');
    R(stones, c, 'monolithSweep', 0.02, 2, 0.01, 'sweep time');
    R(stones, c, 'rubble', 0, 32, 1, 'rubble');
    R(stones, c, 'rubbleHeight', 0.05, 3, 0.01, 'rubble height');
    R(stones, c, 'rubbleRing', 0, 1.4, 0.005, 'rubble seat');

    const glass = folder.addFolder('Obsidian & sub-surface veins');
    R(glass, c, 'veinScale', 0.1, 8, 0.05, 'vein scale');
    R(glass, c, 'veinWidth', 0.005, 0.4, 0.001, 'vein width');
    R(glass, c, 'veinBranches', 0.05, 2, 0.01, 'branch detail');
    R(glass, c, 'veinDepth', 0, 1.2, 0.005, 'sub-surface depth');
    R(glass, c, 'veinGlow', 0, 10, 0.05, 'vein glow');
    R(glass, c, 'veinFlow', 0, 1, 0.01, 'melt crawl');
    R(glass, c, 'veinFlowSpeed', 0, 5, 0.01, 'crawl speed');
    R(glass, c, 'veinFlash', 0, 8, 0.05, 'flash gain');
    R(glass, c, 'flashSpeed', 0, 20, 0.05, 'flash climb, m/s');
    R(glass, c, 'flashWidth', 0.05, 5, 0.05, 'flash width');
    R(glass, c, 'glassRough', 0.02, 1, 0.01, 'roughness');
    R(glass, c, 'facetTint', 0, 1.5, 0.01, 'facet break-up');
    R(glass, c, 'cavity', 0, 1, 0.01, 'cavity');
    R(glass, c, 'rimLight', 0, 3, 0.01, 'rim heat');
    R(glass, c, 'envIntensity', 0, 3, 0.01, 'reflections');
    R(glass, c, 'obsidianGlow', 0, 4, 0.01, 'glow');
    glass.addColor(c, 'colorObsidian').name('glass');
    glass.addColor(c, 'colorObsidianChar').name('char');
    glass.addColor(c, 'colorVein').name('vein');
    glass.addColor(c, 'colorVeinCore').name('vein core');

    const floor = folder.addFolder('The floor');
    R(floor, c, 'fieldPlates', 0.1, 6, 0.01, 'plates / metre');
    R(floor, c, 'fieldRadial', 0, 1, 0.01, 'radial shattering');
    R(floor, c, 'fieldWarp', 0, 2, 0.01, 'domain warp');
    R(floor, c, 'fieldSeam', 0.005, 0.4, 0.001, 'seam width');
    R(floor, c, 'fieldSeamGlow', 0, 10, 0.05, 'seam glow');
    R(floor, c, 'fieldCrust', 0, 1, 0.01, 'crust opacity');
    R(floor, c, 'fieldRelief', 0, 3, 0.01, 'plate relief');
    R(floor, c, 'fieldHeat', 0, 4, 0.01, 'melt heat');
    R(floor, c, 'fieldHeatFalloff', 0.1, 5, 0.05, 'heat falloff');
    R(floor, c, 'fieldCool', 0, 1, 0.01, 'cooling over life');
    R(floor, c, 'fieldFlow', -3, 3, 0.01, 'melt crawl');
    R(floor, c, 'fieldEmber', 0, 3, 0.01, 'seam flecks');
    R(floor, c, 'fieldEmberScale', 0.5, 14, 0.1, 'fleck scale');
    R(floor, c, 'fieldBoundary', 0.01, 1.5, 0.005, 'boundary band');
    R(floor, c, 'fieldBoundaryGlow', 0, 8, 0.05, 'band glow');
    R(floor, c, 'fieldCore', 0, 5, 0.01, 'centre pool');
    R(floor, c, 'fieldCoreSize', 0.02, 1, 0.005, 'pool size');
    R(floor, c, 'fieldRings', 0, 10, 0.05, 'pressure rings');
    R(floor, c, 'fieldRingSpeed', -5, 5, 0.01, 'ring speed');
    R(floor, c, 'fieldOpacity', 0, 2, 0.01, 'opacity');
    R(floor, c, 'fieldHeight', 0.005, 0.3, 0.002, 'hover height');
    floor.addColor(c, 'colorCrust').name('crust');
    floor.addColor(c, 'colorPlate').name('plate');
    floor.addColor(c, 'colorMagma').name('magma');
    floor.addColor(c, 'colorMagmaHot').name('magma core');
    floor.addColor(c, 'colorFieldEdge').name('band & pool');

    const flare = folder.addFolder('The core flare');
    R(flare, c, 'flareSize', 0.2, 14, 0.05, 'size');
    R(flare, c, 'flareHeight', 0, 8, 0.01, 'height off the floor');
    R(flare, c, 'flareBase', 0, 3, 0.01, 'standing brightness');
    R(flare, c, 'flareCore', 0, 6, 0.01, 'core');
    R(flare, c, 'flareStreak', 0, 5, 0.01, 'streak length');
    R(flare, c, 'flareStreakWidth', 0.005, 0.4, 0.001, 'streak width');
    R(flare, c, 'flareSpikes', 2, 16, 1, 'starburst points');
    R(flare, c, 'flareSpikeGain', 0, 3, 0.01, 'starburst gain');
    R(flare, c, 'flareSpikeSharp', 2, 80, 0.5, 'starburst sharpness');
    R(flare, c, 'flareGhosts', 0, 2, 0.01, 'ghosts');
    R(flare, c, 'flareSpin', -1, 1, 0.005, 'spin');
    R(flare, c, 'shockWidth', 0.005, 0.4, 0.001, 'shock ring width');
    R(flare, c, 'shockSpeed', 0.2, 10, 0.05, 'shock ring speed');
    R(flare, c, 'flareOpacity', 0, 2, 0.01, 'opacity');
    flare.addColor(c, 'colorFlareCore').name('core');
    flare.addColor(c, 'colorFlareStreak').name('streak');
    flare.addColor(c, 'colorFlareGhost').name('ghosts');

    const haze = folder.addFolder('Heat haze');
    R(haze, c, 'hazeStrength', 0, 4, 0.01, 'strength');
    R(haze, c, 'hazeScale', 0.1, 8, 0.05, 'scale');
    R(haze, c, 'hazeSpeed', 0, 6, 0.01, 'rise speed');
    R(haze, c, 'hazeHeight', 0.1, 3, 0.01, 'height, × the wall');
    R(haze, c, 'hazeWidth', 0.1, 3, 0.01, 'width, × footprint');
    R(haze, c, 'hazeFalloff', 0.1, 4, 0.01, 'falloff');

    const embers = folder.addFolder('Embers & ash');
    R(embers, c, 'emberRate', 0, 1200, 1, 'ember rate');
    R(embers, c, 'emberSize', 0.005, 0.5, 0.005, 'ember size');
    R(embers, c, 'emberSpeed', 0, 25, 0.1, 'ember speed');
    R(embers, c, 'emberLifetime', 0.1, 8, 0.05, 'ember lifetime');
    R(embers, c, 'emberRise', -5, 20, 0.1, 'lift');
    R(embers, c, 'emberTurbulence', 0, 4, 0.01, 'swirl');
    R(embers, c, 'emberInset', 0, 0.95, 0.01, 'pick-up inset');
    Editor.gradient(embers, c, 'colorEmber', 'Ember colour');
    R(embers, c, 'fleckRate', 0, 300, 1, 'fleck rate');
    R(embers, c, 'fleckSize', 0.005, 0.4, 0.005, 'fleck size');
    R(embers, c, 'fleckSpeed', 0, 25, 0.1, 'fleck speed');
    R(embers, c, 'fleckLifetime', 0.1, 6, 0.05, 'fleck lifetime');
    R(embers, c, 'fleckGravity', -40, 5, 0.1, 'fleck gravity');
    Editor.gradient(embers, c, 'colorFleck', 'Fleck colour');

    const gore = folder.addFolder('Gore & smoke');
    R(gore, c, 'goreRate', 0, 400, 1, 'gore rate');
    R(gore, c, 'goreSize', 0.005, 0.6, 0.005, 'droplet size');
    R(gore, c, 'goreSpeed', 0, 30, 0.1, 'droplet speed');
    R(gore, c, 'goreLifetime', 0.1, 5, 0.05, 'droplet lifetime');
    R(gore, c, 'goreGravity', -50, 0, 0.1, 'gravity');
    R(gore, c, 'goreOpacity', 0, 1.5, 0.01, 'opacity');
    Editor.gradient(gore, c, 'colorGore', 'Gore colour');
    R(gore, c, 'smokeRate', 0, 500, 1, 'smoke rate');
    R(gore, c, 'smokeSize', 0.05, 4, 0.01, 'smoke size');
    R(gore, c, 'smokeSpeed', 0, 8, 0.05, 'smoke speed');
    R(gore, c, 'smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime');
    R(gore, c, 'smokeOpacity', 0, 1, 0.005, 'smoke opacity');
    R(gore, c, 'smokeRise', -2, 4, 0.01, 'smoke rise');
    Editor.gradient(gore, c, 'colorSmoke', 'Smoke colour');

    const ground = folder.addFolder('Marks on the ground');
    R(ground, c, 'scorchRadius', 0.05, 10, 0.05, 'scorch radius');
    R(ground, c, 'scorchLife', 0.5, 20, 0.1, 'scorch lifetime');
    R(ground, c, 'scorchIntensity', 0, 2, 0.01, 'scorch intensity');
    R(ground, c, 'splatRate', 0, 30, 0.1, 'gore marks / sec');
    R(ground, c, 'splatRadius', 0.05, 4, 0.05, 'mark radius');
    R(ground, c, 'splatLife', 0.2, 15, 0.1, 'mark lifetime');
    R(ground, c, 'splatIntensity', 0, 2, 0.01, 'mark intensity');
    R(ground, c, 'trailRate', 0.05, 8, 0.05, 'surge marks / metre');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, 'seal ring radius');
    R(ground, c, 'ringRate', 0, 12, 0.1, 'dust rings / sec');
    ground.addColor(c, 'colorScorch').name('scorch');
    ground.addColor(c, 'colorSplat').name('gore mark');
    ground.addColor(c, 'colorSplatEdge').name('mark edge');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');

    const impact = folder.addFolder('Throw, seal & hold');
    R(impact, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(impact, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(impact, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(impact, c, 'muzzleSize', 0.05, 6, 0.05, 'muzzle size');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'muzzle intensity');
    R(impact, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, 'seal shell size');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, 'seal shell intensity');
    R(impact, c, 'sealEmbers', 0, 900, 1, 'seal embers');
    R(impact, c, 'sealGore', 0, 600, 1, 'seal gore');
    R(impact, c, 'sealFlecks', 0, 400, 1, 'seal flecks');
    R(impact, c, 'sealShake', 0, 3, 0.01, 'seal shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'sealFlash', 0, 2, 0.01, 'seal flash');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, 'hold rumble');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'surge rumble');
    impact.addColor(c, 'colorBurstA').name('shell inner');
    impact.addColor(c, 'colorBurstB').name('shell mid');
    impact.addColor(c, 'colorBurstC').name('shell core');
    impact.addColor(c, 'colorCastFlash').name('release flash');
    impact.addColor(c, 'colorFlash').name('seal flash');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 1, 0.01, 'height up the wall');
    R(light, c, 'lightBeat', 0, 1, 0.01, 'owned by the beat');
    light.addColor(c, 'lightColor').name('light colour');

    this.wardFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The Caustic Bloom.
   *
   * Grouped the way the reference sheet is: one folder per pass, in the order
   * you see them — the floor dissolves, the ring snaps out, the gas climbs, the
   * bubbles come off it, the air warps. `The boil` sits at the top with the
   * cast, because it is the one group that reaches into all of them: drop
   * `boilDepth` to zero and the aura goes inert, every pass at once.
   *
   * `mist steps` is the performance dial. It is a live slider on purpose — the
   * same build has to run on a laptop and on the machine driving the projector.
   */
  _buildAcid() {
    const folder = this.gui.addFolder('☣  Caustic Bloom');
    const c = settings.acid;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 300, 1, 'corrosion speed');
    R(cast, c, 'bloomTime', 0.02, 2, 0.01, 'bloom time');
    R(cast, c, 'lifetime', 0.2, 16, 0.05, 'hold time');
    R(cast, c, 'fadeTime', 0.05, 5, 0.01, 'go-inert time');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const boil = folder.addFolder('The boil');
    R(boil, c, 'boilRate', 0.05, 8, 0.05, 'envelope speed');
    R(boil, c, 'boilSharp', 0.2, 8, 0.05, 'surge sharpness');
    R(boil, c, 'boilDepth', 0, 2, 0.01, 'modulation depth');
    R(boil, c, 'boilThreshold', 0.05, 0.98, 0.01, 'vent threshold');
    R(boil, c, 'goutBubbles', 0, 300, 1, 'bubbles / vent');
    R(boil, c, 'goutMotes', 0, 500, 1, 'motes / vent');
    R(boil, c, 'goutLift', 0.2, 5, 0.05, 'vent lift');
    R(boil, c, 'goutRing', 0, 2, 0.01, 'ring brightness');
    R(boil, c, 'goutShake', 0, 0.6, 0.005, 'camera knock');

    const pool = folder.addFolder('The acid pool');
    R(pool, c, 'poolPlates', 0.1, 6, 0.01, 'plates / metre');
    R(pool, c, 'poolCraze', 0, 1.5, 0.01, 'fine crazing');
    R(pool, c, 'poolWarp', 0, 2, 0.01, 'domain warp');
    R(pool, c, 'poolSeam', 0.005, 0.4, 0.001, 'channel width');
    R(pool, c, 'poolSeamGlow', 0, 10, 0.05, 'channel glow');
    R(pool, c, 'poolCrust', 0, 1, 0.01, 'crust opacity');
    R(pool, c, 'poolRelief', 0, 3, 0.01, 'plate relief');
    R(pool, c, 'poolSheen', 0, 4, 0.01, 'wet sheen');
    R(pool, c, 'poolGloss', 0, 1, 0.01, 'gloss tightness');
    R(pool, c, 'poolEtch', 0, 2, 0.01, 'edge chew');
    R(pool, c, 'poolEtchScale', 0.1, 8, 0.05, 'chew scale');
    R(pool, c, 'poolPits', 0, 1, 0.01, 'plates eaten through');
    R(pool, c, 'poolPitScale', 0.1, 8, 0.05, 'pits / metre');
    R(pool, c, 'poolBoilRate', 0, 4, 0.01, 'surface bubbles');
    R(pool, c, 'poolHeat', 0, 4, 0.01, 'acid brightness');
    R(pool, c, 'poolHeatFalloff', 0.1, 5, 0.05, 'brightness falloff');
    R(pool, c, 'poolSpend', 0, 1, 0.01, 'spent over life');
    R(pool, c, 'poolFlow', -3, 3, 0.01, 'channel crawl');
    R(pool, c, 'poolCaustic', 0, 3, 0.01, 'caustics');
    R(pool, c, 'poolCausticScale', 0.1, 8, 0.05, 'caustic scale');
    R(pool, c, 'poolBoundary', 0.01, 1.5, 0.005, 'boundary band');
    R(pool, c, 'poolBoundaryGlow', 0, 8, 0.05, 'band glow');
    R(pool, c, 'poolCore', 0, 5, 0.01, 'centre pool');
    R(pool, c, 'poolCoreSize', 0.02, 1, 0.005, 'pool size');
    R(pool, c, 'poolRings', 0, 10, 0.05, 'pressure rings');
    R(pool, c, 'poolRingSpeed', -5, 5, 0.01, 'ring speed');
    R(pool, c, 'poolOpacity', 0, 2, 0.01, 'opacity');
    R(pool, c, 'poolHeight', 0.005, 0.3, 0.002, 'hover height');
    pool.addColor(c, 'colorSludge').name('sludge');
    pool.addColor(c, 'colorPlate').name('plate');
    pool.addColor(c, 'colorAcid').name('acid');
    pool.addColor(c, 'colorAcidHot').name('acid core');
    pool.addColor(c, 'colorPoolEdge').name('band & pool');

    const mist = folder.addFolder('The toxic mist');
    R(mist, c, 'mistSteps', 6, 64, 1, 'mist steps (cost)');
    R(mist, c, 'mistHeight', 0.5, 16, 0.05, 'column height');
    R(mist, c, 'riseCurve', 0.2, 4, 0.01, 'rise curve');
    R(mist, c, 'mistDensity', 0, 6, 0.01, 'density');
    R(mist, c, 'mistAbsorb', 0.05, 6, 0.01, 'absorption');
    R(mist, c, 'mistScale', 0.05, 2, 0.005, 'features / metre');
    R(mist, c, 'mistDetail', 0.2, 6, 0.05, 'filament scale');
    R(mist, c, 'mistFilament', 0, 1, 0.01, 'filaments vs billows');
    R(mist, c, 'mistThreshold', 0, 0.9, 0.01, 'carve threshold');
    R(mist, c, 'mistRise', -3, 3, 0.01, 'climb speed');
    R(mist, c, 'mistStretch', 0.05, 1.5, 0.01, 'vertical stretch');
    R(mist, c, 'mistTwist', -6, 6, 0.05, 'vortex twist');
    R(mist, c, 'mistSpin', -1, 1, 0.005, 'column spin');
    R(mist, c, 'mistEdge', 0, 1, 0.01, 'wall softness');
    R(mist, c, 'mistFlare', -0.4, 1.5, 0.01, 'chimney flare');
    R(mist, c, 'mistFalloff', 0.1, 5, 0.01, 'thinning with height');
    R(mist, c, 'mistSkirt', 0, 1, 0.01, 'spill past the edge');
    R(mist, c, 'mistLobe', 0, 1, 0.01, 'wall wander');
    R(mist, c, 'mistTear', 0, 0.6, 0.005, 'crown tearing');
    R(mist, c, 'mistGroundGlow', 0, 6, 0.01, 'lit from the pool');
    R(mist, c, 'mistGroundFalloff', 0.05, 3, 0.01, 'that light falloff');
    R(mist, c, 'mistShadow', 0, 8, 0.05, 'self-shadow');
    R(mist, c, 'mistShadowStep', 0.05, 4, 0.05, 'shadow tap, metres');
    R(mist, c, 'mistAmbient', 0, 1, 0.005, 'ambient');
    R(mist, c, 'mistSaturate', 0, 5, 0.01, 'deepening with density');
    R(mist, c, 'mistOpacity', 0, 2, 0.01, 'opacity');
    R(mist, c, 'mistGlow', 0, 4, 0.01, 'glow');
    mist.addColor(c, 'colorMistDeep').name('thick gas');
    mist.addColor(c, 'colorMistBody').name('body');
    mist.addColor(c, 'colorMistEdge').name('thin gas');
    mist.addColor(c, 'colorMistLight').name('sunlight through');

    const ring = folder.addFolder('The base ring');
    R(ring, c, 'ringInset', -1, 1.5, 0.005, 'stand-off');
    R(ring, c, 'ringHeight', 0.005, 0.3, 0.002, 'hover height');
    R(ring, c, 'ringWidth', 0.005, 0.5, 0.001, 'core width');
    R(ring, c, 'ringCore', 0, 8, 0.01, 'core brightness');
    R(ring, c, 'ringHalo', 0, 4, 0.01, 'halo');
    R(ring, c, 'ringHaloWidth', 0.02, 3, 0.01, 'halo width');
    R(ring, c, 'ringSpill', 0, 1.5, 0.01, 'inward spill');
    R(ring, c, 'ringWobble', 0, 0.25, 0.001, 'radius wander');
    R(ring, c, 'ringWobbleScale', 0.2, 10, 0.05, 'wander scale');
    R(ring, c, 'ringChevrons', 0, 120, 1, 'chevrons');
    R(ring, c, 'ringChevronDepth', 0, 1, 0.01, 'chevron depth');
    R(ring, c, 'ringScroll', -1, 1, 0.005, 'chevron scroll');
    R(ring, c, 'ringSweep', 0, 4, 0.01, 'read head');
    R(ring, c, 'ringSweepSpeed', -2, 2, 0.005, 'head speed');
    R(ring, c, 'ringSweepWidth', 0.01, 0.6, 0.005, 'head width');
    R(ring, c, 'ringTicks', 0, 24, 1, 'compass ticks');
    R(ring, c, 'ringOpacity', 0, 2, 0.01, 'opacity');
    R(ring, c, 'ringGlow', 0, 6, 0.01, 'glow');
    R(ring, c, 'collarHeight', 0, 3, 0.01, 'collar height');
    R(ring, c, 'collarGain', 0, 5, 0.01, 'collar gain');
    R(ring, c, 'collarFalloff', 0.2, 6, 0.01, 'collar falloff');
    R(ring, c, 'collarFresnel', 0.2, 6, 0.05, 'collar rim');
    R(ring, c, 'collarStreaks', 2, 90, 1, 'collar streaks');
    R(ring, c, 'collarStreakDepth', 0, 1, 0.01, 'streak depth');
    R(ring, c, 'collarStreakSpeed', -4, 4, 0.01, 'streak speed');
    R(ring, c, 'collarSoftFade', 0.02, 3, 0.01, 'soft intersection');
    R(ring, c, 'collarOpacity', 0, 2, 0.01, 'collar opacity');
    ring.addColor(c, 'colorRing').name('ring');
    ring.addColor(c, 'colorRingCore').name('ring core');

    const fume = folder.addFolder('Corrosive shimmer');
    R(fume, c, 'fumeStrength', 0, 4, 0.01, 'strength');
    R(fume, c, 'fumeScale', 0.1, 8, 0.05, 'scale');
    R(fume, c, 'fumeSpeed', 0, 6, 0.01, 'rise speed');
    R(fume, c, 'fumeSwirl', -2, 2, 0.01, 'roll with height');
    R(fume, c, 'fumeHeight', 0.1, 3, 0.01, 'height, × the column');
    R(fume, c, 'fumeWidth', 0.1, 3, 0.01, 'width, × footprint');
    R(fume, c, 'fumeFalloff', 0.1, 4, 0.01, 'falloff');

    const bubbles = folder.addFolder('Bubbles & motes');
    R(bubbles, c, 'bubbleRate', 0, 300, 1, 'bubble rate');
    R(bubbles, c, 'bubbleSize', 0.01, 1.2, 0.005, 'bubble size');
    R(bubbles, c, 'bubbleSpeed', 0, 15, 0.05, 'bubble speed');
    R(bubbles, c, 'bubbleLifetime', 0.1, 8, 0.05, 'bubble lifetime');
    R(bubbles, c, 'bubbleRise', -5, 12, 0.05, 'buoyancy');
    R(bubbles, c, 'bubbleTurbulence', 0, 3, 0.01, 'wander');
    R(bubbles, c, 'bubbleGrow', 0.5, 5, 0.05, 'growth before bursting');
    R(bubbles, c, 'bubbleInset', 0, 0.95, 0.01, 'pick-up inset');
    R(bubbles, c, 'bubbleOpacity', 0, 1.5, 0.01, 'bubble opacity');
    Editor.gradient(bubbles, c, 'colorBubble', 'Bubble colour');
    R(bubbles, c, 'moteRate', 0, 900, 1, 'mote rate');
    R(bubbles, c, 'moteSize', 0.005, 0.4, 0.005, 'mote size');
    R(bubbles, c, 'moteSpeed', 0, 20, 0.1, 'mote speed');
    R(bubbles, c, 'moteLifetime', 0.1, 6, 0.05, 'mote lifetime');
    R(bubbles, c, 'moteRise', -5, 15, 0.1, 'lift');
    R(bubbles, c, 'moteTurbulence', 0, 4, 0.01, 'swirl');
    Editor.gradient(bubbles, c, 'colorMote', 'Mote colour');

    const spill = folder.addFolder('Fog & splatter');
    R(spill, c, 'fogRate', 0, 400, 1, 'fog rate');
    R(spill, c, 'fogSize', 0.05, 4, 0.01, 'fog size');
    R(spill, c, 'fogSpeed', 0, 8, 0.05, 'fog speed');
    R(spill, c, 'fogLifetime', 0.2, 8, 0.05, 'fog lifetime');
    R(spill, c, 'fogOpacity', 0, 1, 0.005, 'fog opacity');
    R(spill, c, 'fogRise', -2, 4, 0.01, 'fog rise');
    R(spill, c, 'fogSpread', 0, 3, 0.01, 'outward push');
    Editor.gradient(spill, c, 'colorFog', 'Fog colour');
    R(spill, c, 'splashRate', 0, 200, 1, 'splatter rate');
    R(spill, c, 'splashSize', 0.005, 0.5, 0.005, 'droplet size');
    R(spill, c, 'splashSpeed', 0, 25, 0.1, 'droplet speed');
    R(spill, c, 'splashLifetime', 0.1, 5, 0.05, 'droplet lifetime');
    R(spill, c, 'splashGravity', -50, 0, 0.1, 'gravity');
    R(spill, c, 'splashOpacity', 0, 1.5, 0.01, 'opacity');
    Editor.gradient(spill, c, 'colorSplash', 'Splatter colour');

    const ground = folder.addFolder('Marks on the ground');
    R(ground, c, 'etchRadius', 0.05, 10, 0.05, 'etch radius');
    R(ground, c, 'etchLife', 0.5, 20, 0.1, 'etch lifetime');
    R(ground, c, 'etchIntensity', 0, 2, 0.01, 'etch intensity');
    R(ground, c, 'stainRate', 0, 30, 0.1, 'stains / sec');
    R(ground, c, 'stainRadius', 0.05, 4, 0.05, 'stain radius');
    R(ground, c, 'stainLife', 0.2, 15, 0.1, 'stain lifetime');
    R(ground, c, 'stainIntensity', 0, 2, 0.01, 'stain intensity');
    R(ground, c, 'trailRate', 0.05, 8, 0.05, 'creep marks / metre');
    R(ground, c, 'shockRadius', 0.5, 25, 0.1, 'bloom ring radius');
    R(ground, c, 'ringRate', 0, 12, 0.1, 'vapour rings / sec');
    ground.addColor(c, 'colorEtch').name('etch');
    ground.addColor(c, 'colorStain').name('stain');
    ground.addColor(c, 'colorStainEdge').name('stain edge');
    ground.addColor(c, 'colorShockA').name('shockwave ring');
    ground.addColor(c, 'colorShockB').name('shockwave crest');

    const impact = folder.addFolder('Throw, bloom & hold');
    R(impact, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(impact, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(impact, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(impact, c, 'muzzleSize', 0.05, 6, 0.05, 'muzzle size');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'muzzle intensity');
    R(impact, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    R(impact, c, 'burstSize', 0.2, 14, 0.05, 'bloom shell size');
    R(impact, c, 'burstIntensity', 0, 5, 0.01, 'bloom shell intensity');
    R(impact, c, 'bloomBubbles', 0, 600, 1, 'bloom bubbles');
    R(impact, c, 'bloomMotes', 0, 900, 1, 'bloom motes');
    R(impact, c, 'bloomSplash', 0, 600, 1, 'bloom splatter');
    R(impact, c, 'bloomShake', 0, 3, 0.01, 'bloom shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'bloomFlash', 0, 2, 0.01, 'bloom flash');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, 'hold rumble');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'creep rumble');
    impact.addColor(c, 'colorBurstA').name('shell inner');
    impact.addColor(c, 'colorBurstB').name('shell mid');
    impact.addColor(c, 'colorBurstC').name('shell core');
    impact.addColor(c, 'colorCastFlash').name('release flash');
    impact.addColor(c, 'colorFlash').name('bloom flash');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 1, 0.01, 'height up the column');
    R(light, c, 'lightBoil', 0, 1, 0.01, 'owned by the boil');
    light.addColor(c, 'lightColor').name('light colour');

    this.acidFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildEnvironment() {
    const folder = this.gui.addFolder('Environment');
    const e = settings.environment;
    const R = Editor.range;

    R(folder, e, 'sunIntensity', 0, 8, 0.01, 'key intensity');
    folder.addColor(e, 'sunColor').name('key colour');
    R(folder, e, 'sunAzimuth', 0, Math.PI * 2, 0.01, 'key azimuth');
    R(folder, e, 'sunElevation', 0.05, 1.5, 0.01, 'key elevation');
    R(folder, e, 'ambientIntensity', 0, 3, 0.01, 'ambient');
    folder.addColor(e, 'ambientColor').name('ambient colour');
    R(folder, e, 'hemiIntensity', 0, 3, 0.01, 'hemisphere');
    R(folder, e, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(folder, e, 'shadowRadius', 0, 8, 0.05, 'shadow softness');
    R(folder, e, 'shadowBias', -0.01, 0.001, 0.0001, 'shadow bias');
    R(folder, e, 'contactShadow', 0, 1.5, 0.01, 'contact shadow');

    const rim = folder.addFolder('Rim light');
    R(rim, e, 'rimIntensity', 0, 4, 0.01, 'rim intensity');
    rim.addColor(e, 'rimColor').name('rim colour');
    R(rim, e, 'rimAzimuth', 0, Math.PI * 2, 0.01, 'rim azimuth');
    R(rim, e, 'rimElevation', 0.05, 1.5, 0.01, 'rim elevation');
    rim.addColor(e, 'hemiSkyColor').name('hemi sky');
    rim.addColor(e, 'hemiGroundColor').name('hemi bounce');

    const fog = folder.addFolder('Backdrop, fog & dust');
    fog.addColor(e, 'backgroundColor').name('backdrop');
    fog.add(e, 'fogEnabled').name('fog enabled');
    fog.addColor(e, 'fogColor').name('fog colour');
    // near = where the fog starts, far = where it is total; widening the gap or
    // pushing both out thins the fog, closing it thickens it.
    R(fog, e, 'fogNear', 1, 200, 1, 'fog near');
    R(fog, e, 'fogFar', 10, 400, 1, 'fog far');
    R(fog, e, 'dustAmount', 0, 3, 0.01, 'floating dust');

    const floor = folder.addFolder('Stage floor');
    floor.add(e, 'floorTexture').name('stone tile');
    R(floor, e, 'floorTextureScale', 0.5, 24, 0.1, 'tile size (m)');
    R(floor, e, 'floorNormalScale', 0, 3, 0.01, 'relief strength');
    R(floor, e, 'floorTexTint', 0, 1, 0.01, 'tint toward floor');
    floor.addColor(e, 'floorColor').name('floor colour');
    floor.addColor(e, 'floorTint').name('floor tint');
    R(floor, e, 'floorRoughness', 0.05, 1, 0.01, 'roughness');
    R(floor, e, 'floorSheen', 0, 1, 0.01, 'sheen');
    R(floor, e, 'floorPool', 0, 1, 0.01, 'light pool');
  }

  _buildPost() {
    const folder = this.gui.addFolder('Post processing');
    const p = settings.post;
    const R = Editor.range;

    folder.add(p, 'enabled').name('enabled');
    R(folder, p, 'exposure', 0.1, 3, 0.01, 'exposure');
    R(folder, p, 'bloomStrength', 0, 3, 0.01, 'bloom intensity');
    R(folder, p, 'bloomRadius', 0, 1.5, 0.01, 'bloom radius');
    R(folder, p, 'bloomThreshold', 0, 2, 0.01, 'bloom threshold');
    R(folder, p, 'contrast', 0.5, 2, 0.01, 'contrast');
    R(folder, p, 'saturation', 0, 2.5, 0.01, 'saturation');
    R(folder, p, 'temperature', -0.5, 0.5, 0.01, 'temperature');
    R(folder, p, 'lift', -0.2, 0.2, 0.005, 'lift');
    R(folder, p, 'gain', 0.5, 2, 0.01, 'gain');
    R(folder, p, 'vignette', 0, 1.5, 0.01, 'vignette');
    R(folder, p, 'chromaticAberration', 0, 3, 0.01, 'chromatic aberration');
    R(folder, p, 'grain', 0, 0.2, 0.001, 'film grain');
    R(folder, p, 'distortion', 0, 0.2, 0.001, 'screen warp');
    R(folder, p, 'flashStrength', 0, 2, 0.01, 'impact flash');
  }

  _buildCamera() {
    const folder = this.gui.addFolder('Camera');
    const c = settings.camera;
    const R = Editor.range;

    // The wheel writes `distance` straight into settings, so the slider listens.
    R(folder, c, 'distance', 1, 40, 0.1, 'distance').listen();
    R(folder, c, 'minDistance', 1, 20, 0.1, 'min distance');
    R(folder, c, 'maxDistance', 4, 40, 0.1, 'max distance');
    R(folder, c, 'zoomSpeed', 0.1, 3, 0.01, 'zoom speed');
    R(folder, c, 'fov', 20, 90, 0.5, 'field of view');
    R(folder, c, 'targetHeight', 0, 4, 0.01, 'target height');
    R(folder, c, 'minPolar', 0.05, 1.5, 0.01, 'min pitch');
    R(folder, c, 'maxPolar', 0.2, 1.55, 0.01, 'max pitch');
    R(folder, c, 'damping', 0.001, 0.5, 0.001, 'follow damping');
    R(folder, c, 'autoFrame', 0, 1, 0.01, 'auto framing');

    folder.add({ clear: () => this.hooks.onClear?.() }, 'clear').name('Clear effects (C)');
  }

  _buildCharacter() {
    const folder = this.gui.addFolder('Character');
    const c = settings.character;
    const R = Editor.range;

    // The mixer's own rate, so it scales the idle and the cast clips together.
    // The same value as Global → animation speed, mirrored here where it is
    // actually reached for; `listen` keeps the two readouts honest.
    R(folder, settings.global, 'animationSpeed', 0.1, 3, 0.01, 'playback rate').listen();

    // Which clip each ability throws lives in that ability's own folder, under
    // "The cast"; these are the edges of the blend that lays it over the idle.
    const cast = folder.addFolder('Casting');
    R(cast, c, 'castBlendIn', 0.01, 1, 0.01, 'blend into cast');
    R(cast, c, 'castBlendOut', 0.01, 1.5, 0.01, 'blend back to idle');
    cast.add(c, 'turnToAim').name('turn to aim');
    R(cast, c, 'turnRate', 0.000001, 0.02, 0.000001, 'turn follow');

    // The procedural accent that rides on top of the clip. Zero both leans to
    // let the animation carry the cast on its own.
    const lunge = folder.addFolder('Lunge');
    R(lunge, c, 'castLean', 0, 1.2, 0.01, 'lunge lean');
    R(lunge, c, 'castRecoil', 0, 0.8, 0.005, 'lunge recoil');
    R(lunge, c, 'castSettle', 0.2, 8, 0.05, 'lunge settle');
  }

  /**
   * The target dummies and how they fall.
   *
   * Everything here is live: the ring re-populates while you watch, the fall's
   * gravity and stiffness apply to bodies already on the floor, and the blow's
   * numbers apply to the next thing that gets hit. The one exception is
   * `height`, which sizes the model when it is loaded.
   */
  _buildDummies() {
    const folder = this.gui.addFolder('Target dummies');
    const d = settings.dummies;
    const R = Editor.range;

    folder.add(d, 'enabled').name('enabled');
    R(folder, d, 'count', 0, 16, 1, 'how many');

    const ring = folder.addFolder('Where they stand');
    R(ring, d, 'radius', 4, 40, 0.5, 'ring radius');
    R(ring, d, 'minRadius', 1, 20, 0.5, 'no nearer than');
    R(ring, d, 'separation', 0.5, 6, 0.1, 'apart, metres');
    ring.add(d, 'watch').name('turn to watch');
    R(ring, d, 'turnRate', 0.000001, 0.5, 0.000001, 'turn follow');

    // What a cast has to cover to knock one down, and how hard it throws it.
    const hit = folder.addFolder('The blow');
    hit.add(d.hit, 'enabled').name('abilities kill');
    R(hit, d.hit, 'radius', 0.2, 6, 0.05, 'line reach, metres');
    R(hit, d.hit, 'zoneScale', 0.2, 2.5, 0.05, 'far-cast footprint');
    R(hit, d, 'bodyRadius', 0.1, 1.5, 0.02, 'body radius');
    R(hit, d.hit, 'impulse', 0, 30, 0.1, 'impulse');
    R(hit, d.hit, 'lift', 0, 16, 0.1, 'lift');
    R(hit, d.hit, 'spin', -3, 4, 0.05, 'spin (torque)');

    const fall = folder.addFolder('The fall');
    R(fall, d.ragdoll, 'gravity', -60, -2, 0.5, 'gravity');
    R(fall, d.ragdoll, 'damping', 0, 0.6, 0.005, 'air drag');
    R(fall, d.ragdoll, 'iterations', 1, 16, 1, 'solver passes');
    R(fall, d.ragdoll, 'brace', 0, 1, 0.01, 'torso stiffness');
    R(fall, d.ragdoll, 'radius', 0.01, 0.4, 0.005, 'joint radius');
    R(fall, d.ragdoll, 'friction', 0, 1, 0.01, 'ground friction');
    R(fall, d.ragdoll, 'bounce', 0, 0.8, 0.01, 'ground bounce');
    R(fall, d.ragdoll, 'sleep', 0.001, 0.5, 0.001, 'sleep threshold');

    const corpse = folder.addFolder('Corpse & respawn');
    R(corpse, d, 'corpseTime', 0, 20, 0.1, 'lies there, seconds');
    R(corpse, d, 'dissolveTime', 0.1, 6, 0.05, 'burns away, seconds');
    R(corpse, d, 'respawnDelay', 0, 15, 0.1, 'respawn delay');

    const look = folder.addFolder('The look');
    look.addColor(d.look, 'color').name('body');
    R(look, d.look, 'roughness', 0, 1, 0.01, 'roughness');
    R(look, d.look, 'metalness', 0, 1, 0.01, 'metalness');
    look.addColor(d.look, 'rimColor').name('rim');
    R(look, d.look, 'rimPower', 0.5, 8, 0.05, 'rim tightness');
    R(look, d.look, 'rimEmissive', 0, 6, 0.05, 'rim strength');
    look.addColor(d.look, 'edgeColor').name('burn edge');
    R(look, d.look, 'edgeEmissive', 0, 20, 0.1, 'burn glow');
    R(look, d.look, 'edgeWidth', 0.01, 0.5, 0.005, 'burn width');
    R(look, d.look, 'dissolveDetail', 1, 30, 0.5, 'burn detail');
  }

  dispose() {
    this.gui.destroy();
  }
}
