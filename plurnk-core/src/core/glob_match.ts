// SqlRite adapter for membership glob evaluation. The filename owns SQLite's `glob_match` name;
// the semantics are node:path.matchesGlob, the one matcher every overlay decision uses, so a
// constraint evaluated in a statement and one evaluated in the process cannot disagree.
import { matchesGlob } from "node:path";

export const deterministic = true;
export default (pathname: string, glob: string): 0 | 1 => matchesGlob(pathname, glob) ? 1 : 0;
