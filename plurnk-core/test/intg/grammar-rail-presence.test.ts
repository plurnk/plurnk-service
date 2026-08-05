// {§grammar-enforcement-verified-at-boot}, {§rail-truth-engine-verdict},
// and {§gbnf-response-observation} across a real core turn.

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
import type { Provider, ProviderResponse } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MESSAGES = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "go" }];
const usage = { prompt: 1, completion: 1, reasoning: 1, cached: 0, total: 3 };

const staticProvider = (response: ProviderResponse): Provider => ({
    model: "fake",
    contextWindow: 100000,
    constrainsOutput: true,
    generate: async () => response,
    countPromptTokens: async () => ({ kind: "exact", tokens: 1, source: "test:exact" }),
    calculateCost: () => 0,
}) as Provider;

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
        countPromptTokens: (...args: Parameters<Mock["countPromptTokens"]>) => base.countPromptTokens(...args),
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

test("the resolved grammar text reaches generate through a real turn", async () => {
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

test("an unregistered provider without an active alias cannot guess a suffixed rail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "probe.gbnf");
    await writeFile(gbnfPath, 'root ::= "PROBE-RAIL"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_someotheralias";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        // Remove the active-alias fallback so this provider has no identity
        // from which it could resolve a suffixed rail.
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

test("a configured but unloadable grammar fails instead of running unconstrained", async () => {
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

test("{§rail-truth-engine-verdict} the engine stamps local attachment and its own verdict", async () => {
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
        const acceptedContent = "<<PLAN::PLAN\n<<SEND[200]:ok:SEND";
        await writeFile(gbnfPath, `root ::= ${JSON.stringify(acceptedContent)}\n`);
        const accept = Object.assign(new Mock({ contextWindow: 100000, responses: [{ assistant: { content: acceptedContent, reasoning: null } }] }), { constrainsOutput: true }) as unknown as Provider;
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
        assert.equal(meta2.railsVerdict, "reject", "the engine independently grades the diverging observation");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

test("the engine grades the exact pre-projection sentence, not projected content alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "raw-verdict.gbnf");
    const content = "<<PLAN::PLAN\n<<SEND[200]:ok:SEND";
    const prefix = "<|channel>thought\nconsider<channel|>";
    const input = `${prefix}${content}`;
    await writeFile(gbnfPath, `root ::= ${JSON.stringify(input)}\n`);
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_rawverdict";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        const provider = staticProvider({
            assistant: { content, reasoning: "consider", usage, finishReason: "stop", model: "fake" },
            assistantRaw: null,
            grammarEvidence: { input, contentStart: [...prefix].length, transported: true },
        });
        ProviderInstantiate.registerAlias(provider, "rawverdict");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, workerId, loopId } = await envelope(db);
        const turn = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const meta = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: turn.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(meta.railsVerdict, "accept");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

test("raw rail positions map only from content, and debug evidence is stamped withheld", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const content = "<<PLAN::PLAN\n<<SEND[200]:ok:SEND";
    const prefix = "<|channel>thought\n🙂<channel|>";
    const input = `${prefix}${content}`;
    const contentPath = join(dir, "content-reject.gbnf");
    const reasoningPath = join(dir, "reasoning-reject.gbnf");
    await writeFile(contentPath, `root ::= ${JSON.stringify(`${prefix}${content.replace("ok", "ox")}`)}\n`);
    await writeFile(reasoningPath, `root ::= ${JSON.stringify(input.replace("thought", "analysis"))}\n`);
    const db = await openMigrated();
    const keys = ["PLURNK_PROVIDERS_GBNF_contentreject", "PLURNK_PROVIDERS_GBNF_reasoningreject"] as const;
    const prior = keys.map((key) => process.env[key]);
    try {
        process.env[keys[0]] = contentPath;
        process.env[keys[1]] = reasoningPath;
        const broadcasts: Array<{ notice: Record<string, unknown> }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            noticeNotify: (_workspaceId, payload) => {
                broadcasts.push(payload as { notice: Record<string, unknown> });
            },
        });
        const response = (transported: boolean): ProviderResponse => ({
            assistant: { content, reasoning: "🙂", usage, finishReason: "stop", model: "fake" },
            assistantRaw: null,
            grammarEvidence: { input, contentStart: [...prefix].length, transported },
        });

        const contentProvider = staticProvider(response(false));
        ProviderInstantiate.registerAlias(contentProvider, "contentreject");
        const first = await envelope(db);
        const contentTurn = await engine.runTurn({ provider: contentProvider, ...first, messages: MESSAGES, turnNumber: 1 });
        const contentMeta = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: contentTurn.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(contentMeta.railsAttached, "withheld");
        const firstRail = broadcasts.find(({ notice }) => notice.source === "engine:rails")?.notice;
        assert.deepEqual(firstRail?.position, { type: "content-offset", line: 2, column: 13 });

        broadcasts.length = 0;
        const reasoningProvider = staticProvider(response(true));
        ProviderInstantiate.registerAlias(reasoningProvider, "reasoningreject");
        const second = await envelope(db);
        await engine.runTurn({ provider: reasoningProvider, ...second, messages: MESSAGES, turnNumber: 1 });
        const secondRail = broadcasts.find(({ notice }) => notice.source === "engine:rails")?.notice;
        assert.equal(secondRail?.position, undefined, "a reasoning-prefix divergence must not fabricate a content pointer");
    } finally {
        for (let index = 0; index < keys.length; index++) {
            const value = prior[index];
            if (value === undefined) delete process.env[keys[index]]; else process.env[keys[index]] = value;
        }
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

test("a configured grammar fails hard when the provider omits its observation evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "missing-evidence.gbnf");
    const content = "<<PLAN::PLAN\n<<SEND[200]:ok:SEND";
    await writeFile(gbnfPath, `root ::= ${JSON.stringify(content)}\n`);
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_noevidence";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        const provider = staticProvider({
            assistant: { content, reasoning: null, usage, finishReason: "stop", model: "fake" },
            assistantRaw: null,
        });
        ProviderInstantiate.registerAlias(provider, "noevidence");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, workerId, loopId } = await envelope(db);
        await assert.rejects(
            () => engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 }),
            /configured GBNF response omitted grammar evidence/,
        );
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});
