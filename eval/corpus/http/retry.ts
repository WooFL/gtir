// Exponential-backoff retry wrapper for fetch with jitter.
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retry: RetryOptions = { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 8000, jitter: true }
): Promise<Response> {
  let attempt = 0;
  while (true) {
    attempt++;
    const res = await fetch(url, options);
    if (res.ok || attempt >= retry.maxAttempts) return res;
    const base = Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs);
    const delay = retry.jitter ? base * (0.5 + Math.random() * 0.5) : base;
    await new Promise((r) => setTimeout(r, delay));
  }
}

export function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}
