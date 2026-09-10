import { Renderer } from '../../src/core/Renderer.js';
import { settings } from '../../src/config/settings.js';

// Run through Vite in a browser: this checks a real WebGLRenderer before the
// app's first syncSettings() can conceal an invalid initial pixel ratio.
export function checkRendererInitialization() {
  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas);
  try {
    const expected = Math.max(0.5, Math.min(window.devicePixelRatio || 1,
      Math.max(0.5, settings.performance.pixelRatio)));
    const initial = { pixelRatio: renderer.gl.getPixelRatio(), width: canvas.width, height: canvas.height };
    if (initial.pixelRatio !== expected || initial.width !== Math.floor(window.innerWidth * expected) ||
        initial.height !== Math.floor(window.innerHeight * expected)) {
      throw new Error(`Invalid renderer initialization: ${JSON.stringify(initial)}`);
    }
    renderer.resolutionScale = 0.6;
    renderer.syncSettings();
    const adaptiveRatio = renderer.gl.getPixelRatio();
    if (adaptiveRatio !== Math.max(0.5, expected * 0.6)) throw new Error('Adaptive resolution did not resize');
    return { initial, adaptiveRatio, passed: true };
  } finally {
    renderer.dispose();
    renderer.gl.forceContextLoss();
  }
}
