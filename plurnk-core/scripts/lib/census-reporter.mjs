// {§tier-census} — the node:test reporter of the live and demo tiers. Every specimen's verdict, skip
// reason or failure is joined with the session directories its run claimed and written as census.json
// and census.md in the tier's run directory; the markdown is also what this reporter yields.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseAliasesFromEnv, resolveActiveRoute } from "@plurnk/plurnk-providers";
import { tierRunPath } from "../../../scripts/lib/test-artifacts.ts";
import { aliasesSatisfying, requirementsOfSkip } from "../../test/live-requirements.ts";

const failureReason = (error) => {
    const cause = error?.cause instanceof Error ? error.cause : error;
    return cause instanceof Error ? cause.message.split("\n")[0] : String(cause ?? "failed");
};

// A specimen's own verdict: a top-level test. The runner also reports each file as a top-level
// pass named by its path, which under a name pattern is every file whose specimens were filtered out.
export const isSpecimenVerdict = (event) =>
    (event.type === "test:pass" || event.type === "test:fail") && event.data?.nesting === 0 && event.data.name !== event.data.file;

// The session rows the run's directory holds, by the specimen that drove each.
export const sessionRows = (dir) => {
    if (dir === null || !existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "census.json")))
        .map((entry) => JSON.parse(readFileSync(join(dir, entry.name, "census.json"), "utf8")))
        .toSorted((a, b) => a.runDir.localeCompare(b.runDir));
};

export const compose = ({ run, route, aliases, tests, sessions, started, finished }) => {
    const byName = new Map();
    for (const session of sessions) {
        const key = session.specimen ?? "";
        byName.set(key, [...(byName.get(key) ?? []), session]);
    }
    const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
    const specimens = tests.map((test) => {
        const own = byName.get(test.name) ?? [];
        return {
            ...test,
            sessions: own.map(({ runDir }) => basename(runDir)),
            turns: sum(own, (w) => w.turns),
            requests: sum(own, (w) => w.requests),
            usd: sum(own, (w) => w.cost.usd),
        };
    });
    const totals = { pass: 0, fail: 0, skip: 0, todo: 0 };
    for (const { verdict } of specimens) totals[verdict] += 1;
    const unmet = new Map();
    for (const { name, verdict, reason } of specimens) {
        if (verdict !== "skip" || reason === null) continue;
        for (const requirement of requirementsOfSkip(reason)) unmet.set(requirement, [...(unmet.get(requirement) ?? []), name]);
    }
    return {
        run, route, started, finished,
        totals,
        sessions: { count: sessions.length, turns: sum(sessions, (w) => w.turns), requests: sum(sessions, (w) => w.requests), usd: sum(sessions, (w) => w.cost.usd) },
        specimens,
        unattributed: (byName.get("") ?? []).map(({ runDir }) => basename(runDir)),
        unmet: [...unmet].map(([requirement, names]) => ({ requirement, specimens: names, satisfiedBy: aliasesSatisfying(requirement, aliases) })),
    };
};

const cell = (text) => String(text ?? "").replace(/\|/gu, "\\|").replace(/\n/gu, " ");
const usd = (amount) => (amount === 0 ? "" : amount.toFixed(4));

export const render = (census) => {
    const lines = [
        `# ${census.run ?? "unstamped"} census`,
        "",
        "| | |",
        "|---|---|",
        `| route | ${cell(census.route)} |`,
        `| started | ${census.started} |`,
        `| finished | ${census.finished} |`,
        `| verdicts | pass ${census.totals.pass} · fail ${census.totals.fail} · skip ${census.totals.skip}${census.totals.todo > 0 ? ` · todo ${census.totals.todo}` : ""} |`,
        `| sessions | ${census.sessions.count} · ${census.sessions.turns} turns · ${census.sessions.requests} requests · $${census.sessions.usd.toFixed(4)} |`,
        "",
        "## Specimens",
        "",
        "| verdict | specimen | reason | turns | requests | usd | evidence |",
        "|---|---|---|---|---|---|---|",
        ...census.specimens.map((s) =>
            `| ${s.verdict} | ${cell(s.name)} | ${cell(s.reason)} | ${s.turns || ""} | ${s.requests || ""} | ${usd(s.usd)} | ${cell(s.sessions.join(", "))} |`),
    ];
    if (census.unmet.length > 0) {
        lines.push("", "## Unmet requirements", "", "| requirement | specimens | declared aliases that satisfy it |", "|---|---|---|");
        for (const { requirement, specimens, satisfiedBy } of census.unmet) {
            lines.push(`| ${cell(requirement)} | ${specimens.length} | ${satisfiedBy === null ? "not a route question" : satisfiedBy.length === 0 ? "none declared" : cell(satisfiedBy.join(", "))} |`);
        }
    }
    if (census.unattributed.length > 0) {
        lines.push("", `Sessions no specimen claimed: ${cell(census.unattributed.join(", "))}`);
    }
    return `${lines.join("\n")}\n`;
};

const routeLabel = () => {
    const route = resolveActiveRoute();
    if (route === null) return "none";
    const target = `${route.provider}/${route.model}`;
    return route.alias === undefined ? target : `${route.alias} = ${target}`;
};

export default async function* censusReporter(source) {
    const started = new Date().toISOString();
    const tests = [];
    for await (const event of source) {
        if (!isSpecimenVerdict(event)) continue;
        const data = event.data;
        if (event.type === "test:pass") {
            tests.push({
                name: data.name, file: data.file ?? null,
                verdict: data.skip ? "skip" : data.todo ? "todo" : "pass",
                reason: typeof data.skip === "string" ? data.skip : typeof data.todo === "string" ? data.todo : null,
                duration_ms: data.details?.duration_ms ?? null,
            });
        } else if (event.type === "test:fail") {
            tests.push({ name: data.name, file: data.file ?? null, verdict: "fail", reason: failureReason(data.details?.error), duration_ms: data.details?.duration_ms ?? null });
        }
    }
    const dir = tierRunPath();
    const census = compose({
        run: process.env.PLURNK_TIER_RUN ?? null,
        route: routeLabel(),
        aliases: parseAliasesFromEnv(),
        tests,
        sessions: sessionRows(dir),
        started,
        finished: new Date().toISOString(),
    });
    if (dir !== null) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "census.json"), `${JSON.stringify(census, null, 2)}\n`);
        process.stderr.write(`census: ${join(dir, "census.md")} — pass ${census.totals.pass} · fail ${census.totals.fail} · skip ${census.totals.skip}\n`);
    }
    yield render(census);
}
