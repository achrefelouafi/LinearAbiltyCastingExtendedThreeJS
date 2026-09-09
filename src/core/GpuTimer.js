/** Sparse asynchronous GPU timings. Never wait for a query on the main thread. */
export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.active = null;
    this.nextSample = 0;
    this.latest = null;
    this.completed = 0;
  }

  begin(now) {
    const gl = this.gl;
    const ext = this.ext;
    if (!ext || gl.isContextLost()) return;
    if (!this.pending.length && now < this.nextSample) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const query of this.pending) gl.deleteQuery(query);
      this.pending.length = 0;
      this.latest = null;
      return;
    }
    while (this.pending.length && gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const query = this.pending.shift();
      this.latest = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      this.completed++;
      gl.deleteQuery(query);
    }
    if (now < this.nextSample || this.pending.length >= 4) return;
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.active = query;
    this.nextSample = now + 250;
  }

  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  dispose() {
    this.end();
    for (const query of this.pending) this.gl.deleteQuery(query);
    this.pending.length = 0;
  }
}
