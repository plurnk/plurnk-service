// §operator-config-shipped-defaults — the shipped .env.example is ITSELF under test. Every other
// tier runs the TEST cascade (.env.test deliberately blanks the policy surfaces, pins its own
// knobs), which means shipped-default regressions are structurally invisible to it: the POLICY.md
// double-injection (a stale PLURNK_MD_POLICY default alongside the policy section) and the
// silently-commented PLURNK_PROVIDERS_GBNF both shipped through fully-green tiers. This file
// asserts the template's contract directly, then builds one packet UNDER the shipped policy
// wiring and proves the policy renders exactly once.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

const shippedEnv = async (): Promise<Map<string, string>> => {
    const raw = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
    const env = new Map<string, string>();
    for (const line of raw.split("\n")) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
        if (m) env.set(m[1], m[2].replace(/^"|"$/g, ""));
    }
    return env;
};

test("[§operator-config-shipped-defaults] the template ships no double policy, no active model, a resolving GBNF", async () => {
    const env = await shippedEnv();
    // The operating policy is a packet SECTION (readSystemPolicy) — a PLURNK_MD_* default pointing
    // at the same file injects it twice (once as ## Plurnk Service Policy, once as a foisted
    // plurnk:///<ALIAS>.md READ). The template must ship NO active doc aliases.
    const mdKeys = [...env.keys()].filter((k) => k.startsWith("PLURNK_MD_"));
    assert.deepEqual(mdKeys, [], `no active PLURNK_MD_* doc default ships; got ${mdKeys.join(", ")}`);
    // No active model — the local/cloud/plurnk.ai selection is the user's (#307).
    assert.equal(env.get("PLURNK_MODEL"), undefined, "no active PLURNK_MODEL ships");
    // The GBNF default is ACTIVE and resolves — a commented-out flag silently ran every
    // model tier unconstrained for days.
    // Native reasoning ships OFF — budget 0 (in-DSL PLAN is the reasoning surface). The -1
    // default let models think unbounded inside the grammar mask: 28k-token gemma turns.
    assert.equal(env.get("PLURNK_PROVIDERS_REASONING_BUDGET"), "0", "reasoning budget ships 0");
    // §tokenomics-window-partition — the 64Ki invariant: the shipped numbers partition any
    // ≥77Ki window to EXACTLY 65536 prompt tokens. Change any of the four and this names it.
    const part = ["CTX", "REASONING", "ASSISTANT", "SAFETY"].map((k) => Number(env.get(`PLURNK_PROVIDERS_${k}`)));
    assert.ok(part.every(Number.isFinite), "all four partition numbers ship");
    assert.equal(part[0] - part[1] - part[2] - part[3], 65536, "the shipped partition is exactly 64Ki of prompt");
    const variant = env.get("PLURNK_PROVIDERS_GBNF");
    assert.ok(variant !== undefined && variant.length > 0 && variant !== "0", "PLURNK_PROVIDERS_GBNF ships active");
    assert.doesNotThrow(() => fileURLToPath(import.meta.resolve(`@plurnk/plurnk-grammar/${variant}`)), "the shipped variant resolves in the installed grammar");
});

test("[§operator-config-shipped-defaults] under the shipped policy wiring, the personality renders in the packet exactly once", async () => {
    // Mirror a fresh install: PLURNK_POLICY → the seed file itself (ensureHome copies
    // PLURNK_PERSONALITY.md to ~/.plurnk/AGENTS.md); no PLURNK_MD_* docs.
    const prevPolicy = process.env.PLURNK_POLICY;
    const prevMd = process.env.PLURNK_MD_POLICY;
    process.env.PLURNK_POLICY = fileURLToPath(new URL("../../PLURNK_PERSONALITY.md", import.meta.url));
    delete process.env.PLURNK_MD_POLICY;
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `shipped-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "hello");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done") as PlurnkStatement] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId }))!.packet) as { sections: Array<{ name: string; content: string }> };
        // The distinctive personality line appears in the system-policy section and NOWHERE else.
        const marker = "You decompose non-trivial prompts";
        const carriers = packet.sections.filter((s) => s.content.includes(marker)).map((s) => s.name);
        assert.deepEqual(carriers, ["system-policy"], `the policy rides exactly one section; got ${carriers.join(", ")}`);
        assert.ok(packetSection(packet, "system-policy").includes(marker), "the section carries the personality");
        // And the turn-0 foists contain no POLICY doc READ — the doc path is retired for the policy.
        const rows = await (db.test_log_sequencees_by_turn as PrepMethod).all<{ op: string; pathname: string | null }>({ turn_id: result.turnId });
        assert.ok(!rows.some((r) => r.op === "READ" && (r.pathname ?? "").includes("POLICY")), "no foisted plurnk:///POLICY.md READ");
    } finally {
        if (prevPolicy === undefined) delete process.env.PLURNK_POLICY; else process.env.PLURNK_POLICY = prevPolicy;
        if (prevMd !== undefined) process.env.PLURNK_MD_POLICY = prevMd;
        await db.close();
    }
});
