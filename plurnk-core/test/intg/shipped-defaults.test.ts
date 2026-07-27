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
import Paths from "../../src/Paths.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, DEFAULT_MIMETYPES, packetSection } from "./_helpers.ts";
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

test("the template ships no double policy, no active model, ONLY service-owned knobs", async () => {
    const env = await shippedEnv();
    // The operating policy is a packet SECTION (readSystemPolicy) — a PLURNK_SERVICE_MD_* default pointing
    // at the same file injects it twice (once as ## Plurnk Service Policy, once as a foisted
    // plurnk:///<ALIAS>.md READ). The template must ship NO active doc aliases.
    const mdKeys = [...env.keys()].filter((k) => k.startsWith("PLURNK_SERVICE_MD_"));
    assert.deepEqual(mdKeys, [], `no active PLURNK_SERVICE_MD_* doc default ships; got ${mdKeys.join(", ")}`);
    // No active model — the local/cloud/plurnk.ai selection is the user's (#307).
    assert.equal(env.get("PLURNK_MODEL"), undefined, "no active PLURNK_MODEL ships");
    // §operator-config-env-defaults — a knob has exactly one owner, and this file declares ONLY
    // the service's: PLURNK_SERVICE_* plus the daemon's own unprefixed surface (HOST/PORT, the
    // QUESTIONS ceiling, the PLUGINS trust gate). Sibling knobs (PROVIDERS/EXECS/SCHEMES/
    // MIMETYPES/AGUI/MODEL/BASE) live in the owning packages' shipped .env.defaults — a stray
    // here is a boot-crash collision waiting on the next sibling pub.
    const SERVICE_OWNED = /^(PLURNK_SERVICE_|PLURNK_HOST$|PLURNK_PORT$|PLURNK_QUESTIONS$|PLURNK_PLUGINS_)/;
    const foreign = [...env.keys()].filter((k) => !SERVICE_OWNED.test(k));
    assert.deepEqual(foreign, [], `the template declares only service-owned knobs; foreign: ${foreign.join(", ")}`);
    // Provider physics ship elsewhere. Core's only active default is SAFETY;
    // virtual PROMPT_BUDGET is optional and therefore absent from the parsed floor.
    const safety = Number(env.get("PLURNK_SERVICE_SAFETY"));
    assert.ok(Number.isFinite(safety) && safety > 0, "SAFETY ships as a positive int — core's one partition knob");
    // #352 — the bare partition is cloud-generous: 163840 − 16384 − 49152 − 1024 = 97280 prompt
    // budget with a 65536 decode envelope the backend self-clamps (the local per-alias template
    // is the 64Ki-prompt gemma envelope). Prompt budget stays well above the decode envelope.
});

test("under the shipped policy wiring, the personality renders in the packet exactly once", async () => {
    // Mirror a fresh install: PLURNK_SERVICE_POLICY → the seed file itself (ensureHome copies
    // PLURNK_PERSONALITY.md to ~/.plurnk/AGENTS.md); no PLURNK_SERVICE_MD_* docs.
    const prevPolicy = process.env.PLURNK_SERVICE_POLICY;
    const prevMd = process.env.PLURNK_SERVICE_MD_POLICY;
    process.env.PLURNK_SERVICE_POLICY = Paths.personality;
    delete process.env.PLURNK_SERVICE_MD_POLICY;
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `shipped-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "hello");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done") as PlurnkStatement] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet) as { sections: Array<{ name: string; content: string }> };
        // The distinctive personality line appears in the system-policy section and NOWHERE else.
        const marker = "You decompose non-trivial prompts";
        const carriers = packet.sections.filter((s) => s.content.includes(marker)).map((s) => s.name);
        assert.deepEqual(carriers, ["system-policy"], `the policy rides exactly one section; got ${carriers.join(", ")}`);
        assert.ok(packetSection(packet, "system-policy").includes(marker), "the section carries the personality");
        // And the turn-0 foists contain no POLICY doc READ — the doc path is retired for the policy.
        const rows = await db.test_log_sequencees_by_turn.all<{ op: string; pathname: string | null }>({ turn_id: result.turnId });
        assert.ok(!rows.some((r) => r.op === "READ" && (r.pathname ?? "").includes("POLICY")), "no foisted plurnk:///POLICY.md READ");
    } finally {
        if (prevPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = prevPolicy;
        if (prevMd !== undefined) process.env.PLURNK_SERVICE_MD_POLICY = prevMd;
        await db.close();
    }
});
