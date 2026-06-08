import { Sink } from "./sink";

// runSink drives a Sink through a new-assigned local; s.flush resolves to Sink.flush.
export function runSink(): number {
  const s = new Sink();
  return s.flush();
}
