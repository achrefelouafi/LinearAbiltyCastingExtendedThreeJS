import { performanceProfile, setPerformanceProfile, savePerformancePreferences } from '../config/PerformancePreferences.js';
import { settings } from '../config/settings.js';
import { GpuTimer } from '../core/GpuTimer.js';

const ms = (value) => value == null ? 'Unavailable' : `${value.toFixed(2)} ms`;
const average = (values) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;

/** Compact HUD and user-triggered samples; DOM refreshes at most twice a second. */
export class PerformancePanel {
  constructor(renderer, { onSettingsChange } = {}) {
    this.renderer = renderer;
    this.gpu = new GpuTimer(renderer.getContext());
    this.lastSample = null;
    this.recording = null;
    this.latest = null;
    this.resetWindow();
    this.element = document.createElement('details');
    this.element.className = 'performance';
    this.element.innerHTML = `
      <summary aria-label="Performance details"><i aria-hidden="true"></i><b data-fps>— FPS</b><span data-mode>Starting</span><span class="performance__chevron" aria-hidden="true">⌄</span></summary>
      <div class="performance__body">
        <header><h2>Performance</h2><button type="button" data-close aria-label="Close performance details">×</button></header>
        <nav class="performance__tabs" role="tablist" aria-label="Performance sections">
          <button type="button" role="tab" id="perf-tab-metrics" aria-controls="perf-metrics" aria-selected="true" data-tab="metrics">Metrics</button>
          <button type="button" role="tab" id="perf-tab-graphics" aria-controls="perf-graphics" aria-selected="false" tabindex="-1" data-tab="graphics">Graphics</button>
          <button type="button" role="tab" id="perf-tab-compare" aria-controls="perf-compare" aria-selected="false" tabindex="-1" data-tab="compare">Compare</button>
        </nav>
        <section role="tabpanel" id="perf-metrics" aria-labelledby="perf-tab-metrics" data-section="metrics">
          <dl data-metrics></dl>
          <p class="performance__note">CPU: browser work. GPU: measured when supported. Frame interval includes the FPS cap.</p>
        </section>
        <section role="tabpanel" id="perf-graphics" aria-labelledby="perf-tab-graphics" data-section="graphics" hidden>
          <label class="performance__label">Quality mode<select data-profile><option>Balanced</option><option>Economy</option><option>Custom</option></select></label>
          <div class="performance__controls" data-controls></div>
          <label class="performance__bloom"><input type="checkbox" data-idle-bloom>Bloom while idle</label>
          <label class="performance__bloom"><input type="checkbox" data-dynamic>Adapt resolution to frame rate</label>
          <p class="performance__note">Saved on this device, separately from effect presets. The light budget that comes with a quality mode applies on the next reload.</p>
        </section>
        <section role="tabpanel" id="perf-compare" aria-labelledby="perf-tab-compare" data-section="compare" hidden>
        <label class="performance__label">Sample label<input data-label maxlength="80" placeholder="e.g. after · idle" value="After · idle"></label>
        <div class="performance__actions"><button type="button" data-record>Record 10 seconds</button><button type="button" data-copy>Copy report</button></div>
        <p data-status role="status">Repeat the same scene and settings for each version.</p>
        <dl data-sample></dl>
        <p class="performance__note">Temperature and watts require macOS tools.</p>
        </section>
      </div>`;
    document.getElementById('hud').append(this.element);
    this.fps = this.element.querySelector('[data-fps]');
    this.mode = this.element.querySelector('[data-mode]');
    this.status = this.element.querySelector('[data-status]');
    this.recordButton = this.element.querySelector('[data-record]');
    this.rows = this.createRows('[data-metrics]', ['Frame interval', 'CPU work', 'GPU render', 'Draw calls', 'Triangles', 'Canvas']);
    this.sampleRows = this.createRows('[data-sample]', ['Sample', 'Average FPS', 'CPU avg / p95', 'GPU average', 'Average draw calls']);
    const tabs = [...this.element.querySelectorAll('[data-tab]')];
    const selectTab = (tab) => {
      for (const button of tabs) {
        button.setAttribute('aria-selected', String(button === tab));
        button.tabIndex = button === tab ? 0 : -1;
      }
      for (const section of this.element.querySelectorAll('[data-section]')) {
        section.hidden = section.dataset.section !== tab.dataset.tab;
      }
    };
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', () => selectTab(tab));
      tab.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
        if (event.key === 'ArrowLeft') next = tabs[(index + tabs.length - 1) % tabs.length];
        if (event.key === 'Home') next = tabs[0];
        if (event.key === 'End') next = tabs[tabs.length - 1];
        if (!next) return;
        event.preventDefault();
        selectTab(next);
        next.focus();
      });
    }
    this.profileSelect = this.element.querySelector('[data-profile]');
    this.bloomCheckbox = this.element.querySelector('[data-idle-bloom]');
    this.dynamicCheckbox = this.element.querySelector('[data-dynamic]');
    this.profileSelect.value = performanceProfile();
    this.bloomCheckbox.checked = settings.performance.idleBloom;
    this.dynamicCheckbox.checked = settings.performance.dynamicResolution;
    const changed = () => {
      savePerformancePreferences();
      this.cancelRecording('Settings changed; start a new sample.');
      onSettingsChange?.();
    };
    this.profileSelect.addEventListener('change', () => {
      setPerformanceProfile(this.profileSelect.value);
      changed();
    });
    this.bloomCheckbox.addEventListener('change', () => {
      settings.performance.idleBloom = this.bloomCheckbox.checked;
      changed();
    });
    this.dynamicCheckbox.addEventListener('change', () => {
      settings.performance.dynamicResolution = this.dynamicCheckbox.checked;
      changed();
    });
    this.controls = [];
    const options = [
      ['maxFps', 'Active FPS', [30, 60, 120]],
      ['idleFps', 'Idle FPS', [15, 30, ['No reduction', 240]]],
      ['pixelRatio', 'Pixel ratio', [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]],
      ['shadowResolution', 'Shadow size', [1024, 2048, 4096]],
      ['shadowFps', 'Shadow refresh', [15, 30, ['Every frame', 240]]],
      ['bloomScale', 'Bloom resolution', [['Full', 1], ['Three quarters', 0.75], ['Half', 0.5]]]
    ];
    for (const [key, title, values] of options) {
      const label = document.createElement('label');
      label.textContent = title;
      const select = document.createElement('select');
      for (const value of values) {
        const [text, number] = Array.isArray(value) ? value : [value, value];
        select.add(new Option(String(text), String(number)));
      }
      select.value = String(settings.performance[key]);
      select.addEventListener('change', () => {
        settings.performance[key] = Number(select.value);
        changed();
      });
      label.append(select);
      this.element.querySelector('[data-controls]').append(label);
      this.controls.push([key, select]);
    }
    for (const name of ['pointerdown', 'pointermove', 'wheel']) {
      this.element.addEventListener(name, (event) => event.stopPropagation());
    }
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.element.open = false;
        this.element.querySelector('summary').focus();
      }
      event.stopPropagation();
    });
    this.element.querySelector('[data-close]').addEventListener('click', () => {
      this.element.open = false;
      this.element.querySelector('summary').focus();
    });
    this._onOutside = (event) => {
      if (!this.element.contains(event.target)) this.element.open = false;
    };
    document.addEventListener('pointerdown', this._onOutside);
    this.recordButton.addEventListener('click', () => this.startRecording());
    this.element.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(this.report(), null, 2));
        this.status.textContent = 'Report copied.';
      } catch {
        this.status.textContent = 'Clipboard unavailable. Use Download report.';
        this.downloadButton.hidden = false;
      }
    });
    this.downloadButton = document.createElement('button');
    this.downloadButton.type = 'button';
    this.downloadButton.textContent = 'Download report';
    this.downloadButton.hidden = true;
    this.downloadButton.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(this.report(), null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'performance.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    this.element.querySelector('.performance__actions').append(this.downloadButton);
  }

  createRows(selector, labels) {
    const rows = {};
    for (const text of labels) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = text;
      dd.textContent = '—';
      row.append(dt, dd);
      this.element.querySelector(selector).append(row);
      rows[text] = dd;
    }
    return rows;
  }

  resetWindow() {
    this.windowTime = 0;
    this.frames = 0;
    this.cpuTotal = 0;
    if (this.recording) this.cancelRecording('Sample interrupted by a visibility change. Start again.');
  }

  beginGpu() {
    // The collapsed pill only needs FPS; do not poll the GPU for hidden details.
    if (this.element.open || this.recording) this.gpu.begin(performance.now());
  }
  endGpu() { this.gpu.end(); }

  startRecording() {
    this.recording = {
      label: this.element.querySelector('[data-label]').value.trim() || 'Untitled',
      settings: structuredClone(settings.performance),
      elapsed: 0, cpu: [], calls: [], gpu: [], lastGpu: this.gpu.completed
    };
    this.recordButton.disabled = true;
    this.status.textContent = 'Recording… keep the same scenario for 10 seconds.';
  }

  cancelRecording(message) {
    if (!this.recording) return;
    this.recording = null;
    this.recordButton.disabled = false;
    this.status.textContent = message;
  }

  record(dt, cpuMs, { mode, targetFps, scale = 1 }) {
    if (dt <= 0) return;
    const info = this.renderer.info;
    this.frames++;
    this.windowTime += dt;
    this.cpuTotal += cpuMs;
    const recording = this.recording;
    if (recording) {
      if (Object.keys(recording.settings).some(key => recording.settings[key] !== settings.performance[key])) {
        this.cancelRecording('Settings changed; start a new sample.');
      } else {
        recording.elapsed += dt;
        recording.cpu.push(cpuMs);
        recording.calls.push(info.render.calls);
        if (recording.lastGpu !== this.gpu.completed && this.gpu.latest != null) {
          recording.gpu.push(this.gpu.latest);
          recording.lastGpu = this.gpu.completed;
        }
        if (recording.elapsed >= 10) this.finishRecording();
      }
    }
    if (this.windowTime < 0.5) return;
    this.latest = {
      fps: this.frames / this.windowTime,
      frameMs: this.windowTime * 1000 / this.frames,
      cpuMs: this.cpuTotal / this.frames,
      gpuMs: this.gpu.latest,
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      canvas: `${this.renderer.domElement.width} × ${this.renderer.domElement.height}` +
        (scale < 1 ? ` · ${Math.round(scale * 100)}% adaptive` : ''),
      mode, targetFps
    };
    const value = this.latest;
    this.fps.textContent = `${Math.round(value.fps)} FPS`;
    this.mode.textContent = mode;
    this.element.dataset.slow = String(value.fps < targetFps * 0.8);
    if (this.element.open) {
      const values = [ms(value.frameMs), ms(value.cpuMs), ms(value.gpuMs), value.calls,
        value.triangles.toLocaleString(), value.canvas];
      Object.values(this.rows).forEach((row, i) => { row.textContent = values[i]; });
      this.profileSelect.value = performanceProfile();
      this.bloomCheckbox.checked = settings.performance.idleBloom;
      this.dynamicCheckbox.checked = settings.performance.dynamicResolution;
      for (const [key, select] of this.controls) select.value = String(settings.performance[key]);
      if (this.recording) this.status.textContent = `Recording… ${Math.ceil(10 - this.recording.elapsed)} seconds left.`;
    }
    this.windowTime = 0;
    this.frames = 0;
    this.cpuTotal = 0;
  }

  finishRecording() {
    const sample = this.recording;
    const sorted = [...sample.cpu].sort((a, b) => a - b);
    this.lastSample = {
      label: sample.label, capturedAt: new Date().toISOString(), settings: sample.settings,
      seconds: sample.elapsed, frames: sample.cpu.length, fps: sample.cpu.length / sample.elapsed,
      cpuAverageMs: average(sample.cpu), cpuP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      gpuAverageMs: average(sample.gpu), gpuSamples: sample.gpu.length,
      averageDrawCalls: average(sample.calls)
    };
    const value = this.lastSample;
    const values = [value.label, value.fps.toFixed(1), `${ms(value.cpuAverageMs)} / ${ms(value.cpuP95Ms)}`,
      ms(value.gpuAverageMs), value.averageDrawCalls.toFixed(1)];
    Object.values(this.sampleRows).forEach((row, i) => { row.textContent = values[i]; });
    this.recording = null;
    this.recordButton.disabled = false;
    this.status.textContent = 'Sample ready. Copy the report to compare runs.';
  }

  report() {
    return {
      capturedAt: new Date().toISOString(),
      device: { browser: navigator.userAgent, logicalCpus: navigator.hardwareConcurrency,
        viewport: [innerWidth, innerHeight], devicePixelRatio },
      settings: structuredClone(settings.performance), current: this.latest, sample: this.lastSample,
      timing: 'CPU = browser frame work; GPU = sparse asynchronous render queries, when supported. FPS includes intentional throttling. No temperature or power readings.'
    };
  }

  dispose() {
    this.gpu.dispose();
    document.removeEventListener('pointerdown', this._onOutside);
    this.element.remove();
  }
}
