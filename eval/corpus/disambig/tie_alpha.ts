export function normalize(text: string): string {
  // Lowercase the input and collapse runs of whitespace to single spaces.
  return text.toLowerCase().split(/\s+/).join(" ");
}

export function flatten<T>(nested: T[][]): T[] {
  // Concatenate a list of lists into one flat list, left to right.
  return nested.reduce((acc, sub) => acc.concat(sub), []);
}

export function alphaMarker(): string {
  return "alpha";
}
