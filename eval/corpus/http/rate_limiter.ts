// Token-bucket rate limiter for outbound API calls.
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillRatePerSec: number
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerSec);
    this.lastRefill = now;
  }

  tryConsume(tokens = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  async consume(tokens = 1): Promise<void> {
    while (!this.tryConsume(tokens)) {
      const waitMs = ((tokens - this.tokens) / this.refillRatePerSec) * 1000;
      await new Promise((r) => setTimeout(r, Math.ceil(waitMs)));
    }
  }
}
