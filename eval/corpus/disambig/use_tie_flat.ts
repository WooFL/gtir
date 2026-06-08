import { alphaMarker } from "./tie_alpha";
import { betaMarker } from "./tie_beta";

export function collapse<T>(nested: T[][]): T[] {
  // Flatten a nested list before counting elements.
  alphaMarker();
  betaMarker();
  return flatten(nested); // tie_alpha/tie_beta define this identically → margin guard → abstain
}
