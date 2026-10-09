import { loadRefsQuery } from "./reference-query.ts";
export { extract } from "./fsharp.ts";
export const refsQuery = await loadRefsQuery("fsharp-signature");
