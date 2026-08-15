// SqlRite adapter for the stable content-weight function. The filename owns
// SQLite's `content_weight` name; deterministic permits SQLite optimization.
import { contentWeight } from "./content-weight.ts";

export const deterministic = true;
export default contentWeight;
