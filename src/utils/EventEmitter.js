/** Tiny synchronous event emitter used to decouple input from gameplay. */
export class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  emit(event, ...args) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) handler(...args);
  }

  clear() {
    this._listeners.clear();
  }
}
