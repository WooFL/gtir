// Express-style middleware utilities.
import type { Request, Response, NextFunction } from "express";

/** Attach a correlation ID to every request for distributed tracing. */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers["x-correlation-id"] as string) ?? crypto.randomUUID();
  req.headers["x-correlation-id"] = id;
  res.setHeader("x-correlation-id", id);
  next();
}

/** Structured JSON request logger. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    process.stderr.write(
      JSON.stringify({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
        id: req.headers["x-correlation-id"],
      }) + "\n"
    );
  });
  next();
}

/** Enforce a maximum request body size; respond 413 if exceeded. */
export function bodySizeLimit(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.status(413).json({ error: "payload too large" });
        req.destroy();
      }
    });
    req.on("end", next);
  };
}
