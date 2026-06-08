// Encoder batches values and flushes them as one frame.
export class Encoder {
  private pending: number[] = [];
  flush(): number {
    const n = this.pending.length;
    this.pending = [];
    return n;
  }
  drive(): number {
    return this.flush();
  }
}
