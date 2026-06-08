import { jsonMarker } from "./json_codec";
import { csvMarker } from "./csv_codec";

export function exportTable(rows: Record<string, unknown>[]): string {
  // Encode a list of tabular rows as CSV text and return the spreadsheet body.
  csvMarker();
  return encode(rows); // ambiguous: json_codec.encode vs csv_codec.encode — CSV context
}
