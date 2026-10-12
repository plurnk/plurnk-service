// SqlRite adapter for membership glob evaluation. The filename owns SQLite's `glob_match` name;
// the semantics are {§path-glob-matching}, the one matcher every overlay decision uses, so a
// constraint evaluated in a statement and one evaluated in the process cannot disagree.
import PathGlob from "./PathGlob.ts";

export const deterministic = true;
export default (pathname: string, glob: string): 0 | 1 => PathGlob.matches(pathname, glob) ? 1 : 0;
