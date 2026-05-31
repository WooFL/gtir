import { describe, it, expect, vi } from "vitest";
import { fetchWithRetry, isRetryable } from "./retry";

describe("isRetryable", () => {
  it("treats 429 and 5xx gateway errors as retryable", () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(404)).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  it("retries on a 503 then succeeds on the second attempt", async () => {
    const responses = [new Response("", { status: 503 }), new Response("ok", { status: 200 })];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const res = await fetchWithRetry("https://example.test", {}, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: false });
    expect(res.status).toBe(200);
  });
});
