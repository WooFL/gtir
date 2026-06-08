// serialize calls a builtin's method; JSON.stringify must stay external (JSON is not an in-corpus class).
export function serialize(value: unknown): string {
  return JSON.stringify(value);
}
