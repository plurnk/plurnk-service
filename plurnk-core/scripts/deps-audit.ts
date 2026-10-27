// Audit the composed dependency tree and route @plurnk/*-rooted chains to
// their owning packages. {§bundled-set}

import { isRecord } from "@plurnk/plurnk-contracts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { usage } from "../../scripts/lib/usage.mjs";

usage(import.meta, `
usage: npm run audit:deps [-- --strict]   (from plurnk-core)
Audits the composed dependency tree and routes each advisory to the @plurnk package that pulls it in ({§bundled-set}).
Reads: npm audit --json over the installed tree.
Writes: the routed report to stdout; --strict exits 1 on any advisory.
`);

interface Advisory {
    source?: number;
    name?: string;
    title?: string;
    url?: string;
    severity?: string;
}

interface AuditVuln {
    severity?: string;
    via?: (string | Advisory)[];
    effects?: string[];
}

interface AuditReport {
    vulnerabilities?: Record<string, AuditVuln>;
    metadata?: { vulnerabilities?: Record<string, number> };
}

export interface RoutedAdvisory {
    package: string;
    severity: string;
    ghsa: string;
    title: string;
    roots: string[];
    plurnkRoots: string[];
}

// npm audit exits non-zero precisely WHEN advisories exist — that's the signal, not a failure.
// Capture stdout either way; only a missing/empty stdout is a genuine npm error.
const sessionAudit = (extra: string[]): string => {
    try {
        return execFileSync("npm", ["audit", ...extra], { encoding: "utf8" });
    } catch (err) {
        const stdout = isRecord(err) ? err.stdout : undefined;
        if (typeof stdout === "string" && stdout.length > 0) return stdout;
        throw err;
    }
};

const readDirectDeps = (): Set<string> => {
    const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const names = (group: string): string[] => {
        const declared = isRecord(pkg) ? pkg[group] : undefined;
        return isRecord(declared) ? Object.keys(declared) : [];
    };
    return new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(names));
};

// Walk the audit graph's `effects` edges from a vulnerable package out to the direct deps that pull
// it in. Pure over (vulns map, package, direct-dep set) — testable without a live vulnerable tree.
export const rootsFor = (vulns: Record<string, AuditVuln>, pkg: string, deps: Set<string>): string[] => {
    const roots = new Set<string>();
    const seen = new Set<string>();
    const walk = (name: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        if (deps.has(name)) roots.add(name);
        for (const eff of vulns[name]?.effects ?? []) walk(eff);
    };
    walk(pkg);
    return [...roots];
};

// One entry per advisory source, routed to the direct dependencies at its
// chain root. `plurnkRoots` is the @plurnk/* subset.
export const routeAdvisories = (audit: AuditReport, deps: Set<string>): RoutedAdvisory[] => {
    const vulns = audit.vulnerabilities ?? {};
    const out: RoutedAdvisory[] = [];
    for (const [pkg, v] of Object.entries(vulns)) {
        const sources = (v.via ?? []).filter((x): x is Advisory & { url: string } =>
            typeof x === "object" && x !== null && typeof x.url === "string");
        for (const a of sources) {
            const roots = rootsFor(vulns, pkg, deps);
            out.push({
                package: pkg,
                severity: a.severity ?? v.severity ?? "unknown",
                ghsa: a.url,
                title: a.title ?? "",
                roots,
                plurnkRoots: roots.filter((r) => r.startsWith("@plurnk/")),
            });
        }
    }
    return out;
};

const RANK: Record<string, number> = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const LEVEL = "moderate";

const main = (): number => {
    const strict = process.argv.includes("--strict");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- npm audit --json's report: every member the type names is optional and read with a fallback
    const audit = JSON.parse(sessionAudit(["--json", `--audit-level=${LEVEL}`])) as AuditReport;
    const m = audit.metadata?.vulnerabilities ?? {};
    const total = m.total ?? 0;

    if (total === 0) {
        console.log(`audit:deps — 0 advisories (${LEVEL}+) at the install root ✓`);
        return 0;
    }

    const advisories = routeAdvisories(audit, readDirectDeps());
    console.log(`audit:deps — ${total} advisor${total === 1 ? "y" : "ies"} (critical:${m.critical ?? 0} high:${m.high ?? 0} moderate:${m.moderate ?? 0} low:${m.low ?? 0})\n`);

    const upstream = advisories.filter((a) => a.plurnkRoots.length > 0);
    const local = advisories.filter((a) => a.plurnkRoots.length === 0);

    if (upstream.length > 0) {
        console.log("── ROUTE UPSTREAM — chain roots in a @plurnk/* package (fix at the source) ──");
        for (const a of upstream) {
            console.log(`  [${a.severity}] ${a.package}  ${a.ghsa}`);
            console.log(`     → file on ${a.plurnkRoots.join(", ")} with the raw block below + this GHSA id`);
        }
        console.log("");
    }
    if (local.length > 0) {
        console.log("── LOCAL — chain roots in a first-party direct dep (fix here) ──");
        for (const a of local) console.log(`  [${a.severity}] ${a.package}  ${a.ghsa}  (root: ${a.roots.join(", ") || "?"})`);
        console.log("");
    }

    console.log("── raw npm audit ──");
    console.log(sessionAudit([`--audit-level=${LEVEL}`]).trimEnd());

    if (!strict) return 0;
    return advisories.some((a) => (RANK[a.severity] ?? 0) >= RANK[LEVEL]) ? 1 : 0;
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main());
}
