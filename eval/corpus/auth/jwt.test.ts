import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "./jwt";

describe("signToken / verifyToken", () => {
  it("round-trips a payload and recovers the claims", () => {
    const token = signToken({ sub: "user-1" }, "s3cret", 3600);
    expect(verifyToken(token, "s3cret").sub).toBe("user-1");
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = signToken({ sub: "user-1" }, "s3cret", 3600);
    expect(() => verifyToken(token, "wrong")).toThrow(/bad signature/);
  });
});
