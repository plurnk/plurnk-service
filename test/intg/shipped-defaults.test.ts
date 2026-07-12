// §operator-config-shipped-defaults — the shipped .env.defaults is ITSELF under test. Every other
// tier runs the TEST cascade (.env.test deliberately blanks the policy surfaces, pins its own
// knobs), which means shipped-default regressions are structurally invisible to it: the POLICY.md
// double-injection (a stale PLURNK_SERVICE_MD_POLICY default alongside the policy section) and the
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
    const raw = await readFile(new URL("../../.env.defaults", import.meta.url), "utf8");
    const env = new Map<string, string>();
    for (const line of raw.split("\n")) {
        const m = /^([A-Z_][A-Za-z0-9_]*)=(.*)$/.exec(line);  // alias suffixes are lowercase (PLURNK_PROVIDERS_GBNF_<alias>)
        if (m) env.set(m[1], m[2].replace(/^"|"$/g, ""));
    }
    return env;
};

test("[§operator-config-shipped-defaults] the template ships no double policy, no active model, a resolving GBNF", async () => {
    const env = await shippedEnv();
    const rawExample = await readFile(new URL("../../.env.defaults", import.meta.url), "utf8");
    // The operating policy is a packet SECTION (readSystemPolicy) — a PLURNK_SERVICE_MD_* default pointing
    // at the same file injects it twice (once as ## Plurnk Service Policy, once as a foisted
    // plurnk:///<ALIAS>.md READ). The template must ship NO active doc aliases.
    const mdKeys = [...env.keys()].filter((k) => k.startsWith("PLURNK_SERVICE_MD_"));
    assert.deepEqual(mdKeys, [], `no active PLURNK_SERVICE_MD_* doc default ships; got ${mdKeys.join(", ")}`);
    // No active model — the local/cloud/plurnk.ai selection is the user's (#307).
    assert.equal(env.get("PLURNK_MODEL"), undefined, "no active PLURNK_MODEL ships");
    // Native thinking ships ON and BOUNDED (providers 0.31 activation/capacity split). Off
    // reroutes a think-trained model's thought into the grammar free zone; adaptive is unbounded.
    // The F7 coupling (CAPACITY == the serving box's --reasoning-budget) is a LOCAL/llama-server
    // concern — cloud backends ignore per-request reasoning budgets (#352). So the shipped CAPACITY
    // couples to the LOCAL reasoning envelope (the local example's 4096), NOT the bare
    // cloud-generous reserve; both ship as positive ints.
    assert.equal(env.get("PLURNK_PROVIDERS_THINKING"), "on", "thinking ships on");
    assert.equal(env.get("PLURNK_PROVIDERS_THINKING_CAPACITY"), "4096", "thinking capacity ships coupled to the LOCAL llama-server reasoning envelope (4096)");
    // §tokenomics-window-partition (#352) — the BARE partition ships cloud-generous (a large
    // decode envelope the backend self-clamps); the four knobs ship as positive ints, and the
    // local measured envelope rides the commented per-alias template.
    const part = ["CTX", "REASONING", "ASSISTANT", "SAFETY"].map((k) => Number(env.get(`PLURNK_SERVICE_${k}`)));
    assert.ok(part.every((n) => Number.isFinite(n) && n > 0), "all four bare partition numbers ship as positive ints");
    // #352 — the bare partition is cloud-generous: 163840 − 16384 − 49152 − 1024 = 97280 prompt
    // budget with a 65536 decode envelope the backend self-clamps (the local per-alias template
    // is the 64Ki-prompt gemma envelope). Prompt budget stays well above the decode envelope.
    const promptBudget = part[0] - part[1] - part[2] - part[3];
    assert.ok(promptBudget > part[1] + part[2], `the bare prompt budget (${promptBudget}) exceeds the decode envelope — a healthy cloud partition`);
    // Ships PER ALIAS (#353): the bare default is OFF (a cloud model that ignores the grammar earns
    // a divergence event every turn for nothing); a GBNF-capable alias opts in via a
    // PLURNK_PROVIDERS_GBNF_<alias> suffix in the OPERATOR'S OWN .env — the template carries the
    // MECHANISM, never a real alias name (alias names are personal config, not shipped defaults).
    assert.equal(env.get("PLURNK_PROVIDERS_GBNF"), "", "the bare default ships OFF");
    assert.ok(!/^PLURNK_PROVIDERS_GBNF_[a-z].*=(?!$)/m.test(rawExample), "no ACTIVE per-alias GBNF opt-in ships in the template — that belongs in the operator's .env");
    assert.match(rawExample, /# PLURNK_PROVIDERS_GBNF_myalias=plurnk\.gbnf/, "the opt-in mechanism is documented with a placeholder alias");
});

test("[§operator-config-shipped-defaults] under the shipped policy wiring, the personality renders in the packet exactly once", async () => {
    // Mirror a fresh install: PLURNK_SERVICE_POLICY → the seed file itself (ensureHome copies
    // PLURNK_PERSONALITY.md to ~/.plurnk/AGENTS.md); no PLURNK_SERVICE_MD_* docs.
    const prevPolicy = process.env.PLURNK_SERVICE_POLICY;
    const prevMd = process.env.PLURNK_SERVICE_MD_POLICY;
    process.env.PLURNK_SERVICE_POLICY = fileURLToPath(import.meta.resolve("@plurnk/plurnk-docs/PLURNK_PERSONALITY.md"));
    delete process.env.PLURNK_SERVICE_MD_POLICY;
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
        if (prevPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = prevPolicy;
        if (prevMd !== undefined) process.env.PLURNK_SERVICE_MD_POLICY = prevMd;
        await db.close();
    }
});
