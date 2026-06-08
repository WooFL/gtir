// JSON document codec.
export function encode(value: Record<string, unknown>): string {
  // Serialize a document object to a compact JSON string for storage on disk.
  return JSON.stringify(value);
}

export function jsonMarker(): string {
  return "json";
}
