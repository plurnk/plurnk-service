// {§mimetype-query} — Re-exports text and structural query engines. Runtime consumers
// that only need text matchers or lazy structural dispatch import `@plurnk/plurnk-mimetypes/runtime`
// or `./query-text.ts` to avoid loading json-p3, @xmldom/xmldom, and xpath at boot (#1578).
export { globToRegex, queryGlob, queryRegex } from "./query-text.ts";
export { queryJsonpathObject, queryXpathString, serializeXpathNode } from "./query-structural.ts";
export { outlineLineFor } from "./outline-lines.ts";
