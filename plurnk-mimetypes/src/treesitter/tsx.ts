import { loadRefsQuery } from "./reference-query.ts";
// tsx mapping. The tsx and typescript grammars share node names for every
// declaration shape, so the symbol extraction is identical — tsx reuses
// typescript's `extract` verbatim. Only the refs query differs (typescript +
// JSX component instantiation, queries/tsx.scm).
export { extract } from "./typescript.ts";
export const refsQuery = await loadRefsQuery("typescript", "tsx");
