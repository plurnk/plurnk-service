// #488 — the GBNF rail is VERIFIABLE, never silently off. run78's failure class: the rail
// severed upstream of the provider, the model free-decoded and fabricated a log, the loop
// concluded 200 with CLEAN telemetry — green proved nothing. These tests pin the chain
// POSITIVELY (the resolved grammar text reaches generate through a real turn) and pin the
// silent hole closed (an unregistered provider may not guess an alias while per-alias rails
// are configured).

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { Provider } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MESSAGES = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "go" }];

// A Mock that RECORDS what generate receives — the end of the chain, observed directly.
const recordingProvider = (): { provider: Provider; calls: Array<{ grammar?: string }> } => {
    const calls: Array<{ grammar?: string }> = [];
    const base = new Mock({ contextWindow: 100000, responses: [
        { assistant: { content: "<<PLAN::PLAN\n<<SEND[200]:ok:SEND", reasoning: null } },
    ] });
    // plain delegation — a Proxy breaks Mock's private-field getters (#contextWindow via Reflect)
    const provider = {
        get contextWindow() { return base.contextWindow; },
        get model() { return base.model; },
        countTokens: (s: string) => base.countTokens(s),
        calculateCost: (u: never) => base.calculateCost(u),
        generate: (args: { grammar?: string }) => { calls.push({ grammar: args.grammar }); return base.generate(args as never); },
    } as unknown as Provider;
    return { provider, calls };
};

const envelope = async (db: Awaited<ReturnType<typeof openMigrated>>) => {
    const workspaceId = await insertWorkspace(db, `rail-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "go");
    return { workspaceId, workerId, loopId };
};

test("[#488] the resolved grammar text REACHES generate — the rail chain proven end-to-end through a real turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "probe.gbnf");
    await writeFile(gbnfPath, 'root ::= "PROBE-RAIL"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railprobe";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;  // absolute path — BYO grammar arm, no dist artifact dependence
        const { provider, calls } = recordingProvider();
        ProviderInstantiate.registerAlias(provider, "railprobe");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, workerId, loopId } = await envelope(db);
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(calls.length, 1, "one generate call");
        assert.equal(calls[0].grammar, 'root ::= "PROBE-RAIL"\n', "the grammar FILE TEXT arrived at the provider — the rail is attached, positively");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

test("[#488] an UNREGISTERED provider may not guess an alias while per-alias rails are configured — fail hard, never silently unconstrained", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "probe.gbnf");
    await writeFile(gbnfPath, 'root ::= "PROBE-RAIL"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_someotheralias";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        // A truly alias-less process: strip every PLURNK_MODEL* so resolveActiveAlias yields nothing —
        // an unregistered provider then has NO alias to resolve the suffixed rail through. Silently
        // running unconstrained here is run78's severance shape; the contract is a loud refusal.
        // (With an active alias present, the boot-global fallback stands — the #353 contract.)
        const modelKeys = Object.keys(process.env).filter((k) => k.startsWith("PLURNK_MODEL"));
        const savedModels = modelKeys.map((k) => [k, process.env[k]] as const);
        for (const k of modelKeys) delete process.env[k];
        try {
            const { provider } = recordingProvider();  // NOT alias-registered
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const { workspaceId, workerId, loopId } = await envelope(db);
            await assert.rejects(
                () => engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 }),
                /GBNF constraint: provider has no registered alias/,
            );
        } finally { for (const [k, v] of savedModels) process.env[k] = v; }
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

test("[#488] a configured-but-unloadable variant fails LOUD — a broken rail is never a silent fallback to unconstrained", async () => {
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railbroken";
    const prior = process.env[key];
    try {
        process.env[key] = "/nonexistent/rail/never-here.gbnf";
        const { provider } = recordingProvider();
        ProviderInstantiate.registerAlias(provider, "railbroken");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, workerId, loopId } = await envelope(db);
        await assert.rejects(
            () => engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 }),
            /ENOENT|no such file/,
        );
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close();
    }
});

// {§rail-truth-engine-verdict} (#534) — the engine independently grades the
// configured local constraint instead of trusting provider self-attestation.
test("local GBNF path: the engine stamps client attachment + its own verdict (#534)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "verdict.gbnf");
    await writeFile(gbnfPath, 'root ::= "OK"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_verdictbox";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, workerId, loopId } = await envelope(db);

        // accept — the emission is a complete sentence of the contract grammar.
        const accept = Object.assign(new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "OK", reasoning: null } }] }), { constrainsOutput: true }) as unknown as Provider;
        ProviderInstantiate.registerAlias(accept, "verdictbox");
        const t1 = await engine.runTurn({ provider: accept, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const meta1 = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: t1.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(meta1.railsAttached, "client");
        assert.equal(meta1.railsVerdict, "accept", "conforming emission grades accept");

        // reject — same contract, diverging emission.
        const reject = Object.assign(new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "<<PLAN::PLAN\n<<SEND[200]:done:SEND", reasoning: null } }] }), { constrainsOutput: true }) as unknown as Provider;
        ProviderInstantiate.registerAlias(reject, "verdictbox");
        const t2 = await engine.runTurn({ provider: reject, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const meta2 = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: t2.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(meta2.railsAttached, "client");
        assert.equal(meta2.railsVerdict, "reject", "diverging emission grades reject — an unconstrained backend self-names per turn");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});
