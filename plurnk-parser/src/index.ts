import type { ParsedPath } from "@plurnk/plurnk-contracts";
import AstBuilder from "./AstBuilder.ts";

export { default as PlurnkParser } from "./PlurnkParser.ts";
export type { ParseOptions } from "./PlurnkParser.ts";

// One path or URI, decomposed exactly as the parser decomposes a target ({§path-syntax}).
export const parsePath = (raw: string): ParsedPath | null => AstBuilder.parsePath(raw);
