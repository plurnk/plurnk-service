// Embedding-eligibility suppression (SPEC §21, #47): PLURNK_MIMETYPES_NO_EMBED
// is a comma-separated list of basename patterns naming content that should
// never be semantically derived — lockfiles, minified bundles, sourcemaps.
// Embedding 2,162 chunks of a vuepress bundle is pure waste (service#337);
// consumers read ProcessResult.noEmbed and skip derivation (zero vectors +
// FTS-only is the honest treatment).
//
// The knob IS the classification — owner paradigm: the decision table lives in
// .env.example (sane defaults shipped there, operator-tunable per deployment,
// extensible without a code release), never as heuristics or hardcoded sets in
// code. There is NO code fallback: unset/empty → nothing is suppressed. A
// content heuristic (line-length ratios) was deliberately rejected — it
// false-positives on line-record data (large-record JSONL, wide CSV), silently
// excluding real searchable data, and its thresholds would be exactly the
// hidden magic this family forbids.
//
// Pattern semantics: an entry WITHOUT `/` matches the path's BASENAME; an
// entry WITH `/` matches the FULL PATH (directory junk-drawers like */dist/*
// — hashed bundle names defeat basename patterns; the run18 offender was
// dist/assets/js/12.5188bb.js). `*` is a wildcard and crosses `/`; an entry
// without `*` is an exact match. Whitespace around entries is trimmed. First
// match wins and is returned verbatim — the matched pattern is the observable
// reason.

const cache = new Map<string, { source: string; regex: RegExp }[]>();

function compile(raw: string): { source: string; regex: RegExp }[] {
    const cached = cache.get(raw);
    if (cached !== undefined) return cached;
    const patterns = raw.split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((source) => ({
            source,
            regex: new RegExp(`^${source.split("*").map(escapeRegex).join(".*")}$`),
        }));
    cache.set(raw, patterns);
    return patterns;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The matched pattern for a path under the current PLURNK_MIMETYPES_NO_EMBED,
// or undefined (no path / knob unset or empty / no match). Read at call time,
// like the pdf caps — the host's env is the contract.
export function matchNoEmbed(path: string | undefined): string | undefined {
    if (path === undefined) return undefined;
    const raw = process.env.PLURNK_MIMETYPES_NO_EMBED;
    if (raw === undefined || raw.trim() === "") return undefined;
    const base = path.slice(path.lastIndexOf("/") + 1);
    return compile(raw).find((p) => p.regex.test(p.source.includes("/") ? path : base))?.source;
}
