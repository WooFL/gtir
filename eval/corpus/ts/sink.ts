// Sink collects log lines and flushes them to the output.
export class Sink {
  private lines: string[] = [];
  flush(): number {
    const n = this.lines.length;
    this.lines = [];
    return n;
  }
}
