/**
 * Minimal object pool.
 *
 * Abilities, lights and decals are recycled rather than re-allocated so that a
 * long play session produces (close to) zero garbage after warm-up.
 */
export class ObjectPool {
  /**
   * @param {() => any} factory        creates a new instance when the pool is empty
   * @param {(item:any) => void} [reset] called when an item is returned
   * @param {number} [prewarm]         number of instances to build up-front
   */
  constructor(factory, reset = null, prewarm = 0) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
    this.activeCount = 0;
    for (let i = 0; i < prewarm; i++) this.free.push(factory());
  }

  acquire() {
    const item = this.free.pop() ?? this.factory();
    this.activeCount++;
    return item;
  }

  release(item) {
    if (!item) return;
    this.reset?.(item);
    this.free.push(item);
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  dispose(disposer) {
    if (disposer) this.free.forEach(disposer);
    this.free.length = 0;
    this.activeCount = 0;
  }
}
