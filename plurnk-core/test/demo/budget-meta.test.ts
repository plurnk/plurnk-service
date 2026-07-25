// Budget as a META-SCENARIO (owner's design): the storyline demos, re-run under a
// tight partition CONTEXT_WINDOW. Budget pressure is a DIMENSION atop a real scenario,
// not a bespoke fixture — if the same task still completes when the model must curate
// to fit the window, the grinder works end-to-end with a real model. The intg layer
// (budget-stories.test.ts) pins the exact mechanics; this pins the behavior, the way
// rummy's e2e/stories/tight_context_limit ran a real task at contextLimit: 6667.
//
// The marquee (owner): a JUMBO prompt — SPEC.md itself, ~42k tokens — under a tight
// ceiling. A whole-read overflows by ~10x, so on the next turn the grinder auto-folds
// it (pre-LLM) and the model must use patterns + chunks (matched / sliced READs) to
// pull the one fact it needs from inside the folded prompt.
//
// Driven through the REAL prod loop (loop.run via the daemon). The ceiling is set
// before liveWorkspace boots the daemon so its engine captures it at construction
// (the budget-grind pattern). Stochastic: assert the OUTCOME (the fact surfaces),
// not a strict terminal — a live test pinning strict 200 is flaky by construction.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../../src/core/Db.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { liveWorkspace, liveLoop, pinAliasPartition } from "../_live-harness.ts";
import { measureFloor } from "./_floor-probe.ts";
import { seedDemoFixture } from "./_fixture.ts";

const TIMEOUT = 480_000; // 8 minutes — matches the storyline timeout.
// Ceilings are FLOOR-RELATIVE: each worker probes its own fixture's true turn-1 floor (a
// zero-cost pre-generate hard-413, _floor-probe.ts) and pins ceiling = floor × factor —
// teaching growth re-calibrates the pin instead of breaking it. TIGHT keeps the small
// fixtures under real curation pressure; jumbo gets the same factor over its own floor.
const TIGHT_FACTOR = 1.6; // floor x factor: enough headroom to absorb a stroke-and-recover (op-repetition rambles, grammar#49/50) while the small fixtures still curate under real pressure

interface BudgetRun {
    db: Db;
    workspace: string;
    finalStatus: number;
    lastContent: string;
    turnIds: number[];
    cleanup: () => Promise<void>;
    dump: () => Promise<void>;
}

// runStory with a pinned budget ceiling. The daemon's engine reads
// the partition env at construction (inside liveWorkspace), so set before / restore
// after — mirrors budget-grind. `projectRoot` overrides the default fixture (the SPEC demo).
const runUnderBudget = async (opts: { label: string; prompt: string; factor?: number; projectRoot?: string; cleanupRoot?: () => Promise<void> }): Promise<BudgetRun> => {
    const fixture = opts.projectRoot === undefined ? await seedDemoFixture(opts.label) : null;
    const root = opts.projectRoot ?? fixture!.workspace;
    // RESERVES bind at the provider's FIRST construction (process-cached) — pin the absolutes
    // BEFORE the floor probe boots it; the CAP binds live (#528), each phase pins its own.
    const restoreReserves = pinAliasPartition({ REASONING: "1", COMPLETION: "8192", SAFETY: "0" });
    const floor = await measureFloor({ label: opts.label, projectRoot: root, prompt: opts.prompt });
    const ceiling = Math.round(floor * (opts.factor ?? TIGHT_FACTOR));
    // #528 — promptBudget = min(cap, natural) − reserves − safety = ceiling exactly.
    const restore = pinAliasPartition({ CONTEXT_WINDOW: String(ceiling + 1 + 8192) });
    try {
        const s = await liveWorkspace({ name: `demo-budget-${opts.label}-${crypto.randomUUID()}`, projectRoot: root });
        const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: opts.prompt }, { timeoutMs: TIMEOUT });
        const perTurn: number[] = [];
        for (const tid of turnIds) {
            const r = await s.db.test_get_turn.get<{ packet: string }>({ id: tid });
            perTurn.push((JSON.parse(r?.packet ?? "{}") as { tokens?: number }).tokens ?? 0);
        }
        console.error(`[budget-meta:${opts.label}] floor=${floor} ceiling=${ceiling} turns=${turnIds.length} finalStatus=${finalStatus} turn1=${perTurn[0]} peak=${Math.max(0, ...perTurn)} perTurn=[${perTurn.join(",")}]`);
        const dump = async (): Promise<void> => {
            for (const turnId of turnIds) {
                const row = await s.db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`--- turn ${turnId} status=${row?.status} ---\n${(packet.assistant?.content ?? "").slice(0, 1500)}`);
            }
        };
        return {
            db: s.db, workspace: root, finalStatus, lastContent, turnIds, dump,
            cleanup: async () => { await s.cleanup(); if (fixture) await fixture.cleanup(); if (opts.cleanupRoot) await opts.cleanupRoot(); },
        };
    } catch (err) {
        if (fixture) await fixture.cleanup();
        if (opts.cleanupRoot) await opts.cleanupRoot();
        throw err;
    } finally {
        restore();
        restoreReserves();
    }
};

