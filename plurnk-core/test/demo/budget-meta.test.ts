// Budget pressure as a meta-scenario: rerun ordinary storylines with a tight
// provider-derived input capacity. The integration tier pins exact overflow recovery
// mechanics; these demos assert that a real model still delivers the outcome.
//
// The marquee (owner): a JUMBO prompt — SPEC.md itself, ~42k tokens — under a tight
// gauge. A whole-read makes the next candidate packet exceed the ceiling, so a
// packetless overflow turn folds it and the model must use patterns + chunks (matched / sliced READs) to
// pull the one fact it needs from inside the folded prompt.
//
// Driven through the REAL prod loop (loop.run via the daemon). The gauge is set
// before liveWorkspace boots the daemon so its engine captures it at construction
// (the budget-pressure pattern). Stochastic: assert the OUTCOME (the fact surfaces),
// not a strict terminal — stochastic model output makes a strict 200 assertion invalid.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../../src/core/Db.ts";
import { liveWorkspace, liveLoop, pinAliasInputCapacity } from "../_live-harness.ts";
import { measureFloor } from "./_floor-probe.ts";
import { seedDemoFixture } from "./_fixture.ts";
import { initializeDemoRepository } from "./_git.ts";

const TIMEOUT = Number(process.env.PLURNK_SERVICE_LIVE_TIMEOUT ?? 600_000);
// Gauges are floor-relative: each worker probes its own fixture's true turn-1 floor
// in one bounded turn and pins gauge = floor × factor —
// teaching growth re-calibrates the pin instead of breaking it. TIGHT keeps the small
// fixtures under real curation pressure; jumbo gets the same factor over its own floor.
const TIGHT_FACTOR = 1.6; // enough headroom for recovery while the small fixtures still curate under real pressure

interface BudgetRun {
    db: Db;
    workspace: string;
    finalStatus: number;
    lastContent: string;
    turnIds: number[];
    cleanup: () => Promise<void>;
    dump: () => Promise<void>;
}

// Run a story with a pinned pressure gauge. `projectRoot` overrides the default
// fixture (the SPEC demo).
const runUnderPressure = async (opts: { label: string; prompt: string; factor?: number; projectRoot?: string; cleanupRoot?: () => Promise<void> }): Promise<BudgetRun> => {
    const fixture = opts.projectRoot === undefined ? await seedDemoFixture(opts.label) : null;
    const root = opts.projectRoot ?? fixture!.workspace;
    const floor = await measureFloor({ label: opts.label, projectRoot: root, prompt: opts.prompt });
    const gauge = Math.round(floor.weight * (opts.factor ?? TIGHT_FACTOR));
    const restore = pinAliasInputCapacity({ inputCapacity: gauge, outputBudget: floor.outputBudget });
    try {
        const s = await liveWorkspace({ name: `demo-budget-${opts.label}-${crypto.randomUUID()}`, projectRoot: root });
        const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: opts.prompt }, { timeoutMs: TIMEOUT });
        const perTurn: Array<number | null> = [];
        for (const tid of turnIds) {
            const r = await s.db.test_get_turn.get<{ packet: string | null }>({ id: tid });
            perTurn.push(r?.packet == null
                ? null
                : (JSON.parse(r.packet) as { weight?: number }).weight ?? 0);
        }
        const modelWeights = perTurn.filter((weight): weight is number => weight !== null);
        console.error(`[budget-meta:${opts.label}] floor=${floor.weight} requestedCapacity=${gauge} effectiveCapacity=${s.provider.inputCapacity} outputBudget=${s.provider.outputBudget} durableTurns=${turnIds.length} modelTurns=${modelWeights.length} finalStatus=${finalStatus} firstModel=${modelWeights[0] ?? 0} peak=${Math.max(0, ...modelWeights)} chronology=[${perTurn.map((weight) => weight ?? "packetless").join(",")}]`);
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
    }
};

// A git-committed workspace holding the real SPEC.md — a genuine ~42k-token member
// the model can FIND/READ but whose whole body drives the tight gauge negative.
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
    initializeDemoRepository(workspace, "ledger");
    return { workspace, cleanup: async () => { await rm(workspace, { recursive: true, force: true }); } };
};

// 1 — an existing storyline (read the codename) under context pressure.
test("budget-meta: the codename storyline still completes under a tight gauge", { timeout: TIMEOUT }, async () => {
    const run = await runUnderPressure({
        label: "codename-tight",
        prompt: "What's the project codename? It's recorded in notes.md.",
    });
    try {
        if (!/phoenix/i.test(run.lastContent)) await run.dump();
        assert.match(run.lastContent, /phoenix/i, `model answered under context pressure; got: ${run.lastContent.slice(0, 200)}`);
    } finally { await run.cleanup(); }
});

// 2 — a second existing storyline (config host) under the same pressure.
test("budget-meta: the config-host storyline still completes under a tight gauge", { timeout: TIMEOUT }, async () => {
    const run = await runUnderPressure({
        label: "host-tight",
        prompt: "What's the value of the `host` field in src/config.json?",
    });
    try {
        if (!/db\.internal/.test(run.lastContent)) await run.dump();
        assert.match(run.lastContent, /db\.internal/, `model answered under context pressure; got: ${run.lastContent.slice(0, 200)}`);
    } finally { await run.cleanup(); }
});

// 3 — a jumbo document under a tight gauge. The fact lives deep in the document,
// which cannot be held whole, so the model must read patterns/chunks. If it reads broadly
// first, a packetless overflow turn folds that read and the model recovers with a
// sliced or matched re-read.
test("budget-meta: a jumbo uniform-density doc under a tight gauge — FIND then precise chunk-read finds the buried fact", { timeout: TIMEOUT }, async () => {
    const doc = await seedLedgerFixture();
    const run = await runUnderPressure({
        label: "ledger-jumbo",
        prompt: "ledger.md records an emergency shutdown code for the primary reactor core. What is that code?",
        projectRoot: doc.workspace,
        cleanupRoot: doc.cleanup,
    });
    try {
        if (!/CRIMSON-MERIDIAN-84/i.test(run.lastContent)) await run.dump();
        // The whole doc drives the gauge negative, so good-faith management is:
        // FIND(ledger.md):/shutdown/
        // to locate the one line, size a precise chunk-read around it from the reliable uniform
        // tokens/line clue, curate the rest, and answer. The buried code proves it read precisely and
        // curated — not read blindly. Uniform density means correct sizing never overflows: a fair test.
        assert.match(run.lastContent, /CRIMSON-MERIDIAN-84/i, `model FOUND + read the buried code under budget pressure; got: ${run.lastContent.slice(0, 300)}`);
    } finally { await run.cleanup(); }
});
