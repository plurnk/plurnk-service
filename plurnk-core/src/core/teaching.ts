// {§tools-capability-sheet} {§schemes-directory} — PLURNK_SERVICE_DOCS_EXCLUDE
// is a comma list of scheme/exec names dropped from both the teaching
// oneliner AND the materialized pull-doc, on load — the self-evident/retired names the operator
// wants no doc for (default `plurnk,file,exec`, set in .env.defaults). Read per-call so a process
// can change it; unknown names are inert (a filter, never a contract).
export const docsExcludeSet = (): ReadonlySet<string> =>
    new Set((process.env.PLURNK_SERVICE_DOCS_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
