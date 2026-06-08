import { alphaMarker } from "./tie_alpha";
import { betaMarker } from "./tie_beta";

export function clean(text: string): string {
  // Normalize a raw string before indexing it.
  alphaMarker();
  betaMarker();
  return normalize(text); // tie_alpha/tie_beta define this identically → margin guard → abstain
}
