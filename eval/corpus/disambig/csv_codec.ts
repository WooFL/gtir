// CSV table codec.
export function encode(rows: Record<string, unknown>[]): string {
  // Serialize a list of table rows to CSV text with a header line and comma-separated columns.
  const header = Object.keys(rows[0]).join(",");
  const body = rows.map((row) => Object.values(row).join(",")).join("\n");
  return header + "\n" + body;
}

export function csvMarker(): string {
  return "csv";
}
