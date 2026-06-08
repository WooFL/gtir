import { jsonMarker } from "./json_codec";
import { csvMarker } from "./csv_codec";

export function saveDocument(document: Record<string, unknown>): string {
  // Encode a configuration document as a JSON string and return the payload.
  jsonMarker();
  return encode(document); // ambiguous: json_codec.encode vs csv_codec.encode — JSON context
}
