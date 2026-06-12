// SqlRite function module (#186, ~semantic). The sqlrite contract requires a
// default-export handler and turns the filename into the SQL function name — so
// this is a thin registration adapter; the logic lives in EntrySemantic.cosine
// (OO). `deterministic` marks it a pure function so SQLite may optimize it. One
// of the few intentionally non-class modules (sqlrite's function convention).
import EntrySemantic from "./_entry-semantic.ts";

export const deterministic = true;
export default (a: Uint8Array, b: Uint8Array): number => EntrySemantic.cosine(a, b);
