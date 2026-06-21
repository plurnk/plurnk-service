// #240 — the shared teaching-line shape for the System Tools (exec tags) + System Schemes
// directories: a terse `* <oneliner>` plus an optional pull-doc link, rendered IDENTICALLY for
// execs and schemes. The example self-documents its tag/scheme, so no service-added prefix.
// `* ` bullets + bare op forms match the packet's list/op rendering (no `- `, no backticks).
export const teachingLine = (oneliner: string, docName: string, hasDoc: boolean): string =>
    `* ${oneliner}${hasDoc ? ` (docs: plurnk://docs/${docName}.md)` : ""}`;

// #240 — PLURNK_DOCS_EXCLUDE: a comma list of scheme/exec names dropped from BOTH the teaching
// oneliner AND the materialized pull-doc, on load — the self-evident/retired names the operator
// wants no doc for (default `plurnk,file,exec`, set in .env.example). Read per-call so a process
// can change it; unknown names are inert (a filter, never a contract).
export const docsExcludeSet = (): ReadonlySet<string> =>
    new Set((process.env.PLURNK_DOCS_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
