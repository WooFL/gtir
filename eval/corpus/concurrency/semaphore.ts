// Counting semaphore for capping concurrent async operations.
export class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];

  constructor(concurrency: number) {
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
    this.count = concurrency;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.count++;
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); }
    finally { this.release(); }
  }
}
