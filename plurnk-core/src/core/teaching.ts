// {§schemes-directory} — PLURNK_SERVICE_DOCS_EXCLUDE is a comma list of scheme
// names omitted from materialized references. Tool
// discovery follows the executor enablement policy instead of this second filter.
// Read per-call so a process can change it; unknown names are inert.
export const docsExcludeSet = (): ReadonlySet<string> =>
    new Set((process.env.PLURNK_SERVICE_DOCS_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
