// #240 — the shared teaching-line shape for the System Tools (exec tags) + System Schemes
// directories: a terse `* <oneliner>`, rendered IDENTICALLY for execs and schemes. The example
// self-documents its tag/scheme, so no service-added prefix. Reference docs are NOT linked inline
// (#270): they're materialized at plurnk://docs/<name>.md and discovered via the turn-1
// FIND(worker://plurnk/docs/**) foist, keeping the raw packet free of doc links. `* ` bullets + bare op
// forms match the packet's list/op rendering (no `- `, no backticks).
export const teachingLine = (oneliner: string): string => `* ${oneliner}`;

// #240 — PLURNK_SERVICE_DOCS_EXCLUDE: a comma list of scheme/exec names dropped from BOTH the teaching
// oneliner AND the materialized pull-doc, on load — the self-evident/retired names the operator
// wants no doc for (default `plurnk,file,exec`, set in .env.defaults). Read per-call so a process
// can change it; unknown names are inert (a filter, never a contract).
export const docsExcludeSet = (): ReadonlySet<string> =>
    new Set((process.env.PLURNK_SERVICE_DOCS_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