// A git-committed workspace holding the real SPEC.md — a genuine ~42k-token member
// the model can FIND/READ but cannot hold whole under the tight ceiling.
const seedLedgerFixture = async (): Promise<{ workspace: string; cleanup: () => Promise<void> }> => {
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-budget-ledger-"));
    // UNIFORM line density, deliberately. The real SPEC.md was a token-sizing TRAP: its {§}-anchor
    // lines run 200-600 chars (~143 tokens/line, 2x the entry average), so the tokens/lines metadata
    // UNDERSTATES the dense sections and even correct sizing overflows — that probed a pathology, not
    // the model's good-faith curation. Here every line is ~the same width, so the (tokens÷lines) clue
    // is RELIABLE: the model can FIND the fact, size a precise chunk-read against a doc it cannot hold
    // whole, curate, and answer. One fact, buried mid-doc, findable by a keyword no filler line uses.
    const lines: string[] = [];
    for (let i = 1; i <= 600; i += 1) {
        lines.push(`Entry ${String(i).padStart(4, "0")}: routine ledger record number ${i}; standard operational note, nothing of special interest is filed on this particular line.`);
    }
    lines[316] = "Entry 0317: the emergency shutdown code for the primary reactor core is CRIMSON-MERIDIAN-84, filed by the audit team and paged to no one.";
    await writeFile(join(workspace, "ledger.md"), `${lines.join("\n")}\n`);
    execSync('git init -q && git config user.email "demo@plurnk.invalid" && git config user.name "demo" && git add . && git commit -q --no-verify -m "ledger"', { cwd: workspace, env: hermeticGitEnv() });
    return { workspace, cleanup: async () => { await rm(workspace, { recursive: true, force: true }); } };
};

// 1 — an existing storyline (read the codename) under budget pressure. Same task,
// tight window: the model must curate to fit and still answer "phoenix".
test("budget-meta: the codename storyline still completes under a tight ceiling", { timeout: TIMEOUT }, async () => {
    const run = await runUnderBudget({
        label: "codename-tight",
        prompt: "What's the project codename? It's recorded in notes.md.",
    });
    try {
        if (!/phoenix/i.test(run.lastContent)) await run.dump();
        assert.match(run.lastContent, /phoenix/i, `model curated under budget and still answered; got: ${run.lastContent.slice(0, 200)}`);
    } finally { await run.cleanup(); }
});

// 2 — a second existing storyline (config host) under the same pressure.
test("budget-meta: the config-host storyline still completes under a tight ceiling", { timeout: TIMEOUT }, async () => {
    const run = await runUnderBudget({
        label: "host-tight",
        prompt: "What's the value of the `host` field in src/config.json?",
    });
    try {
        if (!/db\.internal/.test(run.lastContent)) await run.dump();
        assert.match(run.lastContent, /db\.internal/, `model curated under budget and still answered; got: ${run.lastContent.slice(0, 200)}`);
    } finally { await run.cleanup(); }
});

// 3 — THE MARQUEE (owner): a jumbo prompt (SPEC.md, ~42k) under a tight ceiling. The
// fact lives deep in §grinder; the doc cannot be held whole, so the model must read
// patterns/chunks — and if it reads broadly first, the grinder auto-folds that read
// and the model recovers with a sliced/matched re-read. Outcome: it finds that the
// grinder reverts the PRIOR turn first.
test("budget-meta: a jumbo uniform-density doc under a tight ceiling — FIND then precise chunk-read finds the buried fact", { timeout: TIMEOUT }, async () => {
    const doc = await seedLedgerFixture();
    const run = await runUnderBudget({
        label: "ledger-jumbo",
        prompt: "ledger.md records an emergency shutdown code for the primary reactor core. What is that code?",
        projectRoot: doc.workspace,
        cleanupRoot: doc.cleanup,
    });
    try {
        if (!/CRIMSON-MERIDIAN-84/i.test(run.lastContent)) await run.dump();
        // The doc cannot be held whole under the ceiling, so good-faith management is: FIND(#shutdown#)
        // to locate the one line, size a precise chunk-read around it from the reliable uniform
        // tokens/line clue, curate the rest, and answer. The buried code proves it read precisely and
        // curated — not read blindly. Uniform density means correct sizing never overflows: a fair test.
        assert.match(run.lastContent, /CRIMSON-MERIDIAN-84/i, `model FOUND + read the buried code under budget pressure; got: ${run.lastContent.slice(0, 300)}`);
    } finally { await run.cleanup(); }
});
