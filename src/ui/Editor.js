import GUI from 'lil-gui';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { PresetManager } from './PresetManager.js';

/**
 * Real-time VFX editor.
 *
 * Every control binds straight to a field in `config/settings.js`. Because all
 * shaders, particle systems, lights and post passes *read* those fields each
 * frame, no controller needs an onChange handler: moving a slider updates the
 * ward that is already standing, the serpent that is already in the air, the
 * next cast, the environment and the post stack simultaneously, with no rebuild
 * and no shader recompilation.
 *
 * That holds while the simulation is paused (`P`), which is the point — the
 * silhouette of a frozen eruption and the shape of a stopped serpent are the
 * things worth tuning, and both abilities re-resolve themselves from these
 * values on a zero-length frame.
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
    this._buildWard();
    this._buildAcid();
    this._buildGrowth();
    this._buildCyber();
    this._buildVenom();
    this._buildQuake();
    this._buildInk();
    this._buildAstral();
    this._buildCascade();
    this._buildRend();
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
   * ward and the serpent should not be cast the same way. `App` reads the value
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

    // The only ability that dissolves what it catches instead of throwing it.
    // The three blow sliders are at zero and are meant to stay there — they are
    // here so the difference can be heard by turning them up.
    const melt = folder.addFolder('What it dissolves');
    const mc = c.melt;
    melt.add(mc, 'enabled').name('dissolves bodies');
    R(melt, mc, 'reach', 0.2, 3, 0.01, 'eats within, x footprint');
    R(melt, mc, 'onset', 0, 4, 0.01, 'flesh goes after');
    R(melt, mc, 'rate', 0.05, 6, 0.01, 'body eaten / second');
    R(melt, mc, 'boil', 0, 1, 0.01, 'owned by the boil');
    R(melt, mc, 'stain', 0.1, 8, 0.05, 'green takes over / second');
    R(melt, mc, 'impulse', 0, 20, 0.1, 'blow, outward');
    R(melt, mc, 'lift', 0, 12, 0.1, 'blow, upward');
    R(melt, mc, 'spin', 0, 4, 0.01, 'blow, torque');
    R(melt, mc.look, 'rimEmissive', 0, 8, 0.05, 'corroded rim glow');
    R(melt, mc.look, 'edgeEmissive', 0, 16, 0.05, 'corroded burn glow');
    R(melt, mc.look, 'edgeWidth', 0.005, 0.4, 0.005, 'corroded burn width');
    melt.addColor(mc.look, 'color').name('corroded flesh');
    melt.addColor(mc.look, 'rimColor').name('corroded rim');
    melt.addColor(mc.look, 'edgeColor').name('corroded burn');

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

  /**
   * The Arborist's Growth Chrono-Summon.
   *
   * Grouped exactly the way the reference sheet is: one folder per layer, in
   * the order they appear on screen — the sigil opens, the tendrils climb, the
   * foliage unfurls, the bloom rises, and then it fires. `The sequence` sits at
   * the top with the cast because it is the one group that reaches into all of
   * them: it is where the summon's *timing* lives, and timing is the only thing
   * about this ability that cannot be judged from a still.
   *
   * `tendrils` and `leaves` are the performance dials, and both are live
   * sliders on purpose — the same build has to run on a laptop and on the
   * machine driving the projector.
   */
  _buildGrowth() {
    const folder = this.gui.addFolder('❦  Arborist’s Growth');
    const c = settings.growth;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 1, 12, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 300, 1, 'seed speed');
    R(cast, c, 'lifetime', 0.5, 20, 0.05, 'hold time');
    R(cast, c, 'fadeTime', 0.1, 8, 0.01, 'wither time');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const sequence = folder.addFolder('The sequence');
    R(sequence, c, 'sigilTime', 0.05, 2, 0.01, 'sigil opens over');
    R(sequence, c, 'vineDelay', 0, 2, 0.01, 'tendrils start at');
    R(sequence, c, 'vineTime', 0.1, 4, 0.01, 'tendrils climb over');
    R(sequence, c, 'vineStagger', 0, 0.85, 0.01, 'stem-to-stem lag');
    R(sequence, c, 'bloomDelay', 0, 4, 0.01, 'bud lifts at');
    R(sequence, c, 'bloomTime', 0.1, 4, 0.01, 'bloom opens over');
    R(sequence, c, 'fireDelay', 0, 3, 0.01, 'first lance after');
    R(sequence, c, 'pulseRate', 0.05, 6, 0.01, 'breath speed');
    R(sequence, c, 'pulseDepth', 0, 2, 0.01, 'breath depth');

    /* ---- layer 1 ---- */
    const sigil = folder.addFolder('1 · The nature sigil');
    R(sigil, c, 'sigilRailWidth', 0.005, 0.2, 0.001, 'rail width (m)');
    R(sigil, c, 'sigilRailOuter', 0.4, 1.4, 0.005, 'outer rail');
    R(sigil, c, 'sigilRailInner', 0.2, 1.2, 0.005, 'inner rail');
    R(sigil, c, 'sigilRailHub', 0.02, 0.6, 0.005, 'hub');
    R(sigil, c, 'sigilRailGlow', 0, 6, 0.01, 'rail glow');
    R(sigil, c, 'sigilSpin', -0.2, 0.2, 0.001, 'ring spin');
    R(sigil, c, 'sigilRunes', 6, 120, 1, 'runes');
    R(sigil, c, 'sigilRuneBand', 0.05, 1.2, 0.005, 'band height (m)');
    R(sigil, c, 'sigilRuneSeat', 0.3, 1.3, 0.005, 'band seat');
    R(sigil, c, 'sigilRuneWeight', 0.01, 0.2, 0.001, 'stroke weight');
    R(sigil, c, 'sigilRuneStrokes', 0, 1, 0.01, 'strokes kept');
    R(sigil, c, 'sigilRuneSweep', 0, 4, 0.01, 'read head');
    R(sigil, c, 'sigilRuneSweepSpeed', -1, 1, 0.005, 'head speed');
    R(sigil, c, 'sigilRuneSweepWidth', 0.01, 0.5, 0.005, 'head width');
    R(sigil, c, 'sigilRuneFlicker', 0, 1, 0.01, 'glyph flicker');
    R(sigil, c, 'sigilRuneGlow', 0, 6, 0.01, 'rune glow');
    R(sigil, c, 'sigilTicks', 0, 3, 0.01, 'graduations');
    R(sigil, c, 'sigilTickCount', 4, 240, 1, 'tick count');
    R(sigil, c, 'sigilTickWidth', 0.02, 1, 0.01, 'tick width');
    R(sigil, c, 'sigilTickLength', 0.005, 0.3, 0.005, 'tick length');
    R(sigil, c, 'sigilStar', 0, 4, 0.01, 'inscribed star');
    R(sigil, c, 'sigilStarRadius', 0.1, 1.2, 0.005, 'star radius');
    R(sigil, c, 'sigilStarWidth', 0.005, 0.15, 0.001, 'star width (m)');
    R(sigil, c, 'sigilStarSpin', -0.2, 0.2, 0.001, 'star spin');
    R(sigil, c, 'sigilFiligree', 0, 3, 0.01, 'vine filigree');
    R(sigil, c, 'sigilFiligreeSeat', 0.1, 1.1, 0.005, 'filigree seat');
    R(sigil, c, 'sigilFiligreeAmp', 0, 0.4, 0.005, 'how far it wanders');
    R(sigil, c, 'sigilFiligreeLobes', 2, 24, 1, 'lobes');
    R(sigil, c, 'sigilFiligreeWidth', 0.004, 0.1, 0.001, 'filigree width (m)');
    R(sigil, c, 'sigilFiligreeSpin', -0.2, 0.2, 0.001, 'filigree spin');
    R(sigil, c, 'sigilPool', 0, 2, 0.01, 'inner wash');
    R(sigil, c, 'sigilPoolFalloff', 0.2, 6, 0.05, 'wash falloff');
    R(sigil, c, 'sigilGrain', 0, 2, 0.01, 'wash grain');
    R(sigil, c, 'sigilGrainScale', 0.2, 10, 0.05, 'grain scale');
    R(sigil, c, 'sigilOpacity', 0, 2, 0.01, 'opacity');
    R(sigil, c, 'sigilGlow', 0, 3, 0.01, 'glow');
    R(sigil, c, 'sigilHeight', 0.005, 0.2, 0.002, 'hover height');
    sigil.addColor(c, 'colorSigil').name('lines');
    sigil.addColor(c, 'colorSigilCore').name('line core');
    sigil.addColor(c, 'colorRune').name('runes');
    sigil.addColor(c, 'colorSigilPool').name('inner wash');
    sigil.addColor(c, 'colorFront').name('growth front');

    /* ---- layer 2 ---- */
    const vines = folder.addFolder('2 · The tendrils');
    R(vines, c, 'vines', 1, 18, 1, 'tendrils (cost)');
    R(vines, c, 'vineSeat', 0.1, 1.3, 0.005, 'where they are planted');
    R(vines, c, 'vineSpread', 0, 3, 0.01, 'bearing scatter');
    R(vines, c, 'vineHeight', 0.5, 10, 0.05, 'height (m)');
    R(vines, c, 'vineHeightJitter', 0, 1.5, 0.01, 'height scatter');
    R(vines, c, 'vineRise', 0.2, 3, 0.01, 'rise curve');
    R(vines, c, 'vineBelly', -0.5, 1.5, 0.01, 'waist bow');
    R(vines, c, 'vineLean', 0, 1.5, 0.01, 'tip lean in');
    R(vines, c, 'vineTwist', -2, 2, 0.01, 'turns climbing');
    R(vines, c, 'vineCurlAt', 0.1, 1, 0.01, 'tip curls from');
    R(vines, c, 'vineCurlTurns', 0, 3, 0.01, 'curl turns');
    R(vines, c, 'vineCurlPinch', 0.05, 1.5, 0.01, 'curl pinch');
    R(vines, c, 'vineCurlLift', -0.3, 0.6, 0.005, 'curl lift');
    R(vines, c, 'vineWander', 0, 2, 0.01, 'wander (m)');
    R(vines, c, 'vineWanderScale', 0.2, 8, 0.05, 'wander scale');
    R(vines, c, 'vineSway', 0, 0.5, 0.005, 'live sway (m)');
    R(vines, c, 'vineSwaySpeed', 0, 4, 0.01, 'sway speed');
    R(vines, c, 'vineThick', 0.01, 0.4, 0.002, 'stem radius (m)');
    R(vines, c, 'vineTaper', 0.02, 1, 0.01, 'tip taper');
    R(vines, c, 'vineKnots', 0, 1, 0.01, 'knots');
    R(vines, c, 'vineKnotScale', 1, 30, 0.5, 'knot scale');

    const bark = vines.addFolder('The bark');
    R(bark, c, 'barkScale', 0.5, 20, 0.1, 'grain / metre');
    R(bark, c, 'barkContrast', 0.2, 4, 0.01, 'grain contrast');
    R(bark, c, 'barkFibre', 0, 2, 0.01, 'fibres');
    R(bark, c, 'barkFibreBands', 0.5, 12, 0.1, 'fibres around');
    R(bark, c, 'barkFibreScale', 2, 80, 0.5, 'fibres along');
    R(bark, c, 'barkRoughness', 0.05, 1, 0.01, 'roughness');
    R(bark, c, 'barkEnv', 0, 2, 0.01, 'env (IBL)');
    R(bark, c, 'seamWidth', 0.01, 0.4, 0.005, 'seam width');
    R(bark, c, 'seamBands', 0.5, 10, 0.05, 'seams around');
    R(bark, c, 'seamScale', 0.5, 20, 0.1, 'seams along');
    R(bark, c, 'seamFlow', -2, 2, 0.01, 'seam crawl');
    R(bark, c, 'seamGlow', 0, 8, 0.01, 'seam glow');
    R(bark, c, 'sapPulse', 0, 6, 0.01, 'sap pulse');
    R(bark, c, 'sapSpeed', 0, 3, 0.01, 'sap speed');
    R(bark, c, 'sapWidth', 0.01, 0.6, 0.005, 'sap width');
    R(bark, c, 'frontGlow', 0, 12, 0.05, 'growing tip');
    R(bark, c, 'frontWidth', 0.01, 0.4, 0.005, 'tip width');
    R(bark, c, 'vineRim', 0, 3, 0.01, 'rim light');
    R(bark, c, 'vineRimPower', 0.2, 8, 0.05, 'rim falloff');
    R(bark, c, 'vineGlow', 0, 3, 0.01, 'glow');
    R(bark, c, 'witherRise', 0, 1, 0.01, 'wither follows height');
    R(bark, c, 'witherScale', 0.2, 12, 0.05, 'wither scale');
    R(bark, c, 'witherEdge', 0.01, 0.6, 0.005, 'wither edge');
    R(bark, c, 'witherEdgeGlow', 0, 12, 0.05, 'wither edge glow');
    bark.addColor(c, 'colorBark').name('bark');
    bark.addColor(c, 'colorBarkLight').name('bark light');
    bark.addColor(c, 'colorSeam').name('seam');
    bark.addColor(c, 'colorSeamCore').name('seam core');
    bark.addColor(c, 'colorWither').name('wither ember');

    /* ---- layer 3 ---- */
    const leaves = folder.addFolder('3 · The foliage');
    R(leaves, c, 'leaves', 0, 340, 1, 'leaves (cost)');
    R(leaves, c, 'leafStart', 0, 1, 0.01, 'first leaf at');
    R(leaves, c, 'leafEnd', 0, 1, 0.01, 'last leaf at');
    R(leaves, c, 'leafSize', 0.05, 1.5, 0.005, 'length (m)');
    R(leaves, c, 'leafSizeJitter', 0, 1.5, 0.01, 'size scatter');
    R(leaves, c, 'leafAspect', 0.1, 1.2, 0.01, 'width / length');
    R(leaves, c, 'leafBias', 0.2, 2, 0.01, 'widest point');
    R(leaves, c, 'leafPoint', 0.2, 2, 0.01, 'how pointed');
    R(leaves, c, 'leafPitch', -1.5, 1.5, 0.01, 'stalk pitch');
    R(leaves, c, 'leafPitchJitter', 0, 3, 0.01, 'pitch scatter');
    R(leaves, c, 'leafDroop', 0, 1.5, 0.01, 'droop');
    R(leaves, c, 'leafCup', -0.6, 0.6, 0.01, 'cup');
    R(leaves, c, 'leafOpen', 0.01, 0.5, 0.005, 'unfurl window');
    R(leaves, c, 'leafFlutter', 0, 0.6, 0.005, 'flutter');
    R(leaves, c, 'leafFlutterSpeed', 0, 6, 0.01, 'flutter speed');
    R(leaves, c, 'leafVeins', 1, 20, 1, 'laterals');
    R(leaves, c, 'leafVeinWidth', 0.01, 0.4, 0.005, 'lateral width');
    R(leaves, c, 'leafVeinSkew', 0, 2, 0.01, 'lateral skew');
    R(leaves, c, 'leafRibWidth', 0.01, 0.4, 0.005, 'midrib width');
    R(leaves, c, 'leafVeinGlow', 0, 6, 0.01, 'vein glow');
    R(leaves, c, 'leafTranslucency', 0, 4, 0.01, 'light through it');
    R(leaves, c, 'leafSheen', 0, 2, 0.01, 'cuticle sheen');
    R(leaves, c, 'leafMottle', 0, 1.5, 0.01, 'mottle');
    R(leaves, c, 'leafRoughness', 0.05, 1, 0.01, 'roughness');
    R(leaves, c, 'leafEnv', 0, 2, 0.01, 'env (IBL)');
    R(leaves, c, 'leafGlow', 0, 3, 0.01, 'glow');
    leaves.addColor(c, 'colorLeaf').name('blade');
    leaves.addColor(c, 'colorLeafTip').name('tip');
    leaves.addColor(c, 'colorLeafDeep').name('base');
    leaves.addColor(c, 'colorLeafVein').name('veins');

    /* ---- layer 4 ---- */
    const bloom = folder.addFolder('4 · The arcane bloom');
    R(bloom, c, 'bloomHeight', 0.5, 10, 0.05, 'height (m)');
    R(bloom, c, 'bloomRise', 0, 4, 0.05, 'rise while opening');
    R(bloom, c, 'bloomScale', 0.2, 4, 0.01, 'size');
    R(bloom, c, 'bloomSpin', -0.1, 0.1, 0.001, 'whorl spin');
    R(bloom, c, 'bloomBob', 0, 0.4, 0.005, 'breathing (m)');
    R(bloom, c, 'bloomBobSpeed', 0, 3, 0.01, 'breathing speed');
    R(bloom, c, 'bloomStand', 0, 1, 0.01, 'standing (0 flat)');
    R(bloom, c, 'bloomAimPitch', 0, 1, 0.01, 'tip onto target');
    R(bloom, c, 'bloomTurnRate', 0.5, 20, 0.1, 'turn rate (rad/s)');

    const whorls = bloom.addFolder('The whorls');
    R(whorls, c, 'whorlOuter', 1, 16, 1, 'outer petals');
    R(whorls, c, 'whorlMid', 1, 14, 1, 'middle petals');
    R(whorls, c, 'whorlInner', 1, 12, 1, 'inner petals');
    R(whorls, c, 'petalLengthOuter', 0.1, 2, 0.01, 'outer length');
    R(whorls, c, 'petalLengthMid', 0.1, 2, 0.01, 'middle length');
    R(whorls, c, 'petalLengthInner', 0.1, 2, 0.01, 'inner length');
    R(whorls, c, 'petalPitchOuter', 0, 2.4, 0.01, 'outer pitch');
    R(whorls, c, 'petalPitchMid', 0, 2.4, 0.01, 'middle pitch');
    R(whorls, c, 'petalPitchInner', 0, 2.4, 0.01, 'inner pitch');
    R(whorls, c, 'petalCurveOuter', -1.5, 1.5, 0.01, 'outer curve');
    R(whorls, c, 'petalCurveMid', -1.5, 1.5, 0.01, 'middle curve');
    R(whorls, c, 'petalCurveInner', -1.5, 1.5, 0.01, 'inner curve');
    R(whorls, c, 'petalWidthOuter', 0.05, 1, 0.01, 'outer width');
    R(whorls, c, 'petalWidthMid', 0.05, 1, 0.01, 'middle width');
    R(whorls, c, 'petalWidthInner', 0.05, 1, 0.01, 'inner width');
    R(whorls, c, 'petalLiftOuter', -0.5, 0.5, 0.005, 'outer seat');
    R(whorls, c, 'petalLiftMid', -0.5, 0.5, 0.005, 'middle seat');
    R(whorls, c, 'petalLiftInner', -0.5, 0.5, 0.005, 'inner seat');
    R(whorls, c, 'petalRoll', 0, 1.6, 0.01, 'whorl offset');
    R(whorls, c, 'petalPitchClosed', 0, 1, 0.01, 'bud pitch');
    R(whorls, c, 'petalBudLength', 0.05, 1, 0.01, 'bud length');
    R(whorls, c, 'petalOpenStagger', 0, 0.6, 0.01, 'whorl-to-whorl lag');
    R(whorls, c, 'petalWidthBias', 0.2, 2, 0.01, 'widest point');
    R(whorls, c, 'petalWidthPoint', 0.2, 2, 0.01, 'how pointed');
    R(whorls, c, 'petalCup', -0.6, 0.8, 0.01, 'cup');
    R(whorls, c, 'petalTwist', -1, 1, 0.01, 'spine twist');
    R(whorls, c, 'petalJitter', 0, 0.6, 0.01, 'angular scatter');

    const petalLook = bloom.addFolder('The petals');
    R(petalLook, c, 'petalMargin', 0, 0.8, 0.01, 'pale margin');
    R(petalLook, c, 'petalMarginGlow', 0, 4, 0.01, 'margin glow');
    R(petalLook, c, 'petalVeins', 1, 20, 1, 'laterals');
    R(petalLook, c, 'petalVeinWidth', 0.01, 0.4, 0.005, 'lateral width');
    R(petalLook, c, 'petalVeinSkew', 0, 2, 0.01, 'lateral skew');
    R(petalLook, c, 'petalRibWidth', 0.01, 0.3, 0.005, 'midrib width');
    R(petalLook, c, 'petalVeinGlow', 0, 6, 0.01, 'vein glow');
    R(petalLook, c, 'petalTipGlow', 0, 4, 0.01, 'tip glow');
    R(petalLook, c, 'petalChargeGain', 0, 6, 0.01, 'tips on charge');
    R(petalLook, c, 'petalTranslucency', 0, 4, 0.01, 'light through it');
    R(petalLook, c, 'petalRim', 0, 3, 0.01, 'rim light');
    R(petalLook, c, 'petalRimPower', 0.2, 8, 0.05, 'rim falloff');
    R(petalLook, c, 'petalShimmer', 0, 3, 0.01, 'chrono shimmer');
    R(petalLook, c, 'petalShimmerScale', 0.1, 6, 0.05, 'shimmer scale');
    R(petalLook, c, 'petalShimmerSpeed', -3, 3, 0.01, 'shimmer speed');
    R(petalLook, c, 'petalRoughness', 0.05, 1, 0.01, 'roughness');
    R(petalLook, c, 'petalEnv', 0, 2, 0.01, 'env (IBL)');
    R(petalLook, c, 'petalGlow', 0, 3, 0.01, 'glow');
    petalLook.addColor(c, 'colorPetalOuter').name('outer whorl');
    petalLook.addColor(c, 'colorPetalMid').name('middle whorl');
    petalLook.addColor(c, 'colorPetalInner').name('inner whorl');
    petalLook.addColor(c, 'colorPetalBase').name('petal base');
    petalLook.addColor(c, 'colorPetalMargin').name('margin');
    petalLook.addColor(c, 'colorPetalVein').name('veins');

    const core = bloom.addFolder('The core & halo');
    R(core, c, 'coreSize', 0.05, 1.5, 0.005, 'core radius');
    R(core, c, 'coreSeat', -0.3, 1, 0.01, 'seat up the axis');
    R(core, c, 'coreIntensity', 0, 8, 0.01, 'core intensity');
    R(core, c, 'coreChargeGain', 0, 8, 0.01, 'gain on charge');
    R(core, c, 'coreFill', 0.1, 6, 0.05, 'axis weighting');
    R(core, c, 'coreRim', 0, 3, 0.01, 'rim');
    R(core, c, 'coreRimPower', 0.2, 8, 0.05, 'rim falloff');
    R(core, c, 'coreBoil', 0, 0.6, 0.005, 'silhouette boil');
    R(core, c, 'coreBoilScale', 0.2, 8, 0.05, 'boil scale');
    R(core, c, 'coreFilament', 0, 4, 0.01, 'filaments');
    R(core, c, 'coreFilamentScale', 0.5, 12, 0.05, 'filament scale');
    R(core, c, 'coreFilamentSpeed', -3, 3, 0.01, 'filament speed');
    R(core, c, 'coreBudDim', 0, 1, 0.01, 'dimmed in the bud');
    R(core, c, 'coreSoftFade', 0.05, 2, 0.01, 'soft fade');
    R(core, c, 'haloSize', 0.2, 8, 0.05, 'halo radius');
    R(core, c, 'haloGlow', 0, 3, 0.01, 'halo glow');
    R(core, c, 'haloFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(core, c, 'haloRays', 0, 3, 0.01, 'rays');
    R(core, c, 'haloRayCount', 2, 48, 1, 'ray count');
    R(core, c, 'haloRaySharp', 1, 24, 0.5, 'ray sharpness');
    R(core, c, 'haloRaySpin', -0.3, 0.3, 0.002, 'ray spin');
    R(core, c, 'haloRingInner', 0.05, 1, 0.005, 'inner dial');
    R(core, c, 'haloRingOuter', 0.05, 1, 0.005, 'outer dial');
    R(core, c, 'haloRingWidth', 0.002, 0.08, 0.001, 'dial width');
    R(core, c, 'haloRingSpin', -0.3, 0.3, 0.002, 'dial spin');
    R(core, c, 'haloTicks', 0, 1, 0.01, 'dial graduations');
    R(core, c, 'haloTickCount', 4, 180, 1, 'tick count');
    R(core, c, 'haloTickWidth', 0.05, 0.95, 0.01, 'tick width');
    core.addColor(c, 'colorCore').name('core');
    core.addColor(c, 'colorCoreMid').name('core mid');
    core.addColor(c, 'colorCoreEdge').name('core edge');
    core.addColor(c, 'colorHalo').name('halo');
    core.addColor(c, 'colorHaloRing').name('dials');

    /* ---- layer 5 ---- */
    const motes = folder.addFolder('5 · Motes, pollen & mist');
    R(motes, c, 'moteRate', 0, 400, 1, 'motes / second');
    R(motes, c, 'moteSize', 0.005, 0.3, 0.001, 'mote size');
    R(motes, c, 'moteLifetime', 0.2, 8, 0.05, 'mote lifetime');
    R(motes, c, 'moteSpeed', 0, 6, 0.01, 'mote speed');
    R(motes, c, 'moteRise', -3, 3, 0.01, 'mote rise');
    R(motes, c, 'moteTurbulence', 0, 3, 0.01, 'mote turbulence');
    Editor.gradient(motes, c, 'colorMote', 'Mote gradient');
    R(motes, c, 'pollenRate', 0, 200, 1, 'pollen / second');
    R(motes, c, 'pollenSize', 0.01, 0.5, 0.005, 'pollen size');
    R(motes, c, 'pollenLifetime', 0.2, 12, 0.05, 'pollen lifetime');
    R(motes, c, 'pollenSpeed', 0, 4, 0.01, 'pollen speed');
    R(motes, c, 'pollenRise', -2, 2, 0.01, 'pollen rise');
    Editor.gradient(motes, c, 'colorPollen', 'Pollen gradient');
    R(motes, c, 'mistRate', 0, 200, 1, 'mist / second');
    R(motes, c, 'mistSize', 0.1, 5, 0.05, 'mist size');
    R(motes, c, 'mistLifetime', 0.2, 12, 0.05, 'mist lifetime');
    R(motes, c, 'mistSpeed', 0, 4, 0.01, 'mist speed');
    R(motes, c, 'mistRise', -2, 2, 0.01, 'mist rise');
    R(motes, c, 'mistSpread', 0, 2, 0.01, 'mist spread');
    R(motes, c, 'mistOpacity', 0, 2, 0.01, 'mist opacity');
    Editor.gradient(motes, c, 'colorMist', 'Mist gradient');
    R(motes, c, 'driftRate', 0, 60, 0.5, 'leaves / second');
    R(motes, c, 'driftSize', 0.02, 0.6, 0.005, 'leaf size');
    R(motes, c, 'driftLifetime', 0.2, 12, 0.05, 'leaf lifetime');
    R(motes, c, 'driftSpeed', 0, 6, 0.01, 'leaf speed');
    R(motes, c, 'driftGravity', -8, 2, 0.01, 'leaf gravity');
    R(motes, c, 'driftSpin', 0, 10, 0.05, 'leaf spin');
    Editor.gradient(motes, c, 'colorDrift', 'Leaf gradient');

    const bursts = folder.addFolder('One-shot bursts');
    R(bursts, c, 'seedMotes', 0, 200, 1, 'motes at the hand');
    R(bursts, c, 'creepRate', 0, 200, 1, 'motes off the seed');
    R(bursts, c, 'trailRate', 0.2, 12, 0.05, 'marks / metre');
    R(bursts, c, 'rootMotes', 0, 600, 1, 'motes as it roots');
    R(bursts, c, 'rootLeaves', 0, 200, 1, 'leaves as it roots');
    R(bursts, c, 'rootMist', 0, 200, 1, 'mist as it roots');
    R(bursts, c, 'bloomMotes', 0, 600, 1, 'motes as it opens');
    R(bursts, c, 'bloomPollen', 0, 400, 1, 'pollen as it opens');
    R(bursts, c, 'bloomLeaves', 0, 200, 1, 'leaves as it opens');
    R(bursts, c, 'witherLeaves', 0, 400, 1, 'leaves as it withers');
    R(bursts, c, 'stainRadius', 0.1, 4, 0.01, 'ground mark radius');
    R(bursts, c, 'stainLife', 0.2, 20, 0.05, 'ground mark life');
    R(bursts, c, 'stainIntensity', 0, 3, 0.01, 'ground mark glow');
    bursts.addColor(c, 'colorStain').name('mark');
    bursts.addColor(c, 'colorStainEdge').name('mark edge');

    /* ---- the lance ---- */
    const lance = folder.addFolder('The lance & the cut');
    lance.add(c, 'laserEnabled').name('fires at targets');
    R(lance, c, 'laserRange', 1, 30, 0.1, 'reach (m)');
    R(lance, c, 'laserInterval', 0.05, 4, 0.01, 'seconds between shots');
    R(lance, c, 'laserWarmup', 0.02, 2, 0.01, 'wind-up');
    R(lance, c, 'laserVolley', 1, 6, 1, 'targets per shot');
    R(lance, c, 'laserLife', 0.1, 2, 0.01, 'lance lifetime');
    R(lance, c, 'laserWidth', 0.1, 4, 0.01, 'lance width');
    R(lance, c, 'laserAim', 0.1, 1, 0.01, 'where it lands');
    R(lance, c, 'laserShake', 0, 0.6, 0.005, 'camera knock');
    R(lance, c, 'laserFlash', 0, 1, 0.01, 'flash');
    R(lance, c.laserHit, 'impulse', 0, 20, 0.1, 'throw impulse');
    R(lance, c.laserHit, 'lift', 0, 20, 0.1, 'throw lift');
    R(lance, c.laserHit, 'spin', 0, 5, 0.05, 'throw spin');
    R(lance, c, 'cutLeaves', 0, 200, 1, 'leaves from the wound');
    R(lance, c, 'cutMotes', 0, 400, 1, 'motes from the wound');
    R(lance, c, 'cutSpeed', 0, 20, 0.1, 'wound spray speed');
    R(lance, c, 'cutBurst', 0, 3, 0.01, 'wound shell size');

    const lanceLook = lance.addFolder('How it is drawn');
    R(lanceLook, c, 'lanceRadius', 0.005, 0.5, 0.001, 'radius (m)');
    R(lanceLook, c, 'lanceMuzzleRadius', 0.005, 0.6, 0.001, 'muzzle radius');
    R(lanceLook, c, 'lanceRadiusCurve', 0.05, 4, 0.01, 'radius curve');
    R(lanceLook, c, 'lanceFlare', 0, 3, 0.01, 'flare on impact');
    R(lanceLook, c, 'lanceFlareWidth', 0.01, 0.6, 0.005, 'flare width');
    R(lanceLook, c, 'lanceThrob', 0, 0.8, 0.005, 'throb');
    R(lanceLook, c, 'lanceThrobBands', 0.5, 20, 0.1, 'throb bands');
    R(lanceLook, c, 'lanceThrobSpeed', 0, 10, 0.05, 'throb speed');
    R(lanceLook, c, 'lanceWander', 0, 0.4, 0.005, 'wander (m)');
    R(lanceLook, c, 'lanceWanderScale', 0.5, 16, 0.1, 'wander scale');
    R(lanceLook, c, 'lanceWanderSpeed', 0, 8, 0.05, 'wander speed');
    R(lanceLook, c, 'lanceStrike', 0.02, 0.6, 0.005, 'time spent arriving');
    R(lanceLook, c, 'lanceHold', 0.05, 0.95, 0.01, 'time before it goes');
    R(lanceLook, c, 'lanceCoreFill', 0.2, 8, 0.05, 'axis weighting');
    R(lanceLook, c, 'lanceEdgePower', 0.2, 8, 0.05, 'sheath falloff');
    R(lanceLook, c, 'lanceSheath', 0, 3, 0.01, 'sheath');
    R(lanceLook, c, 'lanceCoils', 1, 6, 1, 'helices');
    R(lanceLook, c, 'lanceCoilTurns', 0, 24, 0.1, 'helix turns');
    R(lanceLook, c, 'lanceCoilSpeed', -6, 6, 0.05, 'helix speed');
    R(lanceLook, c, 'lanceCoilWidth', 0.02, 1, 0.01, 'helix width');
    R(lanceLook, c, 'lanceCoilGain', 0, 4, 0.01, 'helix glow');
    R(lanceLook, c, 'lanceMotes', 0, 4, 0.01, 'motes inside it');
    R(lanceLook, c, 'lanceMoteScale', 1, 40, 0.5, 'mote scale');
    R(lanceLook, c, 'lanceMoteSpeed', 0, 10, 0.05, 'mote speed');
    R(lanceLook, c, 'lanceHeadGlow', 0, 8, 0.05, 'head glow');
    R(lanceLook, c, 'lanceHeadWidth', 0.005, 0.4, 0.005, 'head width');
    R(lanceLook, c, 'lanceIntensity', 0, 8, 0.01, 'intensity');
    R(lanceLook, c, 'lanceOpacity', 0, 2, 0.01, 'opacity');
    R(lanceLook, c, 'lanceSoftFade', 0.05, 2, 0.01, 'soft fade');
    lanceLook.addColor(c, 'colorLanceCore').name('core');
    lanceLook.addColor(c, 'colorLanceInner').name('inner');
    lanceLook.addColor(c, 'colorLanceOuter').name('sheath');
    lanceLook.addColor(c, 'colorLanceCoil').name('helices');

    const cut = lance.addFolder('The body it goes through');
    const s = settings.slice;
    cut.add(s, 'enabled').name('cuts in half');
    R(cut, s, 'height', 0.1, 0.9, 0.01, 'plane height');
    R(cut, s, 'tilt', -45, 45, 0.5, 'plane tilt (deg)');
    R(cut, s, 'separation', 0, 0.5, 0.005, 'parting gap (m)');
    R(cut, s, 'split', 0, 8, 0.05, 'driven apart (m/s)');
    R(cut, s.upper, 'impulse', 0, 2, 0.01, 'top: impulse');
    R(cut, s.upper, 'lift', 0, 2, 0.01, 'top: lift');
    R(cut, s.upper, 'spin', 0, 2, 0.01, 'top: spin');
    R(cut, s.lower, 'impulse', 0, 2, 0.01, 'legs: impulse');
    R(cut, s.lower, 'lift', 0, 2, 0.01, 'legs: lift');
    R(cut, s.lower, 'spin', 0, 2, 0.01, 'legs: spin');
    cut.add(s.collide, 'enabled').name('halves are solid');
    R(cut, s.collide, 'radius', 0.01, 0.4, 0.005, 'contact radius');
    R(cut, s.collide, 'bounce', 0, 1, 0.01, 'bounce');
    R(cut, s.collide, 'friction', 0, 1, 0.01, 'friction');
    R(cut, s.collide, 'maxPush', 0.005, 0.3, 0.005, 'max push / frame');
    R(cut, s, 'interiorEmissive', 0, 3, 0.01, 'interior glow');
    R(cut, s, 'edgeEmissive', 0, 12, 0.05, 'cut edge glow');
    R(cut, s, 'edgeWidth', 0.001, 0.1, 0.001, 'cut edge width');
    cut.addColor(s, 'interiorColor').name('interior');
    cut.addColor(s, 'edgeColor').name('cut edge');

    /* ---- impact, camera & light ---- */
    const impact = folder.addFolder('Impact, camera & light');
    R(impact, c, 'muzzleSize', 0.05, 4, 0.01, 'hand flash size');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'hand flash glow');
    R(impact, c, 'castFlash', 0, 1, 0.01, 'release flash');
    R(impact, c, 'rootBurst', 0.1, 10, 0.05, 'root shell size');
    R(impact, c, 'rootIntensity', 0, 5, 0.01, 'root shell glow');
    R(impact, c, 'rootShake', 0, 1, 0.005, 'root shake');
    R(impact, c, 'shakeDuration', 0.05, 2, 0.01, 'shake decay');
    R(impact, c, 'bloomShake', 0, 1, 0.005, 'bloom shake');
    R(impact, c, 'bloomFlash', 0, 2, 0.01, 'bloom flash');
    R(impact, c, 'holdShake', 0, 0.3, 0.002, 'hold rumble');
    R(impact, c, 'rumble', 0, 0.3, 0.002, 'seed rumble');
    impact.addColor(c, 'colorBurstA').name('shell inner');
    impact.addColor(c, 'colorBurstB').name('shell mid');
    impact.addColor(c, 'colorBurstC').name('shell outer');
    impact.addColor(c, 'colorCastFlash').name('release flash');
    impact.addColor(c, 'colorFlash').name('bloom flash');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 160, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 60, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 1, 0.01, 'height toward the bloom');
    R(light, c, 'lightPulse', 0, 1, 0.01, 'owned by the breath');
    light.addColor(c, 'lightColor').name('light colour');

    this.growthFolder = folder;
  }

  /**
   * The Cyber Serpent, grouped by the five layers of its breakdown.
   *
   * Two units are in play and mixing them up is the only way to get lost here:
   * anything about the **body** is a fraction of its own length (so lengthening
   * the animal does not re-tune its swim), and anything about the **ribbons** or
   * the **board** is in metres, because those are laid out against the cast.
   *
   * `ghosts` and `trails` are the performance dials, and both are live sliders:
   * the same build has to run on a laptop and on the machine driving the
   * projector.
   */
  _buildCyber() {
    const folder = this.gui.addFolder('⛓  Cyber Serpent');
    const c = settings.cyber;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'speed', 4, 90, 0.5, 'flight speed (m/s)');
    R(cast, c, 'shatterTime', 0.1, 3, 0.01, 'shatter over');
    R(cast, c, 'fadeTime', 0.1, 4, 0.01, 'debris fades over');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const flight = folder.addFolder('The flight & the swim');
    R(flight, c, 'bodyLength', 1, 12, 0.05, 'body length (m)');
    R(flight, c, 'launchHeight', 0.2, 3, 0.01, 'launch height (m)');
    R(flight, c, 'flightHeight', 0.2, 6, 0.01, 'cruise height (m)');
    R(flight, c, 'riseDistance', 0.5, 20, 0.1, 'settles over (m)');
    R(flight, c, 'bob', 0, 1, 0.005, 'ride (m)');
    R(flight, c, 'bobSpeed', 0, 4, 0.01, 'ride speed');
    R(flight, c, 'formTime', 0.02, 2, 0.01, 'body assembles over');
    R(flight, c, 'sway', 0, 0.4, 0.001, 'tail throw (× body)');
    R(flight, c, 'swayWaves', 0.2, 5, 0.01, 'waves along the body');
    R(flight, c, 'swaySpeed', 0, 6, 0.01, 'strokes/second');
    R(flight, c, 'swayRoot', 0, 1, 0.01, 'how much the nose moves');
    R(flight, c, 'swayPitch', 0, 2, 0.01, 'vertical wave');
    R(flight, c, 'swayPitchWaves', 0.2, 5, 0.01, 'its wavelength');
    R(flight, c, 'bank', 0, 1.4, 0.01, 'bank into the stroke (rad)');

    /* ---- layer 1 ---- */
    const wire = folder.addFolder('1 · The wireframe');
    R(wire, c, 'wireWidth', 0.1, 4, 0.05, 'edge width (px)');
    R(wire, c, 'wireFloor', 0.2, 12, 0.1, 'smallest facet (px)');
    R(wire, c, 'wireSolid', 0, 2, 0.01, 'dense facets glow');
    R(wire, c, 'wireGain', 0, 6, 0.01, 'edge glow');
    R(wire, c, 'wireHalo', 0.2, 20, 0.1, 'edge bleed (px)');
    R(wire, c, 'wireHaloGain', 0, 4, 0.01, 'bleed glow');
    R(wire, c, 'facetFill', 0, 0.6, 0.005, 'interior fill');
    R(wire, c, 'facetRim', 0, 3, 0.01, 'silhouette rim');
    R(wire, c, 'facetPower', 0.5, 8, 0.05, 'rim tightness');
    R(wire, c, 'scanDepth', 0, 1, 0.01, 'scan lines');
    R(wire, c, 'scanFreq', 2, 120, 0.5, 'bands over the body');
    R(wire, c, 'scanSpeed', -10, 10, 0.05, 'band speed');
    R(wire, c, 'pulse', 0, 5, 0.01, 'charge along the mesh');
    R(wire, c, 'pulseFreq', 0.2, 10, 0.05, 'charges over the body');
    R(wire, c, 'pulseSpeed', -6, 6, 0.05, 'charge speed');
    R(wire, c, 'pulseSharp', 1, 20, 0.1, 'charge sharpness');
    R(wire, c, 'glitch', 0, 0.3, 0.001, 'facets misfiring');
    R(wire, c, 'glitchRate', 1, 60, 0.5, 'misfires/second');
    R(wire, c, 'glitchGain', 0, 8, 0.05, 'misfire glow');
    R(wire, c, 'headHeat', 0, 4, 0.01, 'nose heat');
    R(wire, c, 'headLength', 0.01, 0.6, 0.005, 'nose length');
    R(wire, c, 'formEdge', 0.005, 0.4, 0.005, 'assembly edge');
    R(wire, c, 'formRough', 0, 0.5, 0.005, 'assembly raggedness');
    R(wire, c, 'formGlow', 0, 8, 0.05, 'assembly glow');
    R(wire, c, 'wireIntensity', 0, 8, 0.01, 'intensity');
    R(wire, c, 'wireOpacity', 0, 2, 0.01, 'opacity');
    R(wire, c, 'softFade', 0.02, 3, 0.01, 'soft fade (m)');
    wire.addColor(c, 'colorWire').name('wire');
    wire.addColor(c, 'colorHot').name('hot');
    wire.addColor(c, 'colorFacet').name('interior');

    /* ---- layer 2 ---- */
    const fill = folder.addFolder('2 · The energy fill');
    R(fill, c, 'fillInflate', 0, 0.08, 0.001, 'inflate (× body)');
    R(fill, c, 'fillCore', 0.2, 8, 0.05, 'volume weighting');
    R(fill, c, 'cloudDepth', 0, 1, 0.01, 'cloud depth');
    R(fill, c, 'cloudScale', 0.5, 24, 0.1, 'cloud scale');
    R(fill, c, 'cloudFlow', -6, 6, 0.05, 'cloud flow');
    R(fill, c, 'fillIntensity', 0, 6, 0.01, 'intensity');
    R(fill, c, 'fillOpacity', 0, 2, 0.01, 'opacity');
    fill.addColor(c, 'colorFillCore').name('core');
    fill.addColor(c, 'colorFillEdge').name('edge');
    R(fill, c, 'auraInflate', 0, 0.2, 0.001, 'aura inflate (× body)');
    R(fill, c, 'auraRim', 0.5, 8, 0.05, 'aura tightness');
    R(fill, c, 'auraBreak', 0, 1, 0.01, 'aura break-up');
    R(fill, c, 'auraIntensity', 0, 6, 0.01, 'aura intensity');
    R(fill, c, 'auraOpacity', 0, 2, 0.01, 'aura opacity');
    fill.addColor(c, 'colorAura').name('aura');

    /* ---- layer 3 ---- */
    const trails = folder.addFolder('3 · The ribbons');
    R(trails, c, 'trails', 1, 8, 1, 'strands');
    R(trails, c, 'trailLength', 1, 30, 0.1, 'reach back (m)');
    R(trails, c, 'trailTurns', 0, 8, 0.05, 'turns over that');
    R(trails, c, 'trailSpin', -3, 3, 0.01, 'roll (turns/s)');
    R(trails, c, 'trailRadius', 0.05, 4, 0.01, 'orbit radius (m)');
    R(trails, c, 'trailSwell', 0.1, 3, 0.01, 'where it is fattest');
    R(trails, c, 'trailWidth', 0.005, 0.5, 0.001, 'width (m)');
    R(trails, c, 'trailWidthTip', 0, 4, 0.01, 'width at the tail');
    R(trails, c, 'trailSharp', 0.2, 8, 0.05, 'edge falloff');
    R(trails, c, 'trailCore', 1, 40, 0.5, 'core thread');
    R(trails, c, 'trailPulse', 0, 5, 0.01, 'charge along it');
    R(trails, c, 'trailPulseFreq', 0.2, 10, 0.05, 'charges over it');
    R(trails, c, 'trailPulseSpeed', -6, 6, 0.05, 'charge speed');
    R(trails, c, 'trailFlicker', 0, 1, 0.01, 'stutter');
    R(trails, c, 'trailFlickerScale', 0.5, 20, 0.1, 'stutter scale');
    R(trails, c, 'trailFlickerSpeed', 0, 8, 0.05, 'stutter speed');
    R(trails, c, 'trailWander', 0, 1.5, 0.01, 'wander (m)');
    R(trails, c, 'trailWanderScale', 0.2, 8, 0.05, 'wander scale');
    R(trails, c, 'trailWanderSpeed', 0, 4, 0.01, 'wander speed');
    R(trails, c, 'trailIntensity', 0, 8, 0.01, 'intensity');
    R(trails, c, 'trailOpacity', 0, 2, 0.01, 'opacity');
    R(trails, c, 'trailSoftFade', 0.02, 3, 0.01, 'soft fade (m)');
    trails.addColor(c, 'colorTrailCore').name('core');
    trails.addColor(c, 'colorTrail').name('body');
    trails.addColor(c, 'colorTrailTail').name('tail');

    /* ---- layer 4 ---- */
    const wake = folder.addFolder('4 · The wake');
    R(wake, c, 'ghosts', 1, 8, 1, 'lagged copies');
    R(wake, c, 'ghostLag', 0, 0.8, 0.005, 'spacing (× body)');
    R(wake, c, 'ghostTimeLag', 0, 0.25, 0.001, 'pose lag (s)');
    R(wake, c, 'ghostInflate', 0, 0.1, 0.001, 'swell each (× body)');
    R(wake, c, 'ghostFade', 0.05, 0.98, 0.01, 'dimmer each');
    R(wake, c, 'ghostErode', 0, 1, 0.01, 'eaten into vapour');
    R(wake, c, 'ghostErodeScale', 0.1, 6, 0.05, 'vapour scale');
    R(wake, c, 'ghostIntensity', 0, 6, 0.01, 'intensity');
    R(wake, c, 'ghostOpacity', 0, 2, 0.01, 'opacity');
    wake.addColor(c, 'colorGhost').name('ghost');
    R(wake, c, 'wakeRate', 0, 200, 1, 'vapour/second');
    R(wake, c, 'wakeSize', 0.05, 4, 0.01, 'vapour size');
    R(wake, c, 'wakeLifetime', 0.1, 6, 0.05, 'vapour lifetime');
    R(wake, c, 'wakeSpeed', 0, 8, 0.05, 'vapour speed');
    R(wake, c, 'wakeRise', -2, 3, 0.01, 'vapour rise');
    R(wake, c, 'wakeOpacity', 0, 1.5, 0.01, 'vapour opacity');
    R(wake, c, 'wakeTurbulence', 0, 3, 0.01, 'vapour turbulence');
    Editor.gradient(wake, c, 'colorWake', 'vapour gradient');

    /* ---- layer 5 ---- */
    const runes = folder.addFolder('5 · The rune board');
    R(runes, c, 'runeWidth', 0.3, 12, 0.05, 'half-width (m)');
    R(runes, c, 'runeOverrun', 0, 10, 0.1, 'runs past impact (m)');
    R(runes, c, 'runeHeight', 0.002, 0.2, 0.002, 'hover (m)');
    R(runes, c, 'runeCell', 0.15, 3, 0.01, 'routing grid (m)');
    R(runes, c, 'runeDensity', 0.05, 1, 0.01, 'trace density');
    R(runes, c, 'runeJitter', 0, 0.9, 0.01, 'routing jitter');
    R(runes, c, 'runeTrace', 0.004, 0.12, 0.001, 'trace width (m)');
    R(runes, c, 'runePad', 0.02, 0.4, 0.005, 'pad radius (m)');
    R(runes, c, 'runeVia', 0.005, 0.2, 0.005, 'via radius (m)');
    R(runes, c, 'runeLead', 0, 8, 0.05, 'pre-charge ahead (m)');
    R(runes, c, 'runeDecay', 0.01, 1.5, 0.005, 'cools behind (1/m)');
    R(runes, c, 'runeBase', 0, 0.6, 0.005, 'unlit trace');
    R(runes, c, 'runeGlow', 0, 6, 0.01, 'lit glow');
    R(runes, c, 'runeBlip', 0, 8, 0.05, 'data blips');
    R(runes, c, 'runeBlipFreq', 0.05, 3, 0.01, 'blips per metre');
    R(runes, c, 'runeBlipSpeed', -12, 12, 0.1, 'blip speed');
    R(runes, c, 'runeUnder', 0, 3, 0.01, 'light pool');
    R(runes, c, 'runeUnderLong', 0.2, 12, 0.05, 'pool length (m)');
    R(runes, c, 'runeUnderWide', 0.2, 8, 0.05, 'pool width (m)');
    R(runes, c, 'runeBlastSpeed', 1, 60, 0.5, 'shock ring (m/s)');
    R(runes, c, 'runeBlastLife', 0.1, 4, 0.05, 'shock ring lasts');
    R(runes, c, 'runeBlastWidth', 0.05, 2, 0.01, 'shock ring width (m)');
    R(runes, c, 'runeBlastGain', 0, 8, 0.05, 'shock ring glow');
    R(runes, c, 'runeIntensity', 0, 8, 0.01, 'intensity');
    R(runes, c, 'runeOpacity', 0, 2, 0.01, 'opacity');
    runes.addColor(c, 'colorRune').name('unlit trace');
    runes.addColor(c, 'colorRuneLive').name('live trace');
    runes.addColor(c, 'colorRuneHot').name('blip');
    runes.addColor(c, 'colorRuneUnder').name('light pool');

    /* ---- the spray ---- */
    const spray = folder.addFolder('Motes, sparks & the air');
    R(spray, c, 'moteRate', 0, 400, 1, 'motes/second');
    R(spray, c, 'moteSize', 0.005, 0.4, 0.005, 'mote size');
    R(spray, c, 'moteLifetime', 0.05, 4, 0.01, 'mote lifetime');
    R(spray, c, 'moteSpeed', 0, 8, 0.05, 'mote speed');
    R(spray, c, 'moteRise', -3, 3, 0.01, 'mote rise');
    R(spray, c, 'moteDrift', 0, 3, 0.01, 'left behind');
    R(spray, c, 'moteTurbulence', 0, 3, 0.01, 'mote turbulence');
    R(spray, c, 'moteGlow', 0, 4, 0.01, 'mote glow');
    Editor.gradient(spray, c, 'colorMote', 'mote gradient');
    R(spray, c, 'sparkRate', 0, 300, 1, 'sparks/second');
    R(spray, c, 'sparkSize', 0.005, 0.4, 0.005, 'spark size');
    R(spray, c, 'sparkLifetime', 0.05, 3, 0.01, 'spark lifetime');
    R(spray, c, 'sparkSpeed', 0, 20, 0.1, 'spark speed');
    R(spray, c, 'sparkGravity', -20, 5, 0.1, 'spark gravity');
    R(spray, c, 'sparkStretch', 0, 2, 0.01, 'spark stretch');
    R(spray, c, 'sparkGlow', 0, 4, 0.01, 'spark glow');
    R(spray, c, 'groundSparkRate', 0, 20, 0.1, 'floor bursts per metre');
    R(spray, c, 'groundSparks', 0, 40, 1, 'sparks in each');
    Editor.gradient(spray, c, 'colorSpark', 'spark gradient');
    R(spray, c, 'warpStrength', 0, 3, 0.01, 'air warp');
    R(spray, c, 'warpInflate', 0, 0.3, 0.005, 'warp shell (× body)');
    R(spray, c, 'warpScale', 0.1, 6, 0.05, 'warp scale');
    R(spray, c, 'warpSpeed', 0, 6, 0.05, 'warp speed');

    /* ---- the strike ---- */
    const strike = folder.addFolder('The strike, camera & light');
    R(strike, c, 'shatterSpread', 0, 1.5, 0.005, 'fragments thrown (× body)');
    R(strike, c, 'shatterSpin', 0, 6, 0.05, 'fragment spin');
    R(strike, c, 'shatterStagger', 0, 0.95, 0.01, 'tail lets go later');
    R(strike, c, 'burstSize', 0.2, 12, 0.05, 'shell size');
    R(strike, c, 'burstIntensity', 0, 5, 0.01, 'shell glow');
    R(strike, c, 'burstSparks', 0, 400, 1, 'burst sparks');
    R(strike, c, 'burstMotes', 0, 400, 1, 'burst motes');
    R(strike, c, 'shockRadius', 0.5, 16, 0.05, 'shock ring (m)');
    R(strike, c, 'arcRadius', 0.5, 16, 0.05, 'arc burn (m)');
    R(strike, c, 'arcIntensity', 0, 4, 0.01, 'arc glow');
    R(strike, c, 'arcLife', 0.1, 6, 0.05, 'arc lasts');
    R(strike, c, 'castBurst', 0.1, 6, 0.05, 'launch shell');
    R(strike, c, 'castBurstGlow', 0, 5, 0.01, 'launch shell glow');
    R(strike, c, 'castSparks', 0, 300, 1, 'launch sparks');
    R(strike, c, 'castFlash', 0, 1, 0.01, 'launch flash');
    R(strike, c, 'impactFlash', 0, 1, 0.01, 'impact flash');
    R(strike, c, 'impactShake', 0, 1, 0.005, 'impact shake');
    R(strike, c, 'shakeDuration', 0.05, 2, 0.01, 'shake decay');
    R(strike, c, 'rumble', 0, 0.3, 0.002, 'flight rumble');
    R(strike, c, 'burnShake', 0, 0.3, 0.002, 'shatter rumble');
    strike.addColor(c, 'colorBurstA').name('shell inner');
    strike.addColor(c, 'colorBurstB').name('shell mid');
    strike.addColor(c, 'colorBurstC').name('shell outer');
    strike.addColor(c, 'colorShockA').name('shock inner');
    strike.addColor(c, 'colorShockB').name('shock outer');
    strike.addColor(c, 'colorArcA').name('arc burn');
    strike.addColor(c, 'colorArcB').name('arc glow');
    strike.addColor(c, 'colorCastFlash').name('launch flash');
    strike.addColor(c, 'colorFlash').name('impact flash');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 160, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 60, 0.1, 'light radius');
    R(light, c, 'lightPulse', 0, 1, 0.01, 'step depth');
    R(light, c, 'lightPulseSpeed', 1, 40, 0.5, 'steps/second');
    light.addColor(c, 'lightColor').name('light colour');

    this.cyberFolder = folder;
  }

  /**
   * The Venom Surge, grouped by the five panels of its breakdown sheet.
   *
   * The folder names are the panel names on purpose. Judging a stacked effect
   * means being able to look at one layer at a time, and the fastest way to do
   * that here is to walk down this folder zeroing `gasOpacity`, `dropSize`,
   * `seamGlow` and `coreOpacity` in turn — each one takes exactly one panel of
   * the reference out of the frame.
   *
   * Two units are in play. Anything about the **cast** is in metres; anything
   * named `slab*` is a fraction of the plate's own radius, because the Voronoi
   * is cut in unit space and scaled by one number. Mixing them up is the only
   * way to get lost in here.
   */
  _buildVenom() {
    const folder = this.gui.addFolder('☣  Crystallized Venom Surge');
    const c = settings.venom;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'speed', 4, 90, 0.5, 'seam speed (m/s)');
    R(cast, c, 'lifetime', 0.2, 12, 0.05, 'cluster stands for');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    /* ---- panel 1 ---- */
    const gems = folder.addFolder('1 · Crystals');

    const seam = gems.addFolder('The seam');
    R(seam, c, 'widthNear', 0.05, 6, 0.01, 'half-width at the caster (m)');
    R(seam, c, 'width', 0.1, 10, 0.01, 'half-width at the end (m)');
    R(seam, c, 'widthCurve', 0.2, 4, 0.01, 'how late it flares');
    R(seam, c, 'gemCount', 8, 336, 1, 'gems per cast');
    R(seam, c, 'density', 0.05, 1.5, 0.01, 'density');
    R(seam, c, 'burstShare', 0, 0.9, 0.01, 'held back for the starburst');
    R(seam, c, 'clumping', 0.3, 4, 0.01, 'pull toward the centre line');
    R(seam, c, 'scatter', 0, 2, 0.01, 'lateral jitter');
    R(seam, c, 'frontBias', 0.2, 3, 0.01, 'crowd toward the impact');
    R(seam, c, 'heightNear', 0.05, 4, 0.01, 'height at the caster (m)');
    R(seam, c, 'height', 0.1, 10, 0.05, 'height at the end (m)');
    R(seam, c, 'heightCurve', 0.2, 5, 0.01, 'how late it climbs');
    R(seam, c, 'peak', 0.5, 3, 0.01, 'swell at the impact');
    R(seam, c, 'peakWidth', 0.02, 1, 0.01, 'how far that swell reaches');
    R(seam, c, 'rubble', 0, 1, 0.01, 'fraction that are shards');
    R(seam, c, 'lean', 0, 1.4, 0.01, 'lean away from the caster (rad)');

    const burst = gems.addFolder('The starburst');
    R(burst, c, 'burstRadius', 0.2, 10, 0.05, 'cluster radius (m)');
    R(burst, c, 'burstHeight', 0.2, 12, 0.05, 'height at its centre (m)');
    R(burst, c, 'crown', 0, 1, 0.01, 'how much shorter the skirt is');
    R(burst, c, 'burstLean', 0, 1.6, 0.01, 'rim lean outward (rad)');
    R(burst, c, 'burstLeanCurve', 0.2, 3, 0.01, 'how early the lean starts');
    R(burst, c, 'spearShare', 0, 0.6, 0.01, 'fraction that are spears');
    R(burst, c, 'spearScale', 1, 4, 0.05, 'spear height');
    R(burst, c, 'spearSlim', 0.2, 1.5, 0.01, 'spear slenderness');
    R(burst, c, 'shardShare', 0, 0.8, 0.01, 'fraction that are skirt shards');
    R(burst, c, 'shardScale', 0.05, 1, 0.01, 'shard height');
    R(burst, c, 'burstStagger', 0, 1, 0.01, 'rim lags the middle by');

    const shape = gems.addFolder('One gem');
    R(shape, c, 'radius', 0.02, 1.5, 0.005, 'base radius (m)');
    R(shape, c, 'radiusJitter', 0, 2, 0.01, 'radius jitter');
    R(shape, c, 'heightJitter', 0, 2, 0.01, 'height jitter');
    R(shape, c, 'leanJitter', 0, 3, 0.01, 'lean jitter');
    R(shape, c, 'taper', 0.01, 0.6, 0.005, 'tip radius (× base)');
    R(shape, c, 'facets', 3, 12, 1, 'facets');
    R(shape, c, 'gemRough', 0, 0.8, 0.005, 'facet roughness');
    R(shape, c, 'bend', 0, 1.2, 0.005, 'bend to the tip');
    R(shape, c, 'twist', 0, 1, 0.01, 'random yaw');

    const rise = gems.addFolder('The eruption');
    R(rise, c, 'riseTime', 0.02, 1.2, 0.005, 'rise time');
    R(rise, c, 'riseOvershoot', 0, 1, 0.005, 'punch past full height');
    R(rise, c, 'riseStagger', 0, 1, 0.005, 'stagger between neighbours');
    R(rise, c, 'settle', 0.05, 2, 0.01, 'drop back onto seat (s)');
    R(rise, c, 'shatterDelay', 0, 3, 0.01, 'wait before they let go');
    R(rise, c, 'sinkTime', 0.1, 4, 0.01, 'withdraw over');

    const stone = gems.addFolder('The amethyst');
    R(stone, c, 'gemOpacity', 0, 1, 0.01, 'opacity');
    R(stone, c, 'gemRoughness', 0, 1, 0.01, 'surface roughness');
    R(stone, c, 'depthTint', 0, 4, 0.01, 'thickness tint');
    R(stone, c, 'fresnel', 0, 6, 0.01, 'fresnel');
    R(stone, c, 'fresnelPower', 0.5, 8, 0.05, 'fresnel tightness');
    R(stone, c, 'dispersion', 0, 2, 0.01, 'edge dispersion');
    R(stone, c, 'facetSharp', 0, 1.5, 0.01, 'facet contrast');
    R(stone, c, 'cleave', 0, 2, 0.01, 'internal fracture');
    R(stone, c, 'cleaveScale', 0.5, 24, 0.1, 'fracture scale');
    R(stone, c, 'venomGlow', 0, 6, 0.01, 'venom brightness');
    R(stone, c, 'venomScale', 0.2, 14, 0.05, 'venom scale');
    R(stone, c, 'venomFlow', -3, 3, 0.01, 'venom drift');
    R(stone, c, 'venomBase', 0, 2, 0.01, 'how much survives at the tip');
    R(stone, c, 'venomSharp', 0.5, 10, 0.05, 'threads vs wash');
    R(stone, c, 'tipFrost', 0, 1.5, 0.01, 'frosted tip');
    R(stone, c, 'tipStart', 0, 1, 0.01, 'where the frost begins');
    R(stone, c, 'glint', 0, 4, 0.01, 'surface glints');
    R(stone, c, 'glintScale', 4, 90, 0.5, 'glint scale');
    R(stone, c, 'glintSpeed', 0, 4, 0.01, 'glint speed');
    R(stone, c, 'gemGlow', 0, 4, 0.01, 'emissive gain');
    R(stone, c, 'edgeGlow', 0, 4, 0.01, 'silhouette rim');
    R(stone, c, 'birthGlow', 0, 8, 0.05, 'birth flash');
    R(stone, c, 'birthFade', 0.02, 2, 0.01, 'birth flash lasts');
    R(stone, c, 'envIntensity', 0, 3, 0.01, 'probe reflection');
    stone.addColor(c, 'colorDeep').name('deep');
    stone.addColor(c, 'colorGem').name('body');
    stone.addColor(c, 'colorGemRim').name('rim');
    stone.addColor(c, 'colorGemTip').name('frosted tip');
    stone.addColor(c, 'colorVenom').name('the venom');

    /* ---- panel 2 ---- */
    const gas = folder.addFolder('2 · Gas');
    R(gas, c, 'gasRate', 0, 900, 5, 'puffs/second at the front');
    R(gas, c, 'gasSize', 0.05, 4, 0.01, 'puff size');
    R(gas, c, 'gasSpread', 0.2, 10, 0.05, 'how far it billows out');
    R(gas, c, 'gasSpeed', 0, 8, 0.05, 'puff speed');
    R(gas, c, 'gasLifetime', 0.1, 8, 0.05, 'puff lifetime');
    R(gas, c, 'gasOpacity', 0, 0.6, 0.002, 'opacity');
    R(gas, c, 'gasRise', -1, 3, 0.01, 'rise (m/s)');
    R(gas, c, 'gasTurbulence', 0, 3, 0.01, 'turbulence');
    R(gas, c, 'standingGas', 0, 2, 0.01, 'rate once it stands');
    R(gas, c, 'breachGasChance', 0, 1, 0.01, 'odds a gem puffs');
    R(gas, c, 'burstGas', 0, 400, 1, 'puffs at the impact');
    Editor.gradient(gas, c, 'colorGas', 'gas gradient');

    /* ---- panel 3 ---- */
    const drops = folder.addFolder('3 · Droplets');
    R(drops, c, 'dropSize', 0.005, 0.4, 0.005, 'bead size');
    R(drops, c, 'dropSpeed', 0, 20, 0.1, 'bead speed');
    R(drops, c, 'dropLifetime', 0.05, 4, 0.01, 'bead lifetime');
    R(drops, c, 'dropGravity', -30, 2, 0.1, 'gravity');
    R(drops, c, 'dropGlow', 0, 4, 0.01, 'wet gloss');
    R(drops, c, 'breachDrops', 0, 20, 1, 'flicked by each gem');
    R(drops, c, 'burstDrops', 0, 400, 1, 'the impact fountain');
    R(drops, c, 'shatterDrops', 0, 20, 1, 'thrown as each gem goes');
    R(drops, c, 'dripRate', 0, 60, 0.5, 'drips/second off the tips');
    Editor.gradient(drops, c, 'colorDrop', 'droplet gradient');

    const motes = drops.addFolder('Airborne glitter');
    R(motes, c, 'moteRate', 0, 500, 1, 'motes/second');
    R(motes, c, 'moteSize', 0.005, 0.3, 0.005, 'mote size');
    R(motes, c, 'moteSpeed', 0, 16, 0.1, 'mote speed');
    R(motes, c, 'moteLifetime', 0.1, 6, 0.05, 'mote lifetime');
    R(motes, c, 'moteRise', -2, 6, 0.05, 'rise (m/s)');
    R(motes, c, 'moteTurbulence', 0, 3, 0.01, 'turbulence');
    R(motes, c, 'moteGlow', 0, 4, 0.01, 'glow');
    R(motes, c, 'burstMotes', 0, 500, 1, 'motes at the impact');
    R(motes, c, 'shatterMotes', 0, 20, 1, 'motes as each gem goes');
    Editor.gradient(motes, c, 'colorMote', 'mote gradient');

    /* ---- panel 4 ---- */
    const cracks = folder.addFolder('4 · Cracks');
    R(cracks, c, 'plateRadius', 0.3, 12, 0.05, 'plate radius (m)');
    R(cracks, c, 'slabCount', 6, 140, 1, 'pieces (re-cuts)');
    R(cracks, c, 'slabDepth', 0.01, 0.4, 0.005, 'thickness (× radius, re-cuts)');
    R(cracks, c, 'slabBias', 0.15, 1.2, 0.01, 'finer in the middle (re-cuts)');
    R(cracks, c, 'slabRagged', 0, 0.6, 0.005, 'ragged outline (re-cuts)');
    R(cracks, c, 'slabGap', 0, 0.3, 0.002, 'seam width (× radius)');
    R(cracks, c, 'slabHeave', 0, 0.4, 0.002, 'heave (× radius)');
    R(cracks, c, 'slabTilt', 0, 1.2, 0.005, 'cant (rad)');
    R(cracks, c, 'slabGrowth', 0.5, 40, 0.1, 'fracture speed (m/s)');
    R(cracks, c, 'seamGlow', 0, 8, 0.05, 'light out of the seams');
    R(cracks, c, 'seamReach', 0, 0.5, 0.005, 'spill over the lip');
    R(cracks, c, 'stoneGrain', 0, 2, 0.01, 'grain');
    R(cracks, c, 'stoneGrainScale', 0.5, 30, 0.1, 'grain scale');
    R(cracks, c, 'stoneSpeck', 0, 1.5, 0.01, 'speckle');
    R(cracks, c, 'stoneLip', 0, 1.5, 0.01, 'fresh broken faces');
    cracks.addColor(c, 'colorStone').name('stone');
    cracks.addColor(c, 'colorStoneDark').name('stone shadow');
    cracks.addColor(c, 'colorSeam').name('seam light');
    cracks.addColor(c, 'colorStain').name('venom stain');

    const marks = cracks.addFolder('Marks along the line');
    R(marks, c, 'crackRate', 0, 12, 0.1, 'marks per metre');
    R(marks, c, 'crackSpread', 0.1, 5, 0.05, 'mark radius (× half-width)');
    R(marks, c, 'crackLife', 0.2, 20, 0.1, 'mark lasts');
    R(marks, c, 'crackWidth', 0, 1, 0.01, 'branch width');
    R(marks, c, 'crackIntensity', 0, 3, 0.01, 'intensity');
    marks.addColor(c, 'colorCrackA').name('burnt stone');
    marks.addColor(c, 'colorCrackB').name('mark glow');

    /* ---- panel 5 ---- */
    const glow = folder.addFolder('5 · Glow');
    R(glow, c, 'coreHeight', 0, 6, 0.01, 'height off the floor (m)');
    R(glow, c, 'coreSize', 0.05, 6, 0.01, 'kernel radius (m)');
    R(glow, c, 'coreSwell', 0.02, 1, 0.01, 'how small it starts');
    R(glow, c, 'coreFalloff', 0.2, 8, 0.05, 'concentration');
    R(glow, c, 'coreIntensity', 0, 10, 0.05, 'kernel intensity');
    R(glow, c, 'coreOpacity', 0, 2, 0.01, 'kernel opacity');
    R(glow, c, 'coreBillow', 0, 0.8, 0.005, 'billow');
    R(glow, c, 'coreBillowScale', 0.2, 10, 0.05, 'billow scale');
    R(glow, c, 'coreBreak', 0, 1, 0.01, 'break-up');
    R(glow, c, 'coreBreakScale', 0.2, 12, 0.05, 'break-up scale');
    R(glow, c, 'coreBreakSpeed', -4, 4, 0.05, 'break-up drift');
    R(glow, c, 'coreFlow', -3, 3, 0.01, 'billow drift');
    R(glow, c, 'coreFlicker', 0, 1, 0.005, 'flicker');
    R(glow, c, 'coreFlickerSpeed', 0.5, 30, 0.1, 'flicker speed');
    R(glow, c, 'coreSoftFade', 0.05, 3, 0.01, 'soft fade (m)');
    R(glow, c, 'coreFlare', 0.02, 2, 0.01, 'arrival flare lasts');
    R(glow, c, 'coreFlarePunch', 0, 6, 0.05, 'arrival overshoot');
    R(glow, c, 'coreHold', 0, 1.5, 0.01, 'what it settles to');
    R(glow, c, 'coreBleed', 0, 5, 0.01, 'how hard it lights the gems');
    R(glow, c, 'coreBleedRadius', 0.2, 14, 0.05, 'that light carries (m)');
    glow.addColor(c, 'colorCore').name('kernel core');
    glow.addColor(c, 'colorCoreMid').name('kernel body');
    glow.addColor(c, 'colorCoreEdge').name('kernel edge');

    const halo = glow.addFolder('The halo');
    R(halo, c, 'haloScale', 1, 8, 0.05, 'radius (× kernel)');
    R(halo, c, 'haloFalloff', 0.2, 6, 0.05, 'concentration');
    R(halo, c, 'haloIntensity', 0, 6, 0.01, 'intensity');
    R(halo, c, 'haloOpacity', 0, 2, 0.01, 'opacity');
    R(halo, c, 'haloBillow', 0, 0.8, 0.005, 'billow');
    R(halo, c, 'haloBillowScale', 0.2, 10, 0.05, 'billow scale');
    R(halo, c, 'haloBreak', 0, 1, 0.01, 'break-up');
    halo.addColor(c, 'colorHaloCore').name('halo core');
    halo.addColor(c, 'colorHaloMid').name('halo body');
    halo.addColor(c, 'colorHaloEdge').name('halo edge');

    const strike = folder.addFolder('The strike, camera & light');
    R(strike, c, 'burstSize', 0.2, 14, 0.05, 'gas shell size');
    R(strike, c, 'burstIntensity', 0, 4, 0.01, 'gas shell glow');
    R(strike, c, 'shockRadius', 0.5, 16, 0.05, 'shock ring (m)');
    R(strike, c, 'impactShake', 0, 1, 0.005, 'impact shake');
    R(strike, c, 'shakeDuration', 0.05, 2, 0.01, 'shake decay');
    R(strike, c, 'rumble', 0, 0.3, 0.002, 'travel rumble');
    R(strike, c, 'impactFlash', 0, 1, 0.01, 'impact flash');
    strike.addColor(c, 'colorBurstA').name('shell inner');
    strike.addColor(c, 'colorBurstB').name('shell mid');
    strike.addColor(c, 'colorBurstC').name('shell outer');
    strike.addColor(c, 'colorShockA').name('shock inner');
    strike.addColor(c, 'colorShockB').name('shock outer');
    strike.addColor(c, 'colorFlash').name('impact flash');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 160, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 60, 0.1, 'light radius');
    R(light, c, 'lightWaver', 0, 1, 0.01, 'waver depth');
    light.addColor(c, 'lightColor').name('light colour');

    this.venomFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildQuake() {
    const folder = this.gui.addFolder('▲  Brutalist Earth Blast');
    const c = settings.quake;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'speed', 4, 90, 0.5, 'rupture speed (m/s)');
    R(cast, c, 'lifetime', 0.2, 14, 0.05, 'cluster stands for');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    /* ---- panel 1 ---- */
    const stone = folder.addFolder('1 · Monoliths');

    const rift = stone.addFolder('The rift');
    R(rift, c, 'widthNear', 0.05, 6, 0.01, 'half-width at the caster (m)');
    R(rift, c, 'width', 0.1, 10, 0.01, 'half-width at the end (m)');
    R(rift, c, 'widthCurve', 0.2, 4, 0.01, 'how late it flares');
    R(rift, c, 'stoneCount', 8, 280, 1, 'stones per cast');
    R(rift, c, 'density', 0.05, 1.5, 0.01, 'density');
    R(rift, c, 'blastShare', 0, 0.9, 0.01, 'held back for the cluster');
    R(rift, c, 'clumping', 0.3, 4, 0.01, 'pull toward the centre line');
    R(rift, c, 'scatter', 0, 2, 0.01, 'lateral jitter');
    R(rift, c, 'frontBias', 0.2, 3, 0.01, 'crowd toward the impact');
    R(rift, c, 'heightNear', 0.05, 4, 0.01, 'height at the caster (m)');
    R(rift, c, 'height', 0.1, 10, 0.05, 'height at the end (m)');
    R(rift, c, 'heightCurve', 0.2, 5, 0.01, 'how late it climbs');
    R(rift, c, 'peak', 0.5, 3, 0.01, 'swell at the impact');
    R(rift, c, 'peakWidth', 0.02, 1, 0.01, 'how far that swell reaches');
    R(rift, c, 'rubble', 0, 1, 0.01, 'fraction that are blocks');
    R(rift, c, 'lean', 0, 1.4, 0.01, 'shear back off the front (rad)');

    const cluster = stone.addFolder('The cluster');
    R(cluster, c, 'blastRadius', 0.2, 12, 0.05, 'cluster radius (m)');
    R(cluster, c, 'blastHeight', 0.2, 14, 0.05, 'height at its centre (m)');
    R(cluster, c, 'crown', 0, 1, 0.01, 'how much shorter the skirt is');
    R(cluster, c, 'blastLean', 0, 1.6, 0.01, 'rim cant (rad)');
    R(cluster, c, 'blastLeanCurve', 0.2, 3, 0.01, 'how early the cant starts');
    R(cluster, c, 'blastLeanScatter', 0, 3.2, 0.01, 'cant bearing scatter (rad)');
    R(cluster, c, 'blastStagger', 0, 1, 0.005, 'rim delay (s)');
    R(cluster, c, 'monolithShare', 0, 0.6, 0.01, 'fraction that are monoliths');
    R(cluster, c, 'monolithScale', 1, 4, 0.05, 'monolith height');
    R(cluster, c, 'monolithGirth', 0.4, 3, 0.05, 'monolith mass');
    R(cluster, c, 'blockShare', 0, 0.8, 0.01, 'fraction that are skirt blocks');
    R(cluster, c, 'blockScale', 0.05, 1, 0.01, 'block height');

    const shape = stone.addFolder('One slab');
    R(shape, c, 'radius', 0.02, 2, 0.005, 'footprint radius (m)');
    R(shape, c, 'radiusJitter', 0, 1.5, 0.01, 'radius jitter');
    R(shape, c, 'heightJitter', 0, 1.5, 0.01, 'height jitter');
    R(shape, c, 'leanJitter', 0, 2, 0.01, 'cant jitter');
    R(shape, c, 'twist', 0, 1, 0.01, 'random yaw');
    R(shape, c, 'sides', 4, 8, 1, 'footprint vertices');
    R(shape, c, 'taper', 0.2, 1, 0.01, 'top width');
    R(shape, c, 'flatten', 0.12, 1, 0.01, 'wall ↔ column');
    R(shape, c, 'chip', 0, 0.8, 0.01, 'footprint irregularity');
    R(shape, c, 'shear', 0, 0.8, 0.01, 'break plane tilt');
    R(shape, c, 'bevel', 0, 0.4, 0.005, 'break edge chamfer');
    R(shape, c, 'stoneBend', 0, 0.5, 0.01, 'axis drift');

    const rise = stone.addFolder('The eruption');
    R(rise, c, 'riseTime', 0.02, 1.2, 0.005, 'rise time (s)');
    R(rise, c, 'riseOvershoot', 0, 1, 0.01, 'punch overshoot');
    R(rise, c, 'riseStagger', 0, 1, 0.005, 'neighbour delay (s)');
    R(rise, c, 'settle', 0.05, 2, 0.01, 'drop back onto seat (s)');
    R(rise, c, 'sinkDelay', 0, 4, 0.02, 'delay before it sinks (s)');
    R(rise, c, 'sinkTime', 0.05, 5, 0.02, 'sink time (s)');

    const surface = stone.addFolder('The stone surface');
    R(surface, c, 'texScale', 0.2, 12, 0.05, 'metres per tile');
    R(surface, c, 'texAmount', 0, 1, 0.01, 'scan ↔ procedural');
    R(surface, c, 'normalScale', 0, 4, 0.01, 'normal strength');
    R(surface, c, 'stoneRough', 0, 2, 0.01, 'roughness gain');
    R(surface, c, 'stoneRoughFloor', 0, 1, 0.01, 'minimum roughness');
    R(surface, c, 'stoneAO', 0, 1, 0.01, 'occlusion');
    R(surface, c, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(surface, c, 'stoneDesat', 0, 1, 0.01, 'desaturate the scan');
    R(surface, c, 'stoneGrade', 0, 1, 0.01, 'grade toward concrete');
    surface.addColor(c, 'colorStoneGrade').name('concrete tint');
    R(surface, c, 'breakPale', 0, 1.5, 0.01, 'fresh fracture paling');
    R(surface, c, 'grime', 0, 1.5, 0.01, 'weathering streaks');
    R(surface, c, 'damp', 0, 1.5, 0.01, 'damp root');
    R(surface, c, 'dampHeight', 0.01, 1, 0.01, 'how far up the root reaches');
    R(surface, c, 'dustCoat', 0, 1.5, 0.01, 'settled dust coating');
    R(surface, c, 'dustCoatSharp', 0.05, 6, 0.05, 'how up-facing it must be');
    R(surface, c, 'dustCoatScale', 0.1, 8, 0.05, 'coat patchiness');
    R(surface, c, 'coatDelay', 0, 3, 0.01, 'delay before it settles (s)');
    R(surface, c, 'coatTime', 0.05, 8, 0.05, 'time it takes to build (s)');
    surface.addColor(c, 'colorStone').name('fallback light');
    surface.addColor(c, 'colorStoneDeep').name('fallback dark');
    surface.addColor(c, 'colorDustCoat').name('dust coating');
    surface.addColor(c, 'colorDamp').name('damp root');

    /* ---- panel 2 ---- */
    const dust = folder.addFolder('2 · Cement dust');
    R(dust, c, 'dustRate', 0, 900, 1, 'rate along the front');
    R(dust, c, 'dustSize', 0.05, 6, 0.01, 'puff size');
    R(dust, c, 'dustSpread', 0.5, 12, 0.05, 'growth over its life');
    R(dust, c, 'dustSpeed', 0, 12, 0.05, 'speed');
    R(dust, c, 'dustLifetime', 0.2, 12, 0.05, 'lifetime');
    R(dust, c, 'dustOpacity', 0, 0.6, 0.002, 'opacity');
    R(dust, c, 'dustRise', -2, 2, 0.01, 'rise (negative = it falls)');
    R(dust, c, 'dustTurbulence', 0, 3, 0.01, 'turbulence');
    R(dust, c, 'dustDrag', 0, 6, 0.01, 'drag');
    R(dust, c, 'breachDust', 0, 30, 1, 'per stone breaking through');
    R(dust, c, 'settleDust', 0, 2, 0.01, 'rate once it stands');
    R(dust, c, 'plumeDust', 0, 400, 1, 'plume burst');
    R(dust, c, 'plumeSpeed', 0, 20, 0.1, 'plume speed');
    Editor.gradient(dust, c, 'colorDust', 'Dust gradient');

    const ring = dust.addFolder('The rolling ring');
    R(ring, c, 'ringRate', 0, 3000, 10, 'rate across the ring');
    R(ring, c, 'ringJets', 4, 48, 1, 'emission points');
    R(ring, c, 'ringRadius', 0.5, 24, 0.1, 'reach (m)');
    R(ring, c, 'ringSpeed', 0, 24, 0.1, 'outward speed (m/s)');
    R(ring, c, 'ringLift', 0, 1.5, 0.01, 'upward share');
    R(ring, c, 'ringSize', 0.1, 8, 0.05, 'puff size');
    R(ring, c, 'ringThickness', 0.05, 4, 0.05, 'band depth (m)');
    R(ring, c, 'ringTime', 0.1, 3, 0.02, 'how long it rolls (s)');

    /* ---- panel 3 ---- */
    const shrapnel = folder.addFolder('3 · Geometric shrapnel');
    R(shrapnel, c, 'shrapnelCount', 0, 96, 1, 'chunks thrown');
    R(shrapnel, c, 'shrapnelSize', 0.02, 1.2, 0.005, 'chunk radius (m)');
    R(shrapnel, c, 'shrapnelSizeJitter', 0, 0.95, 0.01, 'size jitter');
    R(shrapnel, c, 'shrapnelSpeed', 0, 40, 0.1, 'launch speed (m/s)');
    R(shrapnel, c, 'shrapnelSpread', 0, 3, 0.01, 'outward share');
    R(shrapnel, c, 'shrapnelLift', 0, 3, 0.01, 'upward share');
    R(shrapnel, c, 'shrapnelGravity', -60, 0, 0.5, 'gravity');
    R(shrapnel, c, 'shrapnelSpin', 0, 30, 0.1, 'tumble (rad/s)');
    R(shrapnel, c, 'shrapnelBounce', 0, 0.9, 0.01, 'bounce');
    R(shrapnel, c, 'shrapnelFriction', 0, 1, 0.01, 'floor friction');
    R(shrapnel, c, 'shrapnelPuffSpeed', 0, 20, 0.1, 'puff threshold (m/s)');
    R(shrapnel, c, 'shrapnelDarken', 0, 0.9, 0.01, 'darken toward silhouette');
    R(shrapnel, c, 'shrapnelTexScale', 0.05, 2, 0.01, 'grain scale × stone');

    const grit = shrapnel.addFolder('Grit');
    R(grit, c, 'gritRate', 0, 400, 1, 'rate along the front');
    R(grit, c, 'gritSize', 0.005, 0.4, 0.005, 'chip size');
    R(grit, c, 'gritSpeed', 0, 24, 0.1, 'speed');
    R(grit, c, 'gritGravity', -60, 0, 0.5, 'gravity');
    R(grit, c, 'gritLifetime', 0.1, 6, 0.05, 'lifetime');
    R(grit, c, 'breachGrit', 0, 30, 1, 'per stone breaking through');
    R(grit, c, 'blastGrit', 0, 600, 1, 'thrown at the impact');
    R(grit, c, 'trickleRate', 0, 80, 0.5, 'trickle off the faces');
    Editor.gradient(grit, c, 'colorGrit', 'Grit gradient');

    const motes = shrapnel.addFolder('Suspended powder');
    R(motes, c, 'moteRate', 0, 300, 1, 'rate');
    R(motes, c, 'moteSize', 0.01, 0.8, 0.005, 'size');
    R(motes, c, 'moteLifetime', 0.2, 12, 0.05, 'lifetime');
    R(motes, c, 'moteFall', -2, 2, 0.01, 'fall (negative = it settles)');
    R(motes, c, 'moteTurbulence', 0, 3, 0.01, 'turbulence');
    R(motes, c, 'moteGlow', 0, 3, 0.01, 'glow — keep it low');
    R(motes, c, 'moteOpacity', 0, 1, 0.01, 'opacity');
    R(motes, c, 'blastMotes', 0, 600, 1, 'thrown at the impact');
    Editor.gradient(motes, c, 'colorMote', 'Powder gradient');

    /* ---- panel 4 ---- */
    const scars = folder.addFolder('4 · Fissure scars');

    const crater = scars.addFolder('The crater');
    R(crater, c, 'craterRadius', 0.3, 14, 0.05, 'crater radius (m)');
    R(crater, c, 'plateCells', 8, 140, 1, 'pieces');
    R(crater, c, 'plateDepth', 0.01, 0.4, 0.005, 'slab thickness × radius');
    R(crater, c, 'plateBias', 0.15, 1.2, 0.01, 'fineness in the middle');
    R(crater, c, 'plateRagged', 0, 0.6, 0.01, 'outline raggedness');
    R(crater, c, 'plateGap', 0, 0.3, 0.005, 'seam opening');
    R(crater, c, 'plateHeave', 0, 0.4, 0.005, 'heave × radius');
    R(crater, c, 'plateTilt', 0, 1.4, 0.01, 'piece cant (rad)');
    R(crater, c, 'plateGrowth', 0.5, 40, 0.1, 'fracture speed (m/s)');
    R(crater, c, 'plateWallDark', 0, 1, 0.01, 'depth of shade in a crack');
    R(crater, c, 'plateSeamDust', 0, 1.5, 0.01, 'powder along the seams');
    R(crater, c, 'plateCoat', 0, 1.5, 0.01, 'its share of the settled dust');

    const cracks = scars.addFolder('The cracks');
    R(cracks, c, 'fissureRadius', 0.5, 24, 0.1, 'reach (m)');
    R(cracks, c, 'fissureLife', 0.5, 30, 0.1, 'how long they linger (s)');
    R(cracks, c, 'fissureArms', 2, 14, 1, 'main arms');
    R(cracks, c, 'fissureWander', 0, 4, 0.01, 'how hard an arm veers');
    R(cracks, c, 'fissureWidth', 0.05, 3, 0.01, 'ribbon width (m)');
    R(cracks, c, 'fissureBranches', 0, 1, 0.01, 'branch density');
    R(cracks, c, 'fissureBranchLength', 0, 1, 0.01, 'branch length');
    R(cracks, c, 'fissureOpen', 0.02, 0.9, 0.01, 'opening ÷ ribbon');
    R(cracks, c, 'fissureLip', 0, 2, 0.01, 'dust rim');
    R(cracks, c, 'fissureDepth', 0, 1, 0.01, 'darkness in the opening');
    R(cracks, c, 'fissureBreak', 0, 1, 0.01, 'edge break-up');
    R(cracks, c, 'fissureBreakScale', 0.2, 8, 0.05, 'break-up scale');
    R(cracks, c, 'fissureGrowth', 1, 60, 0.5, 'growth speed (m/s)');
    cracks.addColor(c, 'colorFissure').name('the dark');
    cracks.addColor(c, 'colorFissureLip').name('the dust rim');

    const marks = scars.addFolder('Marks along the line');
    R(marks, c, 'scarRate', 0.1, 12, 0.05, 'marks per metre');
    R(marks, c, 'scarSpread', 0.2, 5, 0.05, 'mark radius × half-width');
    R(marks, c, 'scarLife', 0.5, 30, 0.1, 'how long they linger (s)');
    R(marks, c, 'scarWidth', 0.05, 2, 0.01, 'branch width');
    R(marks, c, 'scarIntensity', 0, 2, 0.01, 'intensity');
    marks.addColor(c, 'colorScarA').name('broken stone');
    marks.addColor(c, 'colorScarB').name('mark highlight');

    /* ---- panel 5 ---- */
    const air = folder.addFolder('5 · Kinetic air');
    R(air, c, 'warpLife', 0.1, 5, 0.05, 'how long it lasts (s)');
    R(air, c, 'warpRadius', 0.5, 30, 0.1, 'ring reach (m)');
    R(air, c, 'warpThickness', 0.05, 4, 0.05, 'wave packet depth (m)');
    R(air, c, 'warpRipples', 0.5, 30, 0.1, 'bands inside it');
    R(air, c, 'warpChop', 0, 3, 0.01, 'wavefront break-up (m)');
    R(air, c, 'warpChopScale', 0.2, 10, 0.05, 'break-up scale');
    R(air, c, 'warpStrength', 0, 6, 0.01, 'ring strength');
    R(air, c, 'warpColumn', 0, 6, 0.01, 'column strength');
    R(air, c, 'warpColumnWidth', 0.5, 20, 0.1, 'column width (m)');
    R(air, c, 'warpColumnHeight', 0.5, 20, 0.1, 'column height (m)');
    R(air, c, 'warpScale', 0.1, 8, 0.05, 'churn scale');
    R(air, c, 'warpSpeed', 0, 10, 0.05, 'churn speed');

    /* ---- the strike ---- */
    const strike = folder.addFolder('The strike, camera & light');
    R(strike, c, 'shockRadius', 0.5, 20, 0.05, 'shock ring (m)');
    R(strike, c, 'impactShake', 0, 1.5, 0.005, 'impact shake');
    R(strike, c, 'shakeDuration', 0.05, 3, 0.01, 'shake decay');
    R(strike, c, 'rumble', 0, 0.3, 0.002, 'travel rumble');
    R(strike, c, 'impactFlash', 0, 1, 0.005, 'impact flash');
    strike.addColor(c, 'colorShockA').name('shock inner');
    strike.addColor(c, 'colorShockB').name('shock outer');
    strike.addColor(c, 'colorFlash').name('impact flash');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 160, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 60, 0.1, 'light radius');
    R(light, c, 'lightSettle', 0, 1, 0.01, 'how far it falls');
    light.addColor(c, 'lightColor').name('light colour');

    this.quakeFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildInk() {
    const folder = this.gui.addFolder('🖌  Sumi Tide');
    const c = settings.ink;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 300, 1, 'stroke speed');
    R(cast, c, 'floodTime', 0.05, 3, 0.01, 'flood time');
    R(cast, c, 'drainTime', 0.05, 4, 0.01, 'throat opens after');
    R(cast, c, 'lifetime', 0.2, 16, 0.05, 'hold time');
    R(cast, c, 'fadeTime', 0.05, 6, 0.01, 'drain time');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const swell = folder.addFolder('The swell');
    R(swell, c, 'swellRate', 0.05, 6, 0.05, 'envelope speed');
    R(swell, c, 'swellSharp', 0.2, 6, 0.05, 'surge sharpness');
    R(swell, c, 'swellDepth', 0, 2, 0.01, 'modulation depth');
    R(swell, c, 'tideThreshold', 0.05, 0.98, 0.01, 'surge threshold');
    R(swell, c, 'tideRipple', 0, 3, 0.01, 'ripple brightness');
    R(swell, c, 'tideSpray', 0, 200, 1, 'spray / surge');
    R(swell, c, 'tideShake', 0, 0.5, 0.002, 'camera knock');

    const stroke = folder.addFolder('The stroke');
    R(stroke, c, 'handHeight', 0, 2.5, 0.01, 'hand height');
    R(stroke, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(stroke, c, 'handSide', -1.5, 1.5, 0.01, 'hand side');
    R(stroke, c, 'trailInk', 0, 200, 1, 'flecks / metre');
    R(stroke, c, 'trailSpray', 0, 200, 1, 'spray / metre');

    const paper = folder.addFolder('The paper wash');
    R(paper, c, 'washRadius', 0.5, 3, 0.01, 'sheet radius');
    R(paper, c, 'washOpacity', 0, 1.5, 0.01, 'opacity');
    R(paper, c, 'washBleed', 0.02, 3, 0.01, 'edge bleed');
    R(paper, c, 'washDeckle', 0, 1, 0.01, 'torn edge');
    R(paper, c, 'washDeckleScale', 0.2, 8, 0.05, 'tear scale');
    R(paper, c, 'washTooth', 0, 1.5, 0.01, 'paper tooth');
    R(paper, c, 'washToothScale', 0.5, 20, 0.1, 'tooth / metre');
    R(paper, c, 'washFibre', 0, 1, 0.01, 'fibres');
    R(paper, c, 'washFibreScale', 0.2, 8, 0.05, 'fibre scale');
    R(paper, c, 'washDry', 0, 1, 0.01, 'survives drying');
    paper.addColor(c, 'colorPaper').name('sheet');
    paper.addColor(c, 'colorPaperShade').name('sheet, shaded');

    const ink = folder.addFolder('The ink');
    R(ink, c, 'inkRadius', 0.2, 2, 0.01, 'puddle radius');
    R(ink, c, 'inkOpacity', 0, 1.5, 0.01, 'opacity');
    R(ink, c, 'inkFeather', 0.01, 1.5, 0.005, 'edge feather');
    R(ink, c, 'inkTendril', 0, 1.5, 0.01, 'wicking fingers');
    R(ink, c, 'inkTendrilScale', 0.2, 12, 0.05, 'finger scale');
    R(ink, c, 'inkEdge', 0, 2, 0.01, 'stranded rim');
    R(ink, c, 'inkEdgeWidth', 0.02, 2, 0.01, 'rim width');
    R(ink, c, 'granulation', 0, 1.5, 0.01, 'granulation');
    R(ink, c, 'granulationScale', 0.5, 20, 0.1, 'granulation scale');
    R(ink, c, 'inkSwirl', 0, 5, 0.01, 'veil winding');
    R(ink, c, 'inkVeil', 0, 2, 0.01, 'ink in the water');
    R(ink, c, 'inkVeilScale', 0.05, 4, 0.01, 'veil scale');
    R(ink, c, 'inkVeilSharp', 0.2, 8, 0.05, 'strand sharpness');
    ink.addColor(c, 'colorInk').name('pigment');
    ink.addColor(c, 'colorInkWash').name('thinned ink');

    const water = folder.addFolder('The water');
    R(water, c, 'waterOpacity', 0, 1.5, 0.01, 'opacity');
    R(water, c, 'waterDepth', 0.1, 4, 0.01, 'darkening with depth');
    R(water, c, 'ripple', 0, 0.4, 0.001, 'wave amplitude');
    R(water, c, 'rippleScale', 0.05, 6, 0.01, 'waves / metre');
    R(water, c, 'rippleSpeed', -4, 4, 0.01, 'wave speed');
    R(water, c, 'chop', 0, 2, 0.01, 'chop');
    R(water, c, 'chopScale', 0.5, 16, 0.05, 'chop scale');
    R(water, c, 'sheen', 0, 4, 0.01, 'specular');
    R(water, c, 'gloss', 0, 1, 0.01, 'gloss tightness');
    R(water, c, 'caustic', 0, 3, 0.01, 'caustics');
    R(water, c, 'causticScale', 0.1, 8, 0.05, 'caustic scale');
    R(water, c, 'causticSpeed', -3, 3, 0.01, 'caustic speed');
    R(water, c, 'rimFoam', 0, 3, 0.01, 'foam at the wall');
    R(water, c, 'rimFoamWidth', 0.02, 2, 0.01, 'foam width');
    R(water, c, 'poolHeight', 0.005, 0.3, 0.002, 'hover height');
    R(water, c, 'poolOpacity', 0, 2, 0.01, 'floor opacity');
    water.addColor(c, 'colorWater').name('water');
    water.addColor(c, 'colorWaterDeep').name('deep water');
    water.addColor(c, 'colorFoam').name('foam');
    water.addColor(c, 'colorRim').name('rim light');

    const throat = folder.addFolder('The throat');
    R(throat, c, 'throatSize', 0.02, 1, 0.005, 'throat radius');
    R(throat, c, 'throatDepth', 0, 1.5, 0.01, 'how black');
    R(throat, c, 'throatLip', 0.01, 1, 0.005, 'lip width');
    R(throat, c, 'throatSpin', -6, 6, 0.01, 'vortex speed');

    const ripples = folder.addFolder('The brush ripples');
    R(ripples, c, 'rings', 0, 8, 1, 'rings in flight');
    R(ripples, c, 'ringSpeed', 0, 3, 0.01, 'radii / second');
    R(ripples, c, 'ringWidth', 0.01, 1, 0.005, 'stroke width');
    R(ripples, c, 'ringTaper', 0, 1, 0.01, 'taper');
    R(ripples, c, 'ringInk', 0, 2, 0.01, 'ink');
    R(ripples, c, 'ringFoam', 0, 2, 0.01, 'leading white');
    R(ripples, c, 'ringBristle', 0, 1, 0.01, 'dry-brush skips');
    R(ripples, c, 'ringBristleScale', 0.5, 30, 0.1, 'skip scale');
    R(ripples, c, 'ringWobble', 0, 0.5, 0.005, 'radius wander');
    R(ripples, c, 'ringWobbleScale', 0.2, 10, 0.05, 'wander scale');
    R(ripples, c, 'ringReach', 0.2, 4, 0.01, 'how far they run');

    const splatter = folder.addFolder('The splatter');
    R(splatter, c, 'splatter', 0, 1, 0.01, 'fleck density');
    R(splatter, c, 'splatterScale', 0.1, 6, 0.01, 'cells / metre');
    R(splatter, c, 'splatterSize', 0.05, 1.5, 0.01, 'fleck size');
    R(splatter, c, 'splatterTail', 0, 8, 0.05, 'teardrop tail');
    R(splatter, c, 'splatterSpread', 0.5, 3, 0.01, 'how far thrown');

    const crown = folder.addFolder('The crown');
    R(crown, c, 'crownHeight', 0.1, 8, 0.05, 'wall height');
    R(crown, c, 'crownRise', 0.02, 2, 0.01, 'rise time');
    R(crown, c, 'crownFall', 0.05, 6, 0.01, 'fall-back time');
    R(crown, c, 'crownFingers', 3, 60, 1, 'scallops');
    R(crown, c, 'crownFingerDepth', 0, 1, 0.01, 'scallop depth');
    R(crown, c, 'crownFlare', -0.5, 1.5, 0.01, 'outward lean');
    R(crown, c, 'crownCurl', -0.5, 1, 0.01, 'crest curl');
    R(crown, c, 'crownLean', 0, 2, 0.01, 'lean as it falls');
    R(crown, c, 'crownWobble', 0, 0.5, 0.005, 'radius wander');
    R(crown, c, 'crownWobbleScale', 0.2, 10, 0.05, 'wander scale');
    R(crown, c, 'crownSpin', -2, 2, 0.005, 'scallop travel');
    R(crown, c, 'crownTear', 0, 1.5, 0.01, 'crest tearing');
    R(crown, c, 'crownTearScale', 0.2, 12, 0.05, 'tear scale');
    R(crown, c, 'crownFoam', 0, 4, 0.01, 'crest foam');
    R(crown, c, 'crownFresnel', 0, 4, 0.01, 'rim light (scale)');
    R(crown, c, 'crownStreak', 0, 2, 0.01, 'ink streaks');
    R(crown, c, 'crownStreakScale', 0.5, 20, 0.1, 'streak scale');
    R(crown, c, 'crownInk', 0, 1.5, 0.01, 'how stained');
    R(crown, c, 'crownOpacity', 0, 2, 0.01, 'opacity');
    R(crown, c, 'crownGlow', 0, 4, 0.01, 'glow');
    R(crown, c, 'crownSoftFade', 0.02, 3, 0.01, 'soft fade, metres');

    const column = folder.addFolder('The column');
    R(column, c, 'columnHeight', 0.2, 12, 0.05, 'jet height');
    R(column, c, 'columnRise', 0.02, 2, 0.01, 'rise time');
    R(column, c, 'columnHold', 0, 4, 0.01, 'hold time');
    R(column, c, 'columnFall', 0.05, 5, 0.01, 'fall time');
    R(column, c, 'columnFoot', 0.02, 1.5, 0.01, 'radius at the foot');
    R(column, c, 'columnNeck', 0.01, 1, 0.005, 'radius at the neck');
    R(column, c, 'columnHead', 0.01, 1.5, 0.005, 'radius at the head');
    R(column, c, 'columnWobble', 0, 1, 0.005, 'off plumb');
    R(column, c, 'columnWobbleScale', 0.2, 10, 0.05, 'wander scale');
    R(column, c, 'columnSpin', -3, 3, 0.01, 'twist as it climbs');
    R(column, c, 'columnTear', 0, 1.5, 0.01, 'head tearing');
    R(column, c, 'columnInk', 0, 1, 0.01, 'how black');
    R(column, c, 'columnFoam', 0, 3, 0.01, 'foam');
    R(column, c, 'columnFresnel', 0, 4, 0.01, 'rim light (scale)');
    R(column, c, 'columnOpacity', 0, 2, 0.01, 'opacity');

    const wisps = folder.addFolder('The suspended ink');
    R(wisps, c, 'wispSteps', 6, 64, 1, 'march steps (cost)');
    R(wisps, c, 'wispHeight', 0.2, 12, 0.05, 'how high it hangs');
    R(wisps, c, 'wispDensity', 0, 6, 0.01, 'density');
    R(wisps, c, 'wispAbsorb', 0.05, 6, 0.01, 'absorption');
    R(wisps, c, 'wispScale', 0.05, 3, 0.005, 'features / metre');
    R(wisps, c, 'wispDetail', 0.2, 6, 0.05, 'filament scale');
    R(wisps, c, 'wispFilament', 0, 1, 0.01, 'strands vs clouds');
    R(wisps, c, 'wispThreshold', 0, 0.9, 0.01, 'carve threshold');
    R(wisps, c, 'wispRise', -3, 3, 0.01, 'climb speed');
    R(wisps, c, 'wispStretch', 0.05, 2, 0.01, 'vertical stretch');
    R(wisps, c, 'wispTwist', -8, 8, 0.05, 'twist over height');
    R(wisps, c, 'wispSpin', -1, 1, 0.005, 'whole-volume spin');
    R(wisps, c, 'wispWind', 0, 6, 0.05, 'vortex near the axis');
    R(wisps, c, 'wispFunnel', 0, 1, 0.01, 'hollow middle');
    R(wisps, c, 'wispEdge', 0, 1, 0.01, 'wall softness');
    R(wisps, c, 'wispFlare', -0.4, 1.5, 0.01, 'opening with height');
    R(wisps, c, 'wispSkirt', 0, 1, 0.01, 'spill past the edge');
    R(wisps, c, 'wispFalloff', 0.1, 5, 0.01, 'thinning upward');
    R(wisps, c, 'wispLobe', 0, 1, 0.01, 'wall wander');
    R(wisps, c, 'wispTear', 0, 0.6, 0.005, 'top tearing');
    R(wisps, c, 'wispLight', 0, 3, 0.01, 'daylight through');
    R(wisps, c, 'wispShadow', 0, 8, 0.05, 'self-shadow');
    R(wisps, c, 'wispShadowStep', 0.05, 4, 0.05, 'shadow tap, metres');
    R(wisps, c, 'wispAmbient', 0, 1, 0.005, 'ambient');
    R(wisps, c, 'wispSaturate', 0, 5, 0.01, 'deepening with density');
    R(wisps, c, 'wispOpacity', 0, 2, 0.01, 'opacity');
    R(wisps, c, 'wispClear', 0, 1, 0.01, 'parts for held bodies');
    R(wisps, c, 'wispClearSize', 0.2, 3, 0.01, 'parting width, metres');
    R(wisps, c, 'wispClearFade', 0.1, 4, 0.05, 'parting closes over');
    wisps.addColor(c, 'colorWispDeep').name('thick ink');
    wisps.addColor(c, 'colorWispBody').name('body');
    wisps.addColor(c, 'colorWispEdge').name('thin ink');
    wisps.addColor(c, 'colorWispLight').name('daylight through');

    const warp = folder.addFolder('Surface refraction');
    R(warp, c, 'warpStrength', 0, 4, 0.01, 'strength');
    R(warp, c, 'warpRipple', 0, 3, 0.01, 'from the rings');
    R(warp, c, 'warpScale', 0.1, 8, 0.05, 'chop scale');
    R(warp, c, 'warpSpeed', -3, 3, 0.01, 'chop speed');

    const grip = folder.addFolder('The swallow');
    const gc = c.grip;
    R(grip, gc, 'flow', 0, 20, 0.1, 'inward current, m/s');
    R(grip, gc, 'swirl', 0, 20, 0.1, 'tangential current, m/s');
    R(grip, gc, 'tumble', 0, 4, 0.01, 'body spin, rev/s');
    R(grip, gc, 'sink', 0, 20, 0.1, 'downward current, m/s');
    R(grip, gc, 'grab', 0.1, 12, 0.05, 'how fast it takes hold');
    R(grip, gc, 'winch', 0, 12, 0.05, 'held to the spiral how hard');
    R(grip, gc, 'windUp', 0.05, 3, 0.01, 'takes hold over');
    R(grip, gc, 'wade', 0, 2, 0.01, 'floor drops by');
    R(grip, gc, 'float', 0, 2, 0.01, 'carried at height');
    R(grip, gc, 'crest', 0, 2, 0.01, 'higher at the axis, x');
    R(grip, gc, 'buoy', 0, 12, 0.05, 'held there how hard');
    R(grip, gc, 'rise', 0.1, 8, 0.05, 'fastest it is lifted');
    R(grip, gc, 'hold', 0, 3, 0.01, 'turns on the surface for');
    R(grip, gc, 'spiral', 0.2, 8, 0.05, 'winds in over');
    R(grip, gc, 'depth', 0.5, 12, 0.1, 'how deep they go');
    R(grip, gc, 'impulse', 0, 20, 0.1, 'blow, inward');
    R(grip, gc, 'lift', 0, 12, 0.1, 'blow, upward');
    R(grip, gc, 'spin', 0, 4, 0.01, 'blow, torque');
    R(grip, gc, 'splashDroplets', 0, 200, 1, 'splash droplets');
    R(grip, gc, 'splashSpray', 0, 200, 1, 'splash spray');
    R(grip, gc, 'splashFoam', 0, 3, 0.01, 'splash ring');
    R(grip, gc, 'splashShake', 0, 0.5, 0.002, 'splash knock');

    const particles = folder.addFolder('Particles');
    R(particles, c, 'dropletRate', 0, 400, 1, 'droplets / second');
    R(particles, c, 'dropletSpeed', 0, 14, 0.05, 'droplet speed');
    R(particles, c, 'dropletLifetime', 0.05, 6, 0.05, 'droplet life');
    R(particles, c, 'dropletSize', 0.01, 0.6, 0.005, 'droplet size');
    R(particles, c, 'sprayRate', 0, 400, 1, 'spray / second');
    R(particles, c, 'spraySpeed', 0, 12, 0.05, 'spray speed');
    R(particles, c, 'sprayLifetime', 0.05, 6, 0.05, 'spray life');
    R(particles, c, 'spraySize', 0.01, 0.8, 0.005, 'spray size');
    R(particles, c, 'fleckRate', 0, 400, 1, 'flecks / second');
    R(particles, c, 'fleckSpeed', 0, 12, 0.05, 'fleck speed');
    R(particles, c, 'fleckLifetime', 0.05, 6, 0.05, 'fleck life');
    R(particles, c, 'fleckSize', 0.01, 0.6, 0.005, 'fleck size');
    R(particles, c, 'hazeRate', 0, 200, 1, 'haze / second');
    R(particles, c, 'hazeSpeed', 0, 8, 0.05, 'haze speed');
    R(particles, c, 'hazeLifetime', 0.05, 8, 0.05, 'haze life');
    R(particles, c, 'hazeSize', 0.05, 4, 0.01, 'haze size');
    Editor.gradient(particles, c, 'colorDroplet', 'Droplet gradient');
    Editor.gradient(particles, c, 'colorSpray', 'Spray gradient');
    Editor.gradient(particles, c, 'colorFleck', 'Fleck gradient');
    Editor.gradient(particles, c, 'colorHaze', 'Haze gradient');

    const impact = folder.addFolder('The flood');
    R(impact, c, 'burstSize', 0.1, 12, 0.05, 'spray dome');
    R(impact, c, 'burstIntensity', 0, 4, 0.01, 'dome brightness');
    R(impact, c, 'shockRadius', 0.5, 25, 0.1, 'shock ring');
    R(impact, c, 'stainRadius', 0.5, 16, 0.1, 'stain radius');
    R(impact, c, 'stainLife', 0.5, 20, 0.1, 'stain life');
    R(impact, c, 'stainIntensity', 0, 3, 0.01, 'stain strength');
    R(impact, c, 'floodShake', 0, 2, 0.005, 'flood shake');
    R(impact, c, 'shakeDuration', 0.05, 3, 0.01, 'shake decay');
    R(impact, c, 'floodFlash', 0, 1, 0.005, 'flood flash');
    R(impact, c, 'rumble', 0, 0.3, 0.002, 'travel rumble');
    R(impact, c, 'holdShake', 0, 0.3, 0.002, 'hold rumble');
    impact.addColor(c, 'colorShockA').name('shock inner');
    impact.addColor(c, 'colorShockB').name('shock outer');
    impact.addColor(c, 'colorStain').name('stain');
    impact.addColor(c, 'colorFlash').name('flood flash');
    impact.addColor(c, 'colorBurstA').name('dome core');
    impact.addColor(c, 'colorBurstB').name('dome body');
    impact.addColor(c, 'colorBurstC').name('dome edge');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 160, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 60, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 2, 0.01, 'height in the crown');
    R(light, c, 'lightSwell', 0, 2, 0.01, 'swell owns');
    light.addColor(c, 'lightColor').name('light colour');

    this.inkFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The Astral Void Blast.
   *
   * Grouped by the five panels of its reference sheet, in the order they
   * happen. The two knobs worth reaching for first are `coreRadius` (in "The
   * singularity") and `zoneRadius` (in "The cast"): almost every other length
   * in this ability is expressed as a multiple of one of them, so those two
   * re-scale the whole thing in proportion — mid-cast, and while paused.
   */
  _buildAstral() {
    const folder = this.gui.addFolder('🕳  Astral Void Blast');
    const c = settings.astral;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 300, 1, 'seed speed');
    R(cast, c, 'lifetime', 0.2, 16, 0.05, 'hold time');
    R(cast, c, 'fadeTime', 0.05, 6, 0.01, 'collapse time');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    R(cast, c, 'handHeight', 0, 2.5, 0.01, 'hand height');
    R(cast, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(cast, c, 'handSide', -2, 2, 0.01, 'hand side');
    R(cast, c, 'trailStars', 0, 200, 1, 'trail stars / metre');
    Editor.castAnimation(cast, c);

    const core = folder.addFolder('1 · The singularity');
    R(core, c, 'coreRadius', 0.05, 4, 0.01, 'shadow radius');
    R(core, c, 'coreHeight', 0, 8, 0.05, 'height off the floor');
    R(core, c, 'seedSize', 0.02, 1, 0.01, 'seed size, x radius');
    R(core, c, 'coreSwell', 0.02, 2, 0.01, 'inflates over (s)');
    R(core, c, 'coreBloom', 1, 5, 0.01, 'inflates to, x radius');
    R(core, c, 'corePinch', 0.02, 1.5, 0.01, 'collapse takes (s)');
    R(core, c, 'burstTime', 0.05, 3, 0.01, 'nebula opens over (s)');
    R(core, c, 'haloReach', 1.5, 20, 0.1, 'halo reach, x horizon');
    R(core, c, 'ringWidth', 0.005, 0.4, 0.002, 'photon ring width');
    R(core, c, 'ringGlow', 0, 30, 0.1, 'photon ring glow');
    R(core, c, 'ringBeam', 0, 1.5, 0.01, 'beamed side');
    R(core, c, 'ringSpin', -3, 3, 0.01, 'beam travel, rev/s');
    R(core, c, 'haloGlow', 0, 6, 0.01, 'halo glow');
    R(core, c, 'haloFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(core, c, 'haloWind', 0, 10, 0.05, 'halo winding');
    R(core, c, 'haloSpin', -3, 3, 0.01, 'halo spin, rev/s');
    R(core, c, 'haloFilament', 0, 1, 0.01, 'torn into strands');
    R(core, c, 'haloFilamentScale', 0.2, 10, 0.05, 'strand scale');
    core.addColor(c, 'colorPhoton').name('photon ring');
    core.addColor(c, 'colorHalo').name('halo, near');
    core.addColor(c, 'colorHaloCool').name('halo, far');

    const lens = folder.addFolder('2 · The lens');
    R(lens, c, 'lensReach', 2, 40, 0.1, 'reach, x horizon');
    R(lens, c, 'lensBend', 0, 2, 0.01, 'deflection, x radius');
    R(lens, c, 'lensDrag', 0, 1.5, 0.01, 'frame dragging');

    const nebula = folder.addFolder('3 · The nebula');
    R(nebula, c, 'nebulaRadius', 0.5, 24, 0.1, 'reach, metres');
    R(nebula, c, 'nebulaCavity', 0.5, 5, 0.01, 'eye, x horizon');
    R(nebula, c, 'nebulaSteps', 6, 72, 1, 'march steps');
    R(nebula, c, 'nebulaDensity', 0, 12, 0.05, 'density');
    R(nebula, c, 'nebulaAbsorb', 0, 6, 0.01, 'opacity along the ray');
    R(nebula, c, 'nebulaGlow', 0, 8, 0.01, 'emission');
    R(nebula, c, 'nebulaScale', 0.05, 2, 0.01, 'features / metre');
    R(nebula, c, 'nebulaDetail', 0.5, 8, 0.05, 'filament scale');
    R(nebula, c, 'nebulaFilament', 0, 1, 0.01, 'strands vs clouds');
    R(nebula, c, 'nebulaThreshold', 0.05, 0.95, 0.01, 'carve threshold');
    R(nebula, c, 'nebulaEdge', 0.05, 1, 0.01, 'outer softness');
    R(nebula, c, 'nebulaFlatten', 0.1, 1.5, 0.01, 'disc vs ball');
    R(nebula, c, 'nebulaArms', 1, 9, 1, 'spiral arms');
    R(nebula, c, 'nebulaArmSharp', 0.2, 6, 0.05, 'arm sharpness');
    R(nebula, c, 'nebulaArmWeight', 0, 1, 0.01, 'arm weight');
    R(nebula, c, 'nebulaWind', 0, 10, 0.05, 'differential winding');
    R(nebula, c, 'nebulaTwist', -6, 6, 0.05, 'twist with height');
    R(nebula, c, 'nebulaSpin', -3, 3, 0.01, 'field spin, rev/s');
    R(nebula, c, 'nebulaRise', -3, 3, 0.01, 'field climb');
    R(nebula, c, 'nebulaSpikes', 0, 24, 1, 'golden spears');
    R(nebula, c, 'nebulaSpikeSharp', 1, 24, 0.5, 'spear sharpness');
    R(nebula, c, 'nebulaSpikeReach', 0.1, 2, 0.01, 'spear reach');
    R(nebula, c, 'nebulaSpikeGlow', 0, 3, 0.01, 'spear glow');
    R(nebula, c, 'nebulaHeatFalloff', 0.2, 8, 0.05, 'gold to violet');
    R(nebula, c, 'nebulaBeam', 0, 2, 0.01, 'doppler beaming');
    R(nebula, c, 'nebulaOpacity', 0, 2, 0.01, 'opacity');
    nebula.addColor(c, 'colorNebulaEdge').name('thin gas');
    nebula.addColor(c, 'colorNebulaBody').name('body');
    nebula.addColor(c, 'colorNebulaHot').name('hot');
    nebula.addColor(c, 'colorNebulaCore').name('the throat');

    const shards = folder.addFolder('4 · The void-shards');
    R(shards, c, 'shardSize', 0.05, 2, 0.01, 'size, metres');
    R(shards, c, 'shardSpread', 0.2, 4, 0.01, 'thrown to, x footprint');
    R(shards, c, 'shardStagger', 0, 8, 0.05, 'arrivals spread over (s)');
    R(shards, c, 'shardLife', 0.2, 8, 0.05, 'one fall takes (s)');
    R(shards, c, 'shardOrbit', 0, 4, 0.01, 'infall winding');
    R(shards, c, 'shardLoft', 0, 2, 0.01, 'out of the plane');
    R(shards, c, 'shardTumble', 0, 8, 0.05, 'tumble, rev/s');
    R(shards, c, 'shardCrush', 0.2, 0.99, 0.01, 'crushed after');
    R(shards, c, 'shardFresnel', 0, 6, 0.01, 'rim');
    R(shards, c, 'shardFresnelPower', 0.5, 8, 0.05, 'rim tightness');
    R(shards, c, 'shardVein', 0, 6, 0.01, 'veins');
    R(shards, c, 'shardVeinScale', 0.5, 20, 0.1, 'vein scale');
    R(shards, c, 'shardVeinSharp', 0.5, 8, 0.05, 'vein sharpness');
    R(shards, c, 'shardGlint', 0, 4, 0.01, 'facet glint');
    R(shards, c, 'shardGlintScale', 2, 80, 0.5, 'glint scale');
    R(shards, c, 'shardHeatGlow', 0, 16, 0.1, 'white-out');
    R(shards, c, 'shardCoreBleed', 0, 6, 0.01, 'lit by the hole');
    R(shards, c, 'shardCoreRadius', 0.5, 20, 0.1, '... how far, metres');
    R(shards, c, 'shardRoughness', 0, 1, 0.01, 'roughness');
    R(shards, c, 'shardMetalness', 0, 1, 0.01, 'metalness');
    R(shards, c, 'shardEnvIntensity', 0, 3, 0.01, 'reflections');
    shards.addColor(c, 'colorShardBody').name('body');
    shards.addColor(c, 'colorShardFacet').name('lit facet');
    shards.addColor(c, 'colorShardRim').name('rim');
    shards.addColor(c, 'colorShardVein').name('veins');
    shards.addColor(c, 'colorShardHot').name('white-out');

    const shock = folder.addFolder('5 · The shockwave');
    R(shock, c, 'shockRadius', 1, 40, 0.1, 'reach, metres');
    R(shock, c, 'shockSpeed', 1, 60, 0.5, 'speed, m/s');
    R(shock, c, 'shockHeight', 0, 0.3, 0.002, 'hover, metres');
    R(shock, c, 'shockWidth', 0.05, 5, 0.01, 'packet depth, metres');
    R(shock, c, 'shockLift', 0, 3, 0.01, 'crest lift, metres');
    R(shock, c, 'shockWobble', 0, 3, 0.01, 'front wander, metres');
    R(shock, c, 'shockWobbleScale', 0.2, 10, 0.05, 'wander scale');
    R(shock, c, 'shockSpokes', 0, 80, 1, 'filaments');
    R(shock, c, 'shockSpokeSharp', 0.2, 8, 0.05, 'filament sharpness');
    R(shock, c, 'shockSpokeDrift', -4, 4, 0.01, 'filament drift');
    R(shock, c, 'shockEdge', 0, 4, 0.01, 'leading line');
    R(shock, c, 'shockTrail', 0, 2, 0.01, 'wash behind');
    R(shock, c, 'shockGrain', 0, 2, 0.01, 'grain');
    R(shock, c, 'shockGrainScale', 0.1, 8, 0.05, 'grain scale');
    R(shock, c, 'shockGlow', 0, 8, 0.01, 'glow');
    R(shock, c, 'shockOpacity', 0, 2, 0.01, 'opacity');
    shock.addColor(c, 'colorShockHot').name('crest');
    shock.addColor(c, 'colorShockBody').name('body');
    shock.addColor(c, 'colorShockCool').name('wash');
    R(shock, c, 'warpStrength', 0, 6, 0.01, 'air displacement');
    R(shock, c, 'warpWidth', 0.05, 5, 0.01, 'pressure depth');
    R(shock, c, 'warpRipples', 0.5, 20, 0.1, 'pressure bands');
    R(shock, c, 'warpChop', 0, 2, 0.01, 'pressure break-up');
    R(shock, c, 'warpChopScale', 0.2, 10, 0.05, 'break-up scale');

    const churn = folder.addFolder('The flare');
    R(churn, c, 'churnRate', 0.05, 8, 0.05, 'envelope speed');
    R(churn, c, 'churnSharp', 0.2, 8, 0.05, 'flare sharpness');
    R(churn, c, 'churnDepth', 0, 2, 0.01, 'modulation depth');
    R(churn, c, 'flareThreshold', 0.05, 0.98, 0.01, 'flare threshold');
    R(churn, c, 'flareEmbers', 0, 300, 1, 'gold / flare');
    R(churn, c, 'flareStars', 0, 300, 1, 'stars / flare');
    R(churn, c, 'flareShake', 0, 0.5, 0.002, 'camera knock');

    const grip = folder.addFolder('The swallow');
    const gc = c.grip;
    R(grip, gc, 'reach', 0.5, 5, 0.01, 'fishes within, x footprint');
    R(grip, gc, 'well', 0.1, 3, 0.01, 'half-strength at, x footprint');
    R(grip, gc, 'pull', 0, 30, 0.1, 'inward pull, m/s');
    R(grip, gc, 'swirl', 0, 30, 0.1, 'tangential, m/s');
    R(grip, gc, 'tumble', 0, 4, 0.01, 'body spin, rev/s');
    R(grip, gc, 'cartwheel', 0, 2, 0.01, 'end-over-end');
    R(grip, gc, 'windUp', 0.05, 3, 0.01, 'takes hold over');
    R(grip, gc, 'buoy', 0, 2, 0.01, 'weight carried');
    R(grip, gc, 'grab', 0.1, 12, 0.05, 'how fast it takes hold');
    R(grip, gc, 'spiral', 0, 8, 0.05, 'given to wind in for');
    R(grip, gc, 'swallow', 0.5, 8, 0.05, 'the mouth, x horizon');
    R(grip, gc, 'devour', 0.1, 8, 0.05, 'consumed at, bodies/s');
    R(grip, gc, 'impulse', 0, 20, 0.1, 'blow, inward');
    R(grip, gc, 'lift', 0, 12, 0.1, 'blow, upward');
    R(grip, gc, 'spin', 0, 4, 0.01, 'blow, torque');
    R(grip, gc, 'swallowEmbers', 0, 300, 1, 'gold / body');
    R(grip, gc, 'swallowStars', 0, 300, 1, 'stars / body');
    R(grip, gc, 'swallowShake', 0, 0.5, 0.002, 'swallow knock');

    const particles = folder.addFolder('Particles');
    R(particles, c, 'starRate', 0, 900, 5, 'stars / second');
    R(particles, c, 'starSize', 0.01, 0.5, 0.005, 'star size');
    R(particles, c, 'starLifetime', 0.1, 6, 0.05, 'star life');
    R(particles, c, 'starShell', 0.2, 3, 0.01, 'born at, x footprint');
    R(particles, c, 'starLoft', 0, 2, 0.01, 'out of the plane');
    R(particles, c, 'starSwirl', -12, 12, 0.05, 'orbit, rad/s');
    R(particles, c, 'starInfall', 0, 1, 0.01, 'how far the orbit collapses');
    R(particles, c, 'emberRate', 0, 400, 1, 'gold / second');
    R(particles, c, 'emberSpeed', 0, 20, 0.05, 'gold speed');
    R(particles, c, 'emberLifetime', 0.05, 6, 0.05, 'gold life');
    R(particles, c, 'emberSize', 0.01, 0.6, 0.005, 'gold size');
    R(particles, c, 'chipRate', 0, 200, 1, 'stone / second');
    R(particles, c, 'chipSpeed', 0, 20, 0.05, 'stone speed');
    R(particles, c, 'chipLifetime', 0.05, 6, 0.05, 'stone life');
    R(particles, c, 'chipSize', 0.01, 0.6, 0.005, 'stone size');
    R(particles, c, 'dustRate', 0, 200, 1, 'dust / second');
    R(particles, c, 'dustSpeed', 0, 12, 0.05, 'dust speed');
    R(particles, c, 'dustLifetime', 0.05, 8, 0.05, 'dust life');
    R(particles, c, 'dustSize', 0.05, 5, 0.01, 'dust size');
    Editor.gradient(particles, c, 'colorStar', 'Star gradient');
    Editor.gradient(particles, c, 'colorEmber', 'Gold gradient');
    Editor.gradient(particles, c, 'colorChip', 'Stone gradient');
    Editor.gradient(particles, c, 'colorDust', 'Dust gradient');

    const blast = folder.addFolder('The collapse');
    R(blast, c, 'implodeStars', 0, 800, 5, 'inrush stars');
    R(blast, c, 'implodeShake', 0, 1, 0.005, 'arrival knock');
    R(blast, c, 'blastEmbers', 0, 800, 5, 'blast gold');
    R(blast, c, 'blastChips', 0, 600, 5, 'blast stone');
    R(blast, c, 'blastDust', 0, 400, 5, 'blast dust');
    R(blast, c, 'blastStars', 0, 1500, 10, 'blast stars');
    R(blast, c, 'blastShake', 0, 3, 0.005, 'blast shake');
    R(blast, c, 'shakeDuration', 0.05, 3, 0.01, 'shake decay');
    R(blast, c, 'blastFlash', 0, 1, 0.005, 'blast flash');
    R(blast, c, 'scorchRadius', 0.5, 16, 0.1, 'scorch radius');
    R(blast, c, 'scorchLife', 0.5, 20, 0.1, 'scorch life');
    R(blast, c, 'scorchIntensity', 0, 3, 0.01, 'scorch strength');
    R(blast, c, 'rumble', 0, 0.3, 0.002, 'travel rumble');
    R(blast, c, 'holdShake', 0, 0.3, 0.002, 'hold rumble');
    R(blast, c, 'collapseFlash', 0, 2, 0.01, 'closing flash');
    R(blast, c, 'collapseShake', 0, 2, 0.005, 'closing shake');
    blast.addColor(c, 'colorScorch').name('scorch');
    blast.addColor(c, 'colorScorchEmber').name('scorch ember');
    blast.addColor(c, 'colorFlash').name('blast flash');
    blast.addColor(c, 'colorCollapseFlash').name('closing flash');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 160, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 60, 0.1, 'light radius');
    R(light, c, 'lightPulse', 0, 2, 0.01, 'flare owns');
    light.addColor(c, 'lightColor').name('light colour');

    this.astralFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The Baleful Cascade Mark.
   *
   * Grouped by the four panels of its reference sheet, in the order they are
   * drawn — ground glow, decal mark, wisps, core mesh burst — and then by what
   * the burst does with itself. The two knobs worth reaching for first are
   * `zoneRadius` (in "The cast") and `crownScale` (in "3 · The core mesh
   * burst"): nearly every other length in this ability is a multiple of one of
   * them, so those two re-scale the whole thing in proportion, mid-cast and
   * while paused.
   */
  _buildCascade() {
    const folder = this.gui.addFolder('✦  Baleful Cascade');
    const c = settings.cascade;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 12, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 200, 1, 'shard speed');
    R(cast, c, 'lifetime', 0.5, 20, 0.05, 'stands for (s)');
    R(cast, c, 'fadeTime', 0.05, 6, 0.01, 'closes over (s)');
    R(cast, c, 'cooldown', 0, 8, 0.05, 'cooldown');
    R(cast, c, 'handHeight', 0, 2.5, 0.01, 'hand height');
    R(cast, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(cast, c, 'handSide', -2, 2, 0.01, 'hand side');
    Editor.castAnimation(cast, c);

    const order = folder.addFolder('The order it happens in');
    R(order, c, 'glowTime', 0.02, 2, 0.01, 'glow opens over (s)');
    R(order, c, 'markTime', 0.02, 3, 0.01, 'mark cuts on over (s)');
    R(order, c, 'wispDelay', 0, 3, 0.01, 'wisps start at (s)');
    R(order, c, 'wispTime', 0.05, 4, 0.01, 'wisps rise over (s)');
    R(order, c, 'crownDelay', 0, 4, 0.01, 'burst starts at (s)');
    R(order, c, 'crownTime', 0.05, 4, 0.01, 'burst forms over (s)');
    R(order, c, 'fireDelay', 0, 3, 0.01, 'then waits (s)');
    R(order, c, 'pulseRate', 0, 6, 0.01, 'bank rate');
    R(order, c, 'pulseDepth', 0, 1.5, 0.01, 'bank depth');

    const glow = folder.addFolder('4 · The ground glow');
    R(glow, c, 'glowPool', 0, 3, 0.01, 'pool');
    R(glow, c, 'glowPoolFalloff', 0.1, 6, 0.01, 'pool falloff');
    R(glow, c, 'glowLip', 0, 4, 0.01, 'lip');
    R(glow, c, 'glowLipSeat', 0.2, 1.2, 0.01, 'lip seat, x footprint');
    R(glow, c, 'glowLipWidth', 0.01, 1, 0.005, 'lip width (m)');
    R(glow, c, 'glowSpill', 0, 2, 0.01, 'spill past it');
    R(glow, c, 'glowSpillReach', 1, 3, 0.01, 'spill reach, x footprint');
    R(glow, c, 'glowSpillFalloff', 0.2, 8, 0.05, 'spill falloff');
    R(glow, c, 'glowWobble', 0, 0.2, 0.002, 'boundary wander');
    R(glow, c, 'glowWobbleLobes', 1, 16, 1, 'wander lobes');
    R(glow, c, 'glowWobbleSpeed', 0, 4, 0.01, 'wander speed');
    R(glow, c, 'glowSweep', 0, 3, 0.01, 'read head');
    R(glow, c, 'glowSweepSpeed', -1, 1, 0.005, 'head speed, rev/s');
    R(glow, c, 'glowSweepWidth', 0.01, 0.6, 0.005, 'head width');
    R(glow, c, 'glowGrain', 0, 2, 0.01, 'grain');
    R(glow, c, 'glowGrainScale', 0.1, 8, 0.05, 'grain scale');
    R(glow, c, 'glowHeight', 0, 0.2, 0.001, 'height off floor');
    R(glow, c, 'glowOpacity', 0, 2, 0.01, 'opacity');
    R(glow, c, 'glowGlow', 0, 4, 0.01, 'glow');
    glow.addColor(c, 'colorGlowCore').name('core');
    glow.addColor(c, 'colorGlowPool').name('pool');
    glow.addColor(c, 'colorGlowRim').name('lip');

    const mark = folder.addFolder('1 · The decal mark');
    R(mark, c, 'markLineWidth', 0.004, 0.2, 0.002, 'stroke width (m)');
    R(mark, c, 'markLineGlow', 0, 6, 0.01, 'stroke glow');
    R(mark, c, 'markPoints', 3, 10, 1, 'star points');
    R(mark, c, 'markStarSharp', 2, 8, 0.01, 'barb sharpness (2 = polygon)');
    R(mark, c, 'markStarOuter', 0.4, 1.4, 0.01, 'star reach, x footprint');
    R(mark, c, 'markStarSpin', -0.2, 0.2, 0.001, 'star spin, rev/s');
    R(mark, c, 'markInnerScale', 0.1, 1, 0.01, 'inner star, x outer');
    R(mark, c, 'markInnerGain', 0, 2, 0.01, 'inner star weight');
    R(mark, c, 'markDiamond', 0, 3, 0.01, 'diamond');
    R(mark, c, 'markDiamondSeat', 0.2, 1.2, 0.01, 'diamond, x footprint');
    R(mark, c, 'markDiamondAspect', 0.3, 2, 0.01, 'diamond aspect');
    R(mark, c, 'markDiamondSpin', -0.2, 0.2, 0.001, 'diamond spin, rev/s');
    R(mark, c, 'markSpear', 0, 3, 0.01, 'spearheads');
    R(mark, c, 'markSpearFrom', 0.1, 1.2, 0.01, 'spear root, x footprint');
    R(mark, c, 'markSpearTo', 0.2, 1.4, 0.01, 'spear point, x footprint');
    R(mark, c, 'markSpearWidth', 0.005, 0.3, 0.005, 'spear width');
    R(mark, c, 'markHooks', 0, 3, 0.01, 'hooks');
    R(mark, c, 'markHookCount', 1, 12, 1, 'hook count');
    R(mark, c, 'markHookSeat', 0.05, 0.8, 0.01, 'hook radius, x footprint');
    R(mark, c, 'markHookSweep', 0.1, 3, 0.01, 'hook sweep (rad)');
    R(mark, c, 'markHookWidth', 0.005, 0.2, 0.002, 'hook width');
    R(mark, c, 'markHookSpin', -0.2, 0.2, 0.001, 'hook spin, rev/s');
    R(mark, c, 'markRibs', 0, 2, 0.01, 'edge combs');
    R(mark, c, 'markRibCount', 1, 30, 1, 'combs per edge');
    R(mark, c, 'markRibLength', 0.02, 0.6, 0.01, 'comb length');
    R(mark, c, 'markRibWidth', 0.02, 0.8, 0.01, 'comb width');
    R(mark, c, 'markTicks', 0, 2, 0.01, 'rim ticks');
    R(mark, c, 'markTickCount', 4, 120, 1, 'tick count');
    R(mark, c, 'markTickSeat', 0.3, 1.2, 0.01, 'tick seat, x footprint');
    R(mark, c, 'markTickLength', 0.01, 0.3, 0.005, 'tick length');
    R(mark, c, 'markHub', 0, 3, 0.01, 'hub');
    R(mark, c, 'markHubRing', 0.02, 0.5, 0.005, 'hub ring, x footprint');
    R(mark, c, 'markHubDot', 0.005, 0.3, 0.005, 'hub dot, x footprint');
    R(mark, c, 'markWash', 0, 2, 0.01, 'fill inside the star');
    R(mark, c, 'markWashFalloff', 0.1, 6, 0.05, 'fill falloff');
    R(mark, c, 'markGrain', 0, 2, 0.01, 'grain');
    R(mark, c, 'markGrainScale', 0.1, 8, 0.05, 'grain scale');
    R(mark, c, 'markHeight', 0, 0.2, 0.001, 'height off floor');
    R(mark, c, 'markOpacity', 0, 2, 0.01, 'opacity');
    R(mark, c, 'markGlow', 0, 4, 0.01, 'glow');
    mark.addColor(c, 'colorMarkLine').name('line');
    mark.addColor(c, 'colorMarkCore').name('line core');
    mark.addColor(c, 'colorMarkDeep').name('deep fill');
    mark.addColor(c, 'colorMarkWash').name('wash');
    mark.addColor(c, 'colorFront').name('cutting edge');

    const wisp = folder.addFolder('2 · The rising wisps');
    R(wisp, c, 'wisps', 0, 28, 1, 'wisps');
    R(wisp, c, 'wispSeat', 0.05, 1.4, 0.01, 'foot, x footprint');
    R(wisp, c, 'wispSeatJitter', 0, 1, 0.01, 'foot scatter');
    R(wisp, c, 'wispSpread', 0, 3, 0.01, 'bearing scatter');
    R(wisp, c, 'wispHeight', 0.5, 14, 0.05, 'climb (m)');
    R(wisp, c, 'wispHeightJitter', 0, 1, 0.01, 'climb scatter');
    R(wisp, c, 'wispRise', 0.01, 1.5, 0.005, 'climbs / second');
    R(wisp, c, 'wispLength', 0.05, 1.5, 0.01, 'ribbon length');
    R(wisp, c, 'wispWander', 0, 3, 0.01, 'wander (m)');
    R(wisp, c, 'wispWanderScale', 0.1, 8, 0.05, 'wander scale');
    R(wisp, c, 'wispWanderSpeed', 0, 3, 0.01, 'wander speed');
    R(wisp, c, 'wispSwirl', -4, 4, 0.01, 'turn while climbing');
    R(wisp, c, 'wispDraw', 0, 1.5, 0.01, 'drawn into the burst');
    R(wisp, c, 'wispDrawAt', 0, 0.98, 0.01, '... starting at');
    R(wisp, c, 'wispWidth', 0.005, 0.4, 0.005, 'width, x climb');
    R(wisp, c, 'wispWidthBias', 0.05, 3, 0.01, 'how fast it thins');
    R(wisp, c, 'wispIntensity', 0, 4, 0.01, 'intensity');
    R(wisp, c, 'wispSoftEdge', 0.1, 5, 0.05, 'edge softness');
    R(wisp, c, 'wispErode', 0, 1, 0.01, 'break-up');
    R(wisp, c, 'wispErodeScale', 0.2, 10, 0.05, 'break-up scale');
    R(wisp, c, 'wispErodeSpeed', 0, 4, 0.01, 'break-up speed');
    R(wisp, c, 'wispTailFade', 0.01, 0.6, 0.01, 'fade in over');
    R(wisp, c, 'wispHeadFade', 0.01, 0.9, 0.01, 'fade out over');
    R(wisp, c, 'wispSoftFade', 0, 3, 0.01, 'soft fade (m)');
    R(wisp, c, 'wispOpacity', 0, 2, 0.01, 'opacity');
    R(wisp, c, 'wispGlow', 0, 4, 0.01, 'glow');
    wisp.addColor(c, 'colorWispRoot').name('root');
    wisp.addColor(c, 'colorWispBody').name('body');
    wisp.addColor(c, 'colorWispTip').name('tip');

    const burst = folder.addFolder('3 · The core mesh burst');
    R(burst, c, 'crownScale', 0.2, 5, 0.01, 'burst size');
    R(burst, c, 'crownHeight', 0.5, 10, 0.05, 'hangs at (m)');
    R(burst, c, 'crownRise', 0, 4, 0.01, 'climbs while forming (m)');
    R(burst, c, 'crownBob', 0, 0.5, 0.005, 'breathes (m)');
    R(burst, c, 'crownBobSpeed', 0, 3, 0.01, 'breath speed');
    R(burst, c, 'crownSpin', -1, 1, 0.005, 'spin, rev/s');
    R(burst, c, 'crownTilt', 0, 1.5, 0.01, 'nod (rad)');
    R(burst, c, 'crownTiltSpeed', 0, 1, 0.005, 'nod speed, rev/s');
    R(burst, c, 'crownSpears', 0, 24, 1, 'long spears');
    R(burst, c, 'crownBlades', 0, 32, 1, 'blades');
    R(burst, c, 'crownShards', 0, 32, 1, 'short shards');
    R(burst, c, 'spearLength', 0.1, 4, 0.01, 'spear length, x size');
    R(burst, c, 'bladeLength', 0.1, 3, 0.01, 'blade length, x size');
    R(burst, c, 'shardLength', 0.05, 2, 0.01, 'shard length, x size');
    R(burst, c, 'crownLengthJitter', 0, 1, 0.01, 'length scatter');
    R(burst, c, 'crownFlatten', 0.05, 1.5, 0.01, 'squashed toward the plane');
    R(burst, c, 'crownJitter', 0, 1, 0.01, 'heading scatter');
    R(burst, c, 'crownInner', 0, 1, 0.005, 'root seat, x size');
    R(burst, c, 'crownStagger', 0, 0.95, 0.01, 'assembly stagger');
    R(burst, c, 'crownSwell', 0, 1, 0.01, 'bank opens the crown');
    R(burst, c, 'crownViolet', 0, 1, 0.01, 'violet share');
    R(burst, c, 'crownRegrow', 0.05, 6, 0.05, 'a blade grows back in (s)');
    R(burst, c, 'crownRegrowDelay', 0, 4, 0.01, '... after waiting (s)');

    const blade = burst.addFolder('The blade itself');
    R(blade, c, 'bladeWaist', 0.02, 0.95, 0.01, 'widest at');
    R(blade, c, 'bladeRootPower', 0.05, 3, 0.01, 'swell off the root');
    R(blade, c, 'bladeTipPower', 0.05, 4, 0.01, 'draw to the point');
    R(blade, c, 'bladeWidth', 0.01, 0.5, 0.005, 'half-width, x length');
    R(blade, c, 'bladeThick', 0.02, 2, 0.01, 'thickness, x width');
    R(blade, c, 'bladeEdge', 0.05, 3, 0.01, 'edge pinch');
    R(blade, c, 'bladeBow', 0, 0.4, 0.005, 'bow, x length');
    R(blade, c, 'bladeTwist', -3, 3, 0.01, 'twist (rad)');
    R(blade, c, 'bladeEdgeGlow', 0, 8, 0.01, 'edge glow');
    R(blade, c, 'bladeEdgePower', 0.5, 16, 0.1, 'edge tightness');
    R(blade, c, 'bladeRim', 0, 4, 0.01, 'rim');
    R(blade, c, 'bladeRimPower', 0.1, 8, 0.05, 'rim power');
    R(blade, c, 'bladeTipGlow', 0, 6, 0.01, 'point glow');
    R(blade, c, 'bladeTipStart', 0, 0.98, 0.01, 'point starts at');
    R(blade, c, 'bladeVein', 0, 4, 0.01, 'flaws');
    R(blade, c, 'bladeVeinScale', 0.2, 20, 0.1, 'flaw scale');
    R(blade, c, 'bladeVeinBands', 0.2, 12, 0.1, 'flaws around it');
    R(blade, c, 'bladeVeinSharp', 0.2, 8, 0.05, 'flaw sharpness');
    R(blade, c, 'bladeHeartBleed', 0, 6, 0.01, 'lit by the heart');
    R(blade, c, 'bladeHeartReach', 0.1, 8, 0.05, '... within (m)');
    R(blade, c, 'bladeChargeGain', 0, 6, 0.01, 'charge gain');
    R(blade, c, 'bladeBurnGlow', 0, 12, 0.05, 'burn edge');
    R(blade, c, 'bladeRoughness', 0.02, 1, 0.01, 'roughness');
    R(blade, c, 'bladeMetalness', 0, 1, 0.01, 'metalness');
    R(blade, c, 'bladeEnv', 0, 3, 0.01, 'env (IBL)');
    R(blade, c, 'bladeGlow', 0, 4, 0.01, 'glow');
    blade.addColor(c, 'colorBladeBody').name('teal body');
    blade.addColor(c, 'colorBladeFacet').name('teal facet');
    blade.addColor(c, 'colorBladeBodyDeep').name('violet body');
    blade.addColor(c, 'colorBladeFacetDeep').name('violet facet');
    blade.addColor(c, 'colorBladeEdge').name('edges');
    blade.addColor(c, 'colorBladeVein').name('flaws');
    blade.addColor(c, 'colorBladeHot').name('point');

    const heart = burst.addFolder('The heart and its halo');
    R(heart, c, 'heartSize', 0.02, 1.5, 0.01, 'radius, x size');
    R(heart, c, 'heartSwell', 0, 2, 0.01, 'swell at full charge');
    R(heart, c, 'heartBoil', 0, 1, 0.005, 'silhouette churn');
    R(heart, c, 'heartBoilScale', 0.2, 8, 0.05, 'churn scale');
    R(heart, c, 'heartFill', 0.05, 6, 0.01, 'weighted to the axis');
    R(heart, c, 'heartRim', 0, 4, 0.01, 'rim');
    R(heart, c, 'heartRimPower', 0.1, 8, 0.05, 'rim power');
    R(heart, c, 'heartFilament', 0, 4, 0.01, 'threads');
    R(heart, c, 'heartFilamentScale', 0.2, 12, 0.05, 'thread scale');
    R(heart, c, 'heartFilamentSpeed', 0, 4, 0.01, 'thread speed');
    R(heart, c, 'heartIntensity', 0, 6, 0.01, 'intensity');
    R(heart, c, 'heartChargeGain', 0, 8, 0.01, 'charge gain');
    R(heart, c, 'heartSoftFade', 0, 3, 0.01, 'soft fade (m)');
    R(heart, c, 'haloSize', 0.1, 8, 0.05, 'halo radius, x size');
    R(heart, c, 'haloGlow', 0, 4, 0.01, 'halo glow');
    R(heart, c, 'haloFalloff', 0.2, 8, 0.05, 'halo falloff');
    R(heart, c, 'haloRays', 0, 3, 0.01, 'spokes');
    R(heart, c, 'haloRayCount', 1, 48, 1, 'spoke count');
    R(heart, c, 'haloRaySharp', 0.5, 24, 0.5, 'spoke sharpness');
    R(heart, c, 'haloRaySpin', -1, 1, 0.005, 'spoke spin, rev/s');
    R(heart, c, 'haloRingSeat', 0.05, 0.98, 0.01, 'ring seat');
    R(heart, c, 'haloRingWidth', 0.005, 0.4, 0.005, 'ring width');
    heart.addColor(c, 'colorHeartCore').name('heart core');
    heart.addColor(c, 'colorHeart').name('heart');
    heart.addColor(c, 'colorHeartEdge').name('heart edge');
    heart.addColor(c, 'colorHaloInner').name('halo inner');
    heart.addColor(c, 'colorHaloOuter').name('halo outer');

    const throwFolder = folder.addFolder('What it throws');
    throwFolder.add(c, 'throwEnabled').name('throws blades');
    R(throwFolder, c, 'throwRange', 1, 40, 0.1, 'reach (m)');
    R(throwFolder, c, 'throwInterval', 0.05, 5, 0.01, 'between flurries (s)');
    R(throwFolder, c, 'throwWarmup', 0.01, 3, 0.01, 'winds up for (s)');
    R(throwFolder, c, 'throwTargets', 1, 6, 1, 'bodies per flurry');
    R(throwFolder, c, 'throwBlades', 1, 6, 1, 'blades per body');
    R(throwFolder, c, 'throwStagger', 0, 0.6, 0.005, 'between blades (s)');
    R(throwFolder, c, 'throwAim', 0, 1, 0.01, 'where up the body');
    R(throwFolder, c, 'throwLife', 0.05, 3, 0.01, 'on screen for (s)');
    R(throwFolder, c, 'throwStrike', 0.02, 0.95, 0.01, 'arrives at');
    R(throwFolder, c, 'throwHold', 0.05, 1, 0.01, 'starts to go at');
    R(throwFolder, c, 'throwLength', 0.1, 4, 0.01, 'blade length (m)');
    R(throwFolder, c, 'throwSmear', 0, 3, 0.01, 'speed smear');
    R(throwFolder, c, 'throwSpin', 0, 8, 0.05, 'spin, rev/life');
    R(throwFolder, c, 'throwCurve', 0, 1, 0.01, 'bow off the line');
    R(throwFolder, c, 'throwLoft', -0.5, 0.5, 0.005, 'lift off the line');
    R(throwFolder, c, 'throwOverrun', 0, 8, 0.05, 'carries on past (m)');
    R(throwFolder, c, 'throwHeat', 0, 4, 0.01, 'runs hotter by');
    R(throwFolder, c, 'throwFlare', 0, 8, 0.05, 'flare as it lands');
    R(throwFolder, c, 'throwShake', 0, 1, 0.005, 'throw shake');
    R(throwFolder, c, 'throwFlash', 0, 1, 0.005, 'throw flash');

    const cut = throwFolder.addFolder('The cut');
    R(cut, c.cutHit, 'impulse', 0, 20, 0.1, 'impulse');
    R(cut, c.cutHit, 'lift', 0, 20, 0.1, 'lift');
    R(cut, c.cutHit, 'spin', 0, 10, 0.05, 'spin');
    R(cut, c, 'cutSparks', 0, 400, 1, 'sparks');
    R(cut, c, 'cutMotes', 0, 300, 1, 'motes');
    R(cut, c, 'cutChips', 0, 150, 1, 'chips');
    R(cut, c, 'cutSpeed', 0, 20, 0.1, 'spray speed');
    R(cut, c, 'cutBurst', 0, 4, 0.01, 'pressure shell (m)');
    R(cut, c, 'cutShake', 0, 1, 0.005, 'shake');
    R(cut, c, 'cutFlash', 0, 1, 0.005, 'flash');
    R(cut, c, 'grazeSparks', 0, 200, 1, 'sparks off a graze');
    R(cut, c, 'launchSparks', 0, 200, 1, 'sparks off the launch');
    R(cut, c, 'launchChips', 0, 60, 1, 'chips off the launch');
    R(cut, c, 'trailRate', 0, 600, 5, 'trail sparks / s');

    const particles = folder.addFolder('5 · Motes, sparks, chips and mist');
    R(particles, c, 'moteRate', 0, 400, 1, 'motes / s');
    R(particles, c, 'moteSize', 0.005, 0.4, 0.005, 'mote size');
    R(particles, c, 'moteLifetime', 0.1, 8, 0.05, 'mote life');
    R(particles, c, 'moteSpeed', 0, 8, 0.05, 'mote speed');
    R(particles, c, 'moteRise', -4, 4, 0.05, 'mote rise');
    R(particles, c, 'moteTurbulence', 0, 3, 0.01, 'mote turbulence');
    R(particles, c, 'moteSeat', 0, 1.5, 0.01, 'lifted out to');
    Editor.gradient(particles, c, 'colorMote', 'mote gradient');
    R(particles, c, 'sparkSize', 0.005, 0.4, 0.005, 'spark size');
    R(particles, c, 'sparkLifetime', 0.05, 4, 0.05, 'spark life');
    R(particles, c, 'sparkSpeed', 0, 30, 0.1, 'spark speed');
    R(particles, c, 'sparkGravity', -20, 5, 0.1, 'spark gravity');
    Editor.gradient(particles, c, 'colorSpark', 'spark gradient');
    R(particles, c, 'chipSize', 0.005, 0.4, 0.005, 'chip size');
    R(particles, c, 'chipLifetime', 0.1, 8, 0.05, 'chip life');
    R(particles, c, 'chipSpeed', 0, 20, 0.1, 'chip speed');
    R(particles, c, 'chipGravity', -30, 5, 0.1, 'chip gravity');
    R(particles, c, 'chipSpin', 0, 20, 0.1, 'chip spin');
    Editor.gradient(particles, c, 'colorChip', 'chip gradient');
    R(particles, c, 'mistRate', 0, 60, 0.5, 'mist / s');
    R(particles, c, 'mistSize', 0.05, 4, 0.05, 'mist size');
    R(particles, c, 'mistLifetime', 0.2, 10, 0.05, 'mist life');
    R(particles, c, 'mistSpeed', 0, 6, 0.05, 'mist speed');
    R(particles, c, 'mistRise', -2, 3, 0.01, 'mist rise');
    R(particles, c, 'mistSeat', 0, 1.5, 0.01, 'mist seat');
    R(particles, c, 'mistOpacity', 0, 1, 0.01, 'mist opacity');
    Editor.gradient(particles, c, 'colorMist', 'mist gradient');

    const impact = folder.addFolder('Impact, camera and light');
    R(impact, c, 'castMotes', 0, 200, 1, 'motes off the hand');
    R(impact, c, 'creepRate', 0, 200, 1, 'motes off the shard / s');
    R(impact, c, 'stainRate', 0.1, 10, 0.1, 'ground marks / m');
    R(impact, c, 'landMotes', 0, 600, 1, 'motes on landing');
    R(impact, c, 'landSparks', 0, 400, 1, 'sparks on landing');
    R(impact, c, 'landMist', 0, 120, 1, 'mist on landing');
    R(impact, c, 'landBurst', 0, 10, 0.05, 'landing shell (m)');
    R(impact, c, 'landIntensity', 0, 5, 0.01, 'landing shell glow');
    R(impact, c, 'landShake', 0, 2, 0.005, 'landing shake');
    R(impact, c, 'landFlash', 0, 1, 0.005, 'landing flash');
    R(impact, c, 'shakeDuration', 0.05, 3, 0.01, 'shake decay (s)');
    R(impact, c, 'crownMotes', 0, 600, 1, 'motes as it forms');
    R(impact, c, 'crownSparks', 0, 600, 1, 'sparks as it forms');
    R(impact, c, 'crownChips', 0, 200, 1, 'chips as it forms');
    R(impact, c, 'crownShake', 0, 1, 0.005, 'forming shake');
    R(impact, c, 'crownFlash', 0, 1, 0.005, 'forming flash');
    R(impact, c, 'muzzleSize', 0, 4, 0.01, 'hand flash (m)');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'hand flash glow');
    R(impact, c, 'castFlash', 0, 1, 0.005, 'cast flash');
    R(impact, c, 'holdShake', 0, 0.4, 0.001, 'standing rumble');
    R(impact, c, 'rumble', 0, 0.4, 0.001, 'travel rumble');
    R(impact, c, 'stainRadius', 0.05, 4, 0.05, 'stain radius');
    R(impact, c, 'stainLife', 0.1, 20, 0.1, 'stain life');
    R(impact, c, 'stainIntensity', 0, 3, 0.01, 'stain intensity');
    impact.addColor(c, 'colorStain').name('stain');
    impact.addColor(c, 'colorStainEdge').name('stain edge');
    impact.addColor(c, 'colorBurstA').name('burst core');
    impact.addColor(c, 'colorBurstB').name('burst mid');
    impact.addColor(c, 'colorBurstC').name('burst edge');
    impact.addColor(c, 'colorCastFlash').name('cast flash colour');
    impact.addColor(c, 'colorFlash').name('flash colour');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 80, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 40, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 1, 0.01, 'height in the burst');
    R(light, c, 'lightPulse', 0, 2, 0.01, 'bank owns');
    light.addColor(c, 'lightColor').name('light colour');

    this.cascadeFolder = folder;
  }

  /**
   * The Celestial Rend.
   *
   * Grouped by the four panels of its reference sheet, in the order they
   * happen — mark, tendrils, shards, then the divine impact split into the
   * column, the star and the halos — and then by what the rend does to a body.
   *
   * Three sliders re-scale the whole thing in proportion and are the ones worth
   * reaching for first: `zoneRadius` in "The cast" (nearly every horizontal
   * length is a multiple of it), `pillarHeight` in "4 · The column" (the star,
   * the halos and the shard ceiling all seat off it), and `chargeTime` in "The
   * order it happens in", which is the entire pacing of the piece.
   */
  _buildRend() {
    const folder = this.gui.addFolder('✧  Celestial Rend');
    const c = settings.rend;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 0.5, 14, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 200, 1, 'mote speed');
    R(cast, c, 'lifetime', 0.5, 20, 0.05, 'stands for (s)');
    R(cast, c, 'fadeTime', 0.05, 6, 0.01, 'closes over (s)');
    R(cast, c, 'cooldown', 0, 12, 0.05, 'cooldown');
    R(cast, c, 'handHeight', 0, 2.5, 0.01, 'hand height');
    R(cast, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(cast, c, 'handSide', -2, 2, 0.01, 'hand side');
    R(cast, c, 'trailMotes', 0, 200, 1, 'trail motes / m');
    R(cast, c, 'seedStarSize', 0, 1.5, 0.01, 'seed star, x footprint');
    R(cast, c, 'seedHeight', 0.2, 8, 0.05, 'seed height (m)');
    Editor.castAnimation(cast, c);

    const order = folder.addFolder('The order it happens in');
    R(order, c, 'sigilTime', 0.02, 3, 0.01, 'mark writes on over (s)');
    R(order, c, 'tendrilDelay', 0, 3, 0.01, 'tendrils start at (s)');
    R(order, c, 'tendrilTime', 0.05, 4, 0.01, 'tendrils rise over (s)');
    R(order, c, 'chargeTime', 0.1, 6, 0.01, 'shards come in over (s)');
    R(order, c, 'rendTime', 0.05, 3, 0.01, 'the rend takes (s)');
    R(order, c, 'pillarRise', 0.02, 3, 0.01, 'beam climbs in (s)');
    R(order, c, 'pulseRate', 0, 6, 0.01, 'toll rate');
    R(order, c, 'pulseDepth', 0, 1.5, 0.01, 'toll depth');

    /* ---- 1 ---- */
    const sigil = folder.addFolder('1 · The celestial mark');
    R(sigil, c, 'sigilHeight', 0.001, 0.2, 0.001, 'hover (m)');
    R(sigil, c, 'sigilLineWidth', 0.004, 0.2, 0.002, 'stroke width (m)');
    R(sigil, c, 'sigilLineGlow', 0, 6, 0.05, 'stroke glow');
    R(sigil, c, 'sigilOpacity', 0, 2, 0.01, 'opacity');
    R(sigil, c, 'sigilGlow', 0, 4, 0.01, 'glow');

    const sigilStar = sigil.addFolder('The star');
    R(sigilStar, c, 'sigilStar', 0, 3, 0.01, 'star');
    R(sigilStar, c, 'sigilStarPoints', 2, 12, 1, 'points');
    R(sigilStar, c, 'sigilStarOuter', 0.2, 2, 0.01, 'reach, x footprint');
    R(sigilStar, c, 'sigilStarSharp', 0.2, 8, 0.05, 'point sharpness');
    R(sigilStar, c, 'sigilStarSpin', -0.2, 0.2, 0.001, 'spin (rev/s)');
    R(sigilStar, c, 'sigilStarFill', 0, 2, 0.01, 'fill');
    R(sigilStar, c, 'sigilStarInner', 0, 3, 0.01, 'inner star');
    R(sigilStar, c, 'sigilStarInnerScale', 0.05, 1, 0.01, 'inner scale');

    const sigilRings = sigil.addFolder('The ring nest');
    R(sigilRings, c, 'sigilRings', 0, 3, 0.01, 'rings');
    R(sigilRings, c, 'sigilRingCount', 1, 8, 1, 'how many');
    R(sigilRings, c, 'sigilRingInner', 0.02, 1.5, 0.01, 'innermost, x footprint');
    R(sigilRings, c, 'sigilRingSpread', 0, 1.5, 0.01, 'spread past it');
    R(sigilRings, c, 'sigilRingWobble', 0, 0.12, 0.002, 'boundary wander');
    R(sigilRings, c, 'sigilRingWobbleLobes', 1, 16, 1, 'wander lobes');

    const sigilMarks = sigil.addFolder('Glyphs, ticks & cracks');
    R(sigilMarks, c, 'sigilGlyphs', 0, 3, 0.01, 'glyphs');
    R(sigilMarks, c, 'sigilGlyphCount', 1, 16, 1, 'how many');
    R(sigilMarks, c, 'sigilGlyphSeat', 0.05, 1.5, 0.01, 'seat, x footprint');
    R(sigilMarks, c, 'sigilGlyphSize', 0.01, 0.5, 0.005, 'size, x footprint');
    R(sigilMarks, c, 'sigilGlyphSpin', -0.2, 0.2, 0.001, 'spin (rev/s)');
    R(sigilMarks, c, 'sigilTicks', 0, 3, 0.01, 'ticks');
    R(sigilMarks, c, 'sigilTickCount', 4, 120, 1, 'how many');
    R(sigilMarks, c, 'sigilTickSeat', 0.2, 2, 0.01, 'seat, x footprint');
    R(sigilMarks, c, 'sigilTickLength', 0.01, 0.5, 0.005, 'length, x footprint');
    R(sigilMarks, c, 'sigilTickSpin', -0.2, 0.2, 0.001, 'spin (rev/s)');
    R(sigilMarks, c, 'sigilCracks', 0, 3, 0.01, 'cracks (after the rend)');
    R(sigilMarks, c, 'sigilCrackCount', 1, 24, 1, 'how many');
    R(sigilMarks, c, 'sigilCrackSeat', 0.2, 2.5, 0.01, 'reach, x footprint');
    R(sigilMarks, c, 'sigilCrackWander', 0, 1.5, 0.01, 'fork off radius');
    R(sigilMarks, c, 'sigilCrackWidth', 0.005, 0.4, 0.005, 'width, x footprint');

    const sigilWash = sigil.addFolder('Wash & colour');
    R(sigilWash, c, 'sigilWash', 0, 2, 0.01, 'wash');
    R(sigilWash, c, 'sigilWashFalloff', 0.05, 6, 0.05, 'wash falloff');
    R(sigilWash, c, 'sigilGrain', 0, 2, 0.01, 'grain');
    R(sigilWash, c, 'sigilGrainScale', 0.1, 8, 0.05, 'grain scale');
    sigilWash.addColor(c, 'colorSigilLine').name('line');
    sigilWash.addColor(c, 'colorSigilCore').name('core');
    sigilWash.addColor(c, 'colorSigilDeep').name('deep');
    sigilWash.addColor(c, 'colorSigilWash').name('wash');
    sigilWash.addColor(c, 'colorFront').name('writing edge');

    /* ---- 2 ---- */
    const tendril = folder.addFolder('2 · The astral tendrils');
    R(tendril, c, 'tendrils', 1, 40, 1, 'how many');
    R(tendril, c, 'tendrilSeat', 0.05, 2, 0.01, 'seat, x footprint');
    R(tendril, c, 'tendrilSeatJitter', 0, 1, 0.01, 'seat jitter');
    R(tendril, c, 'tendrilSpread', 0, 3, 0.01, 'bearing jitter');
    R(tendril, c, 'tendrilReach', 0.1, 1.5, 0.01, 'climb, x column height');
    R(tendril, c, 'tendrilCharge', 0.02, 1.5, 0.01, '... before the rend');
    R(tendril, c, 'tendrilHeightJitter', 0, 1, 0.01, 'height jitter');
    R(tendril, c, 'tendrilRise', 0, 1.5, 0.005, 'loops / second');
    R(tendril, c, 'tendrilLength', 0.05, 2, 0.01, 'span of one ribbon');
    R(tendril, c, 'tendrilWind', 0, 6, 0.05, 'turns over the climb');
    R(tendril, c, 'tendrilShear', 0, 4, 0.01, 'differential winding');
    R(tendril, c, 'tendrilCounter', 0, 1, 0.01, 'fraction winding back');
    R(tendril, c, 'tendrilFlare', 0.02, 2, 0.01, 'seat closes to');
    R(tendril, c, 'tendrilDraw', 0, 1, 0.01, 'drawn onto the axis');
    R(tendril, c, 'tendrilDrawAt', 0, 0.98, 0.01, '... starting at');
    R(tendril, c, 'tendrilWander', 0, 3, 0.01, 'wander (m)');
    R(tendril, c, 'tendrilWanderScale', 0.1, 6, 0.05, 'wander scale');
    R(tendril, c, 'tendrilWanderSpeed', 0, 3, 0.01, 'wander speed');
    R(tendril, c, 'tendrilWidth', 0.002, 0.2, 0.001, 'width, x height');
    R(tendril, c, 'tendrilWidthBias', 0.05, 3, 0.01, 'thins with climb');
    R(tendril, c, 'tendrilHead', 0, 3, 0.01, 'the head band');
    R(tendril, c, 'tendrilHeadWidth', 0.01, 0.5, 0.005, 'head width');
    R(tendril, c, 'tendrilHeadRate', 0, 3, 0.01, 'head speed');
    R(tendril, c, 'tendrilIntensity', 0, 6, 0.05, 'intensity');
    R(tendril, c, 'tendrilSoftEdge', 0.05, 5, 0.05, 'edge softness');
    R(tendril, c, 'tendrilErode', 0, 1, 0.01, 'erosion');
    R(tendril, c, 'tendrilErodeScale', 0.1, 10, 0.05, 'erosion scale');
    R(tendril, c, 'tendrilErodeSpeed', 0, 4, 0.01, 'erosion speed');
    R(tendril, c, 'tendrilHeadFade', 0, 0.9, 0.01, 'top fade');
    R(tendril, c, 'tendrilTailFade', 0, 0.9, 0.01, 'root fade');
    R(tendril, c, 'tendrilSoftFade', 0, 3, 0.01, 'soft particle fade');
    R(tendril, c, 'tendrilOpacity', 0, 2, 0.01, 'opacity');
    R(tendril, c, 'tendrilGlow', 0, 4, 0.01, 'glow');
    tendril.addColor(c, 'colorTendrilRoot').name('root');
    tendril.addColor(c, 'colorTendrilWarm').name('warm strand');
    tendril.addColor(c, 'colorTendrilCold').name('cold strand');
    tendril.addColor(c, 'colorTendrilTip').name('filament / head');

    /* ---- 3 ---- */
    const shard = folder.addFolder('3 · The radiant shards');
    R(shard, c, 'shardDensity', 0, 1, 0.01, 'density');
    R(shard, c, 'shardSize', 0.1, 6, 0.05, 'length (m)');
    R(shard, c, 'shardGirth', 0.2, 4, 0.05, 'thickness, x that');

    const inbound = shard.addFolder('Coming in');
    R(inbound, c, 'shardReach', 0.5, 8, 0.05, 'come in from, x footprint');
    R(inbound, c, 'shardFlight', 0.1, 3, 0.01, 'seconds to cross it');
    R(inbound, c, 'shardLoft', 0, 3, 0.01, 'start height, x column');
    R(inbound, c, 'shardCurve', 0, 3, 0.01, 'bow off a radius');
    R(inbound, c, 'shardRoll', 0, 3, 0.01, 'roll (rev/s)');
    R(inbound, c, 'trailRate', 0, 300, 1, 'streaks / second');

    const thrown = shard.addFolder('Thrown clear');
    R(thrown, c, 'shardScatter', 0, 4, 0.01, 'throw spread (s)');
    R(thrown, c, 'shardSettle', 0.05, 5, 0.01, 'settles over (s)');
    R(thrown, c, 'shardOrbit', 0.1, 4, 0.01, 'orbit, x footprint');
    R(thrown, c, 'shardCeiling', 0.02, 1.5, 0.01, 'ceiling, x column');
    R(thrown, c, 'shardDrift', 0, 4, 0.01, 'keeps rising (m/s)');
    R(thrown, c, 'shardSpin', 0, 3, 0.01, 'orbit rate (rad/s)');
    R(thrown, c, 'shardTumble', 0, 2, 0.01, 'tumble (rev/s)');
    R(thrown, c, 'shardDebris', 0.1, 2, 0.01, 'size, x length');

    const crystal = shard.addFolder('The crystal');
    R(crystal, c, 'shardFresnel', 0, 6, 0.05, 'rim');
    R(crystal, c, 'shardFresnelPower', 0.2, 8, 0.05, 'rim power');
    R(crystal, c, 'shardVein', 0, 6, 0.05, 'flaws');
    R(crystal, c, 'shardVeinScale', 0.5, 20, 0.1, 'flaw scale');
    R(crystal, c, 'shardVeinSharp', 0.5, 8, 0.05, 'flaw sharpness');
    R(crystal, c, 'shardSpine', 0, 6, 0.05, 'lit spine');
    R(crystal, c, 'shardSpinePower', 0.2, 8, 0.05, 'spine power');
    R(crystal, c, 'shardGlint', 0, 4, 0.05, 'glints');
    R(crystal, c, 'shardGlintScale', 2, 80, 1, 'glint scale');
    R(crystal, c, 'shardHeatGlow', 0, 20, 0.1, 'white-out on arrival');
    R(crystal, c, 'shardBeamBleed', 0, 6, 0.05, 'lit by the column');
    R(crystal, c, 'shardBeamRadius', 0.5, 30, 0.1, '... out to (m)');
    R(crystal, c, 'shardRoughness', 0, 1, 0.01, 'roughness');
    R(crystal, c, 'shardMetalness', 0, 1, 0.01, 'metalness');
    R(crystal, c, 'shardEnvIntensity', 0, 3, 0.01, 'env intensity');
    crystal.addColor(c, 'colorShardBody').name('body');
    crystal.addColor(c, 'colorShardFacet').name('facet');
    crystal.addColor(c, 'colorShardWarm').name('warm rim');
    crystal.addColor(c, 'colorShardCold').name('cold rim');
    crystal.addColor(c, 'colorShardVein').name('flaws');
    crystal.addColor(c, 'colorShardHot').name('incandescent');

    /* ---- 4 ---- */
    const pillar = folder.addFolder('4 · The column');
    R(pillar, c, 'pillarHeight', 2, 80, 0.5, 'height (m)');
    R(pillar, c, 'pillarRadius', 0.02, 2, 0.01, 'radius, x footprint');
    R(pillar, c, 'pillarSkirt', 0, 4, 0.01, 'skirt at the floor');
    R(pillar, c, 'pillarSkirtPower', 0.5, 12, 0.05, 'skirt falloff');
    R(pillar, c, 'pillarTopFlare', 0.2, 3, 0.01, 'flare at the top');
    R(pillar, c, 'pillarFlarePower', 0.1, 6, 0.05, 'flare falloff');
    R(pillar, c, 'pillarWobble', 0, 0.6, 0.005, 'barrel wobble');
    R(pillar, c, 'pillarWobbleScale', 0.1, 6, 0.05, 'wobble scale');
    R(pillar, c, 'pillarWobbleSpeed', 0, 6, 0.05, 'wobble speed');
    R(pillar, c, 'pillarSpin', -1, 1, 0.005, 'barrel spin (rev/s)');
    R(pillar, c, 'pillarBodyPower', 0.05, 4, 0.01, 'chord falloff');
    R(pillar, c, 'pillarCorePower', 0.5, 24, 0.1, 'filament falloff');
    R(pillar, c, 'pillarCore', 0, 6, 0.05, 'filament');
    R(pillar, c, 'pillarRim', 0, 4, 0.01, 'caustic edge');
    R(pillar, c, 'pillarRimPower', 0.1, 8, 0.05, 'edge power');
    R(pillar, c, 'pillarFlutes', 1, 80, 1, 'flutes');
    R(pillar, c, 'pillarFluteSharp', 0.05, 4, 0.01, 'flute sharpness');
    R(pillar, c, 'pillarFluteDepth', 0, 1, 0.01, 'flute depth');
    R(pillar, c, 'pillarFluteDrift', -0.5, 0.5, 0.005, 'flute drift');
    R(pillar, c, 'pillarStreamScale', 0.05, 5, 0.01, 'stream scale');
    R(pillar, c, 'pillarStreamSpeed', 0, 8, 0.05, 'stream speed');
    R(pillar, c, 'pillarHeadFade', 0, 0.95, 0.01, 'top fade');
    R(pillar, c, 'pillarFootGlow', 0, 6, 0.05, 'foot glow');
    R(pillar, c, 'pillarFootReach', 0.01, 1, 0.005, 'foot reach');
    R(pillar, c, 'pillarSoftFade', 0, 3, 0.01, 'soft particle fade');
    R(pillar, c, 'pillarIntensity', 0, 8, 0.05, 'intensity');
    R(pillar, c, 'pillarOpacity', 0, 2, 0.01, 'opacity');
    R(pillar, c, 'pillarGlow', 0, 4, 0.01, 'glow');
    R(pillar, c, 'pillarSparks', 0, 600, 5, 'sparks up the shaft');
    pillar.addColor(c, 'colorPillarCore').name('filament');
    pillar.addColor(c, 'colorPillarBody').name('body');
    pillar.addColor(c, 'colorPillarEdge').name('upper');
    pillar.addColor(c, 'colorPillarCool').name('caustic edge');

    const star = folder.addFolder('4 · The star');
    R(star, c, 'starSeat', 0, 1.2, 0.01, 'seat, x column height');
    R(star, c, 'starSize', 0.1, 4, 0.01, 'size, x footprint');
    R(star, c, 'starDelay', 0, 2, 0.01, 'opens at (s after rend)');
    R(star, c, 'starTime', 0.05, 3, 0.01, 'opens over (s)');
    R(star, c, 'starBob', 0, 3, 0.01, 'drift (m)');
    R(star, c, 'starBobSpeed', 0, 2, 0.01, 'drift speed');
    R(star, c, 'starVertical', 0, 3, 0.01, 'vertical points');
    R(star, c, 'starVerticalSharp', 0.5, 24, 0.1, '... sharpness');
    R(star, c, 'starHorizontal', 0, 3, 0.01, 'horizontal points');
    R(star, c, 'starHorizontalSharp', 0.5, 24, 0.1, '... sharpness');
    R(star, c, 'starDiagonal', 0, 3, 0.01, 'diagonal points');
    R(star, c, 'starDiagonalSharp', 0.5, 24, 0.1, '... sharpness');
    R(star, c, 'starReach', 0.02, 1.5, 0.005, 'point reach');
    R(star, c, 'starFalloff', 0.2, 8, 0.05, 'point shading');
    R(star, c, 'starHalo', 0, 3, 0.01, 'bloom around them');
    R(star, c, 'starCore', 0.005, 0.5, 0.005, 'core size');
    R(star, c, 'starCoreGain', 0, 6, 0.05, 'core gain');
    R(star, c, 'starNeedles', 0, 2, 0.01, 'needle spray');
    R(star, c, 'starNeedleCount', 4, 120, 1, 'needles');
    R(star, c, 'starNeedleSharp', 0.5, 30, 0.1, 'needle sharpness');
    R(star, c, 'starNeedleReach', 0, 2, 0.01, 'needle reach');
    R(star, c, 'starNeedleSpin', -0.2, 0.2, 0.001, 'needle spin');
    R(star, c, 'starRing', 0, 3, 0.01, 'the struck circle');
    R(star, c, 'starRingSeat', 0.02, 1.2, 0.01, 'circle seat');
    R(star, c, 'starRingWidth', 0.002, 0.2, 0.002, 'circle width');
    R(star, c, 'starFlicker', 0, 1, 0.01, 'flicker');
    R(star, c, 'starFlickerRate', 0, 12, 0.1, 'flicker rate');
    R(star, c, 'starIntensity', 0, 8, 0.05, 'intensity');
    R(star, c, 'starOpacity', 0, 2, 0.01, 'opacity');
    R(star, c, 'starGlow', 0, 4, 0.01, 'glow');
    star.addColor(c, 'colorStarCore').name('core');
    star.addColor(c, 'colorStarBody').name('body');
    star.addColor(c, 'colorStarEdge').name('edge');
    star.addColor(c, 'colorStarCool').name('cold tips');

    const halo = folder.addFolder('4 · The halo rings');
    R(halo, c, 'haloRadius', 0.2, 4, 0.01, 'outer, x footprint');
    R(halo, c, 'haloSeat', 0.72, 1, 0.005, 'band seat');
    R(halo, c, 'haloBand', 0.01, 0.28, 0.005, 'band depth');
    R(halo, c, 'haloSecond', 0.2, 1.5, 0.01, 'second ring, x first');
    R(halo, c, 'haloDelay', 0, 2, 0.01, 'opens at (s after rend)');
    R(halo, c, 'haloStagger', 0, 1, 0.01, 'the two, apart (s)');
    R(halo, c, 'haloTime', 0.05, 3, 0.01, 'writes round in (s)');
    R(halo, c, 'haloTilt', 0, 1.4, 0.01, 'lean (rad)');
    R(halo, c, 'haloSpin', -1, 1, 0.005, 'spin (rev/s)');
    R(halo, c, 'haloLift', 0, 1.5, 0.01, 'apart, x footprint');
    R(halo, c, 'haloRails', 0, 4, 0.01, 'rails');
    R(halo, c, 'haloRailWidth', 0.002, 0.3, 0.002, 'rail width');
    R(halo, c, 'haloDashes', 0, 1, 0.01, 'dashes');
    R(halo, c, 'haloDashCount', 4, 160, 1, 'how many');
    R(halo, c, 'haloDashDuty', 0.05, 0.95, 0.01, 'dash duty');
    R(halo, c, 'haloDashDrift', -0.4, 0.4, 0.005, 'dash drift');
    R(halo, c, 'haloGlyphs', 0, 3, 0.01, 'beads');
    R(halo, c, 'haloGlyphCount', 2, 40, 1, 'how many');
    R(halo, c, 'haloGlyphSize', 0.002, 0.2, 0.002, 'bead size');
    R(halo, c, 'haloSweep', 0, 4, 0.01, 'lit limb');
    R(halo, c, 'haloSweepSharp', 0.1, 12, 0.05, 'limb sharpness');
    R(halo, c, 'haloSweepRate', -1, 1, 0.005, 'limb travel (rev/s)');
    R(halo, c, 'haloGrain', 0, 2, 0.01, 'grain');
    R(halo, c, 'haloGrainScale', 0.1, 10, 0.05, 'grain scale');
    R(halo, c, 'haloIntensity', 0, 8, 0.05, 'intensity');
    R(halo, c, 'haloOpacity', 0, 2, 0.01, 'opacity');
    R(halo, c, 'haloGlow', 0, 4, 0.01, 'glow');
    halo.addColor(c, 'colorHaloCore').name('rails / beads');
    halo.addColor(c, 'colorHaloBody').name('band');
    halo.addColor(c, 'colorHaloCool').name('cold edge');

    const warp = folder.addFolder('The air it shoves aside');
    R(warp, c, 'warpReach', 0.5, 4, 0.01, 'reach, x the shaft');
    R(warp, c, 'warpStrength', 0, 6, 0.05, 'strength');
    R(warp, c, 'warpRipples', 0, 20, 0.1, 'bands up its height');
    R(warp, c, 'warpSpeed', 0, 20, 0.1, 'band speed');
    R(warp, c, 'warpChop', 0, 3, 0.01, 'break-up');
    R(warp, c, 'warpChopScale', 0.1, 8, 0.05, 'break-up scale');

    /* ---- particles ---- */
    const particles = folder.addFolder('Particles');
    R(particles, c, 'moteRate', 0, 900, 5, 'motes / second');
    R(particles, c, 'moteSeat', 0, 2, 0.01, 'mote seat, x footprint');
    R(particles, c, 'moteSize', 0.005, 0.5, 0.005, 'mote size');
    R(particles, c, 'moteSpeed', 0, 12, 0.05, 'mote speed');
    R(particles, c, 'moteLifetime', 0.1, 6, 0.05, 'mote life');
    R(particles, c, 'moteRise', -6, 8, 0.05, 'mote rise');
    R(particles, c, 'moteTurbulence', 0, 3, 0.01, 'mote turbulence');
    Editor.gradient(particles, c, 'colorMote', 'Mote gradient');

    R(particles, c, 'sparkSize', 0.005, 0.5, 0.005, 'spark size');
    R(particles, c, 'sparkSpeed', 0, 30, 0.1, 'spark speed');
    R(particles, c, 'sparkLifetime', 0.05, 5, 0.05, 'spark life');
    R(particles, c, 'sparkGravity', -30, 10, 0.1, 'spark gravity');
    Editor.gradient(particles, c, 'colorSpark', 'Spark gradient');

    R(particles, c, 'chipSize', 0.01, 0.6, 0.005, 'chip size');
    R(particles, c, 'chipSpeed', 0, 30, 0.1, 'chip speed');
    R(particles, c, 'chipLifetime', 0.1, 6, 0.05, 'chip life');
    R(particles, c, 'chipGravity', -40, 0, 0.5, 'chip gravity');
    R(particles, c, 'chipSpin', 0, 3, 0.01, 'chip spin');
    Editor.gradient(particles, c, 'colorChip', 'Chip gradient');

    R(particles, c, 'dustRate', 0, 400, 1, 'dust / second');
    R(particles, c, 'dustSeat', 0, 2, 0.01, 'dust seat, x footprint');
    R(particles, c, 'dustSize', 0.05, 4, 0.05, 'dust size');
    R(particles, c, 'dustSpeed', 0, 12, 0.05, 'dust speed');
    R(particles, c, 'dustLifetime', 0.2, 8, 0.05, 'dust life');
    R(particles, c, 'dustRise', -4, 6, 0.05, 'dust rise');
    R(particles, c, 'dustOpacity', 0, 2, 0.01, 'dust opacity');
    Editor.gradient(particles, c, 'colorDust', 'Dust gradient');

    /* ---- the beats ---- */
    const impact = folder.addFolder('Cast, mark, strikes & rend');
    R(impact, c, 'castMotes', 0, 400, 1, 'cast motes');
    R(impact, c, 'castFlash', 0, 1, 0.01, 'cast flash');
    R(impact, c, 'muzzleSize', 0, 4, 0.05, 'muzzle size');
    R(impact, c, 'muzzleIntensity', 0, 4, 0.05, 'muzzle intensity');
    R(impact, c, 'markBurst', 0, 8, 0.05, 'mark burst');
    R(impact, c, 'markIntensity', 0, 4, 0.05, 'mark burst intensity');
    R(impact, c, 'markMotes', 0, 600, 5, 'mark motes');
    R(impact, c, 'markShake', 0, 2, 0.01, 'mark shake');
    R(impact, c, 'markFlash', 0, 1, 0.01, 'mark flash');
    R(impact, c, 'gildLife', 0.5, 30, 0.5, 'gilding life');
    R(impact, c, 'gildIntensity', 0, 3, 0.01, 'gilding intensity');
    R(impact, c, 'strikeSparks', 0, 120, 1, 'sparks / shard');
    R(impact, c, 'strikeChips', 0, 60, 1, 'chips / shard');
    R(impact, c, 'strikeShake', 0, 0.5, 0.005, 'shake / shard');
    R(impact, c, 'rendBurst', 0, 6, 0.05, 'rend burst, x footprint');
    R(impact, c, 'rendIntensity', 0, 5, 0.05, 'rend burst intensity');
    R(impact, c, 'shockRadius', 1, 50, 0.5, 'shock ring (m)');
    R(impact, c, 'crackRadius', 0.2, 6, 0.05, 'cracks, x footprint');
    R(impact, c, 'crackLife', 0.5, 30, 0.5, 'crack life');
    R(impact, c, 'crackIntensity', 0, 3, 0.01, 'crack intensity');
    R(impact, c, 'rendSparks', 0, 2000, 10, 'rend sparks');
    R(impact, c, 'rendMotes', 0, 1500, 10, 'rend motes');
    R(impact, c, 'rendChips', 0, 800, 5, 'rend chips');
    R(impact, c, 'rendDust', 0, 500, 5, 'rend dust');
    R(impact, c, 'rendShake', 0, 4, 0.01, 'rend shake');
    R(impact, c, 'shakeDuration', 0.05, 3, 0.01, 'shake decay (s)');
    R(impact, c, 'rendFlash', 0, 1.5, 0.01, 'rend flash');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'travel rumble');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, 'standing rumble');
    impact.addColor(c, 'colorBurstA').name('burst core');
    impact.addColor(c, 'colorBurstB').name('burst mid');
    impact.addColor(c, 'colorBurstC').name('burst edge');
    impact.addColor(c, 'colorCastFlash').name('cast flash colour');
    impact.addColor(c, 'colorFlash').name('rend flash colour');
    impact.addColor(c, 'colorGild').name('gilding');
    impact.addColor(c, 'colorGildEdge').name('gilding edge');
    impact.addColor(c, 'colorCrack').name('crack');
    impact.addColor(c, 'colorCrackEdge').name('crack edge');

    /* ---- the judgment ---- */
    const judge = folder.addFolder('The judgment (what it does to a body)');
    const j = c.judge;
    R(judge, j, 'reach', 0.2, 3, 0.01, 'reach, x footprint');
    R(judge, j, 'impulse', 0, 12, 0.05, 'knockback (0 = none)');
    R(judge, j, 'lift', 0, 8, 0.05, 'lift');
    R(judge, j, 'spin', 0, 4, 0.05, 'torque');
    R(judge, j, 'press', 0, 8, 0.05, 'press down (m/s)');
    R(judge, j, 'grab', 0, 30, 0.1, 'scrub sideways / s');
    R(judge, j, 'grabY', 0, 30, 0.1, 'scrub vertical / s');
    R(judge, j, 'stagger', 0, 3, 0.01, 'burns spread over (s)');
    R(judge, j, 'devour', 0.05, 4, 0.01, 'burn rate (bodies/s)');
    R(judge, j, 'markMotes', 0, 200, 1, 'marked motes / s');
    R(judge, j, 'burnMotes', 0, 400, 1, 'burning motes / s');
    R(judge, j, 'condemnSparks', 0, 200, 1, 'sparks as it falls');
    R(judge, j, 'condemnRing', 0, 4, 0.05, 'ring at its feet (m)');
    R(judge, j, 'takenBurst', 0, 4, 0.05, 'burst as it goes');
    R(judge, j, 'takenMotes', 0, 400, 1, 'motes as it goes');
    R(judge, j, 'takenShake', 0, 1, 0.005, 'shake as it goes');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 90, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 60, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 1, 0.005, 'height up the shaft');
    R(light, c, 'lightPulse', 0, 2, 0.01, 'toll owns');
    light.addColor(c, 'lightColor').name('light colour');

    this.rendFolder = folder;
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
