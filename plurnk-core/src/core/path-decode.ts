// #239 item 4 — the grammar's target slot is opaque: a literal `)` closes the op slot, so
// parens inside a path are percent-encoded (`%28`/`%29`) and the service decodes them at
// resolve time. ONLY parens are encoded — `:`, spaces, and drive letters pass through
// literally — so a targeted %28/%29 replacement is exact and safe: it never touches a
// literal `%` in a path (which decodeURIComponent would mangle). A regex target's source
// is NOT a path (its parens are groups/alternation), so callers skip it.
export const decodePathParens = (s: string): string => s.replace(/%28/gi, "(").replace(/%29/gi, ")");
