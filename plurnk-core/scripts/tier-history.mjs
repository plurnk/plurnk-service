#!/usr/bin/env node

// {§tier-census} — the ledger across tier runs: every census under the benchmark home, one row per
// specimen with its verdicts over time, so a specimen that keeps failing or skipping is read off a
// table instead of reconstructed from memory. Read-only; nothing under the home is touched.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchmarksRoot } from "../../scripts/test-artifacts.ts";

export const censuses = (home) => {
    if (!existsSync(home)) return [];
    return readdirSync(home, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("tier-") && existsSync(join(home, entry.name, "census.json")))
        .map((entry) => JSON.parse(readFileSync(join(home, entry.name, "census.json"), "utf8")))
        .filter((census) => typeof census.run === "string")
        .toSorted((a, b) => a.run.localeCompare(b.run));
};

const MARK = { pass: "✔", fail: "✖", skip: "﹣", todo: "?" };

export const history = (runs) => {
    const specimens = new Map();
    for (const census of runs) {
        for (const specimen of census.specimens) {
            const row = specimens.get(specimen.name) ?? { name: specimen.name, pass: 0, fail: 0, skip: 0, todo: 0, trail: [], last: null };
            row[specimen.verdict] += 1;
            row.trail.push(MARK[specimen.verdict] ?? "?");
            row.last = { run: census.run, route: census.route, verdict: specimen.verdict, reason: specimen.reason };
            specimens.set(specimen.name, row);
        }
    }
    return [...specimens.values()].toSorted((a, b) => (b.fail - a.fail) || (b.skip - a.skip) || a.name.localeCompare(b.name));
};

const cell = (text) => String(text ?? "").replace(/\|/gu, "\\|").replace(/\n/gu, " ");

export const render = (runs) => {
    const lines = [
        `# tier history — ${runs.length} run${runs.length === 1 ? "" : "s"}`,
        "",
        "| run | route | pass | fail | skip |",
        "|---|---|---|---|---|",
        ...runs.map((c) => `| ${cell(c.run)} | ${cell(c.route)} | ${c.totals.pass} | ${c.totals.fail} | ${c.totals.skip} |`),
        "",
        "| specimen | pass | fail | skip | trail | last |",
        "|---|---|---|---|---|---|",
        ...history(runs).map((row) =>
            `| ${cell(row.name)} | ${row.pass} | ${row.fail} | ${row.skip} | ${row.trail.join("")} | ${cell(row.last.verdict)} in ${cell(row.last.run)}${row.last.reason === null ? "" : `: ${cell(row.last.reason)}`} |`),
    ];
    return `${lines.join("\n")}\n`;
};

if (import.meta.main) {
    const [kind] = process.argv.slice(2);
    const runs = censuses(benchmarksRoot()).filter((census) => kind === undefined || census.run.startsWith(`${kind}-`));
    process.stdout.write(render(runs));
}
