import { Encoder } from "./encoder";

// runEncoder drives an Encoder through a typed parameter; e.flush resolves to Encoder.flush.
export function runEncoder(e: Encoder): number {
  return e.flush();
}
