// {§operator-grammar} and {§grammar-configuration-admission} across a real core turn: an
// operator's GBNF file reaches the provider verbatim, unrelated alias settings never leak, an
// unreadable or bare-named grammar fails instead of running unconstrained, and the turn records
// transport as evidence, never a verdict (#588).

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
import type { InputModality, Provider, ProviderResponse } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, testProviderCapacity } from "./_helpers.ts";

const MESSAGES = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "go" }];
const usage = {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    outputTokenDetails: { textTokens: 1, reasoningTokens: 1 },
};

const staticProvider = (response: Omit<ProviderResponse, "accounting" | "capacity">): Provider => ({
    model: "fake",
    inputModalities: new Set<InputModality>(),
    contextWindow: 100000,
    maxInputTokens: null,
    maxOutputTokens: null,
    outputBudget: 1,
    reasoningBudget: null,
    supportedReasoningPolicies: ["off", "adaptive", "low", "medium", "high"],
    inputCapacity: 99999,
    constrainsOutput: true,
    generate: async ({ messages, observeRequest }) => {
        const accounting = {
            provider: "provider:fake",
            model: "fake",
            outcome: "response",
            usage,
            cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "rail fixture" },
        } as const;
        const settle = await observeRequest?.({ provider: accounting.provider, model: accounting.model });
        await settle?.(accounting);
        return { ...response, accounting: [accounting], capacity: testProviderCapacity(messages, 100000) };
    },
    countPromptTokens: async () => ({ kind: "exact", tokens: 1, source: "test:exact" }),
    assessRequestCapacity: async (messages) => testProviderCapacity(messages, 100000),
});

// A Mock that RECORDS what generate receives — the end of the chain, observed directly.
const recordingProvider = (): { provider: Provider; calls: Array<{ grammar?: string }> } => {
    const calls: Array<{ grammar?: string }> = [];
    const base = new Mock({ contextWindow: 100000, responses: [
        { assistant: { content: "```SEND\nok\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", reasoning: null } },
    ] });
    // plain delegation — a Proxy breaks Mock's private-field getters (#contextWindow via Reflect)
    const provider = {
        get contextWindow() { return base.contextWindow; },
        get maxInputTokens() { return base.maxInputTokens; },
        get maxOutputTokens() { return base.maxOutputTokens; },
        get outputBudget() { return base.outputBudget; },
        get reasoningBudget() { return base.reasoningBudget; },
        get supportedReasoningPolicies() { return base.supportedReasoningPolicies; },
        get inputModalities() { return base.inputModalities; },
        get inputCapacity() { return base.inputCapacity; },
        get model() { return base.model; },
        countPromptTokens: (...args: Parameters<Mock["countPromptTokens"]>) => base.countPromptTokens(...args),
        assessRequestCapacity: (...args: Parameters<Mock["assessRequestCapacity"]>) => base.assessRequestCapacity(...args),
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

test("{§operator-grammar} the operator's grammar file text reaches generate through a real turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "probe.gbnf");
    await writeFile(gbnfPath, 'root ::= "PROBE-RAIL"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railprobe";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        const { provider, calls } = recordingProvider();
        ProviderInstantiate.registerConfigurationScope(provider, "railprobe");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, workerId, loopId } = await envelope(db);
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        assert.equal(calls.length, 1, "one generate call");
        assert.equal(calls[0].grammar, 'root ::= "PROBE-RAIL"\n', "the grammar FILE TEXT arrived at the provider, verbatim");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

test("{§grammar-configuration-admission} an alias-free provider ignores unrelated suffixed grammars and uses the global configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "probe.gbnf");
    await writeFile(gbnfPath, 'root ::= "PROBE-RAIL"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_someotheralias";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        // Remove the active selector so this provider is explicitly alias-free.
        const modelKeys = Object.keys(process.env).filter((k) => k.startsWith("PLURNK_MODEL"));
        const savedModels = modelKeys.map((k) => [k, process.env[k]] as const);
        for (const k of modelKeys) delete process.env[k];
        try {
            const { provider, calls } = recordingProvider();
            ProviderInstantiate.registerConfigurationScope(provider, null);
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const { workspaceId, workerId, loopId } = await envelope(db);
            await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
            assert.equal(calls.length, 1);
            assert.equal(calls[0].grammar, undefined, "another alias's grammar is not a global fallback");
        } finally { for (const [k, v] of savedModels) process.env[k] = v; }
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});

test("{§operator-grammar} a configured but unloadable grammar fails instead of running unconstrained", async () => {
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railbroken";
    const prior = process.env[key];
    try {
        process.env[key] = "/nonexistent/rail/never-here.gbnf";
        const { provider } = recordingProvider();
        ProviderInstantiate.registerConfigurationScope(provider, "railbroken");
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

test("{§operator-grammar} a bare profile name fails by name: the service ships no grammar", async () => {
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_railnamed";
    const prior = process.env[key];
    try {
        process.env[key] = "plurnk.qwen.gbnf";
        const { provider, calls } = recordingProvider();
        ProviderInstantiate.registerConfigurationScope(provider, "railnamed");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, workerId, loopId } = await envelope(db);
        await assert.rejects(
            () => engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 }),
            /names a bundled grammar profile; the service ships none/,
        );
        assert.equal(calls.length, 0, "nothing reached the provider");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close();
    }
});

test("{§operator-grammar} the turn records whether the grammar reached the wire, and grades nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rail-"));
    const gbnfPath = join(dir, "evidence.gbnf");
    await writeFile(gbnfPath, 'root ::= "anything the operator wrote"\n');
    const db = await openMigrated();
    const key = "PLURNK_PROVIDERS_GBNF_evidencebox";
    const prior = process.env[key];
    try {
        process.env[key] = gbnfPath;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const { workspaceId, workerId, loopId } = await envelope(db);
        // The emission does not match the grammar at all; nothing in the service cares.
        const content = "```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";
        const transported = staticProvider({
            assistant: { content, reasoning: null, finishReason: "stop", model: "fake" },
            assistantRaw: {},
            grammarEvidence: { input: content, contentStart: 0, transported: true },
        });
        ProviderInstantiate.registerConfigurationScope(transported, "evidencebox");
        const t1 = await engine.runTurn({ provider: transported, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });
        const meta1 = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: t1.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(meta1.railsAttached, "client", "transport evidence is recorded");
        assert.equal("railsVerdict" in meta1, false, "no verdict exists any more");

        const withheld = staticProvider({
            assistant: { content, reasoning: null, finishReason: "stop", model: "fake" },
            assistantRaw: {},
            grammarEvidence: { input: content, contentStart: 0, transported: false },
        });
        ProviderInstantiate.registerConfigurationScope(withheld, "evidencebox");
        const t2 = await engine.runTurn({ provider: withheld, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const meta2 = JSON.parse((await db.test_get_turn_meta.get<{ meta: string }>({ id: t2.turnId }))!.meta) as Record<string, unknown>;
        assert.equal(meta2.railsAttached, "withheld", "a provider that did not send it says so, and the turn still completes");
    } finally {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
        await db.close(); await rm(dir, { recursive: true, force: true });
    }
});
