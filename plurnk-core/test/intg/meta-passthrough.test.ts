// #252 — the provider→client metadata passthrough. The service forwards the provider's
// opaque `meta` blob to the client (in the loop usage payload), stored UNENFORCED: it never
// reads a field within. The canonical-field contract (e.g. balancePico) is the provider
// framework's (it normalizes) and the client's (it renders), never the service's.

import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderResponse } from "@plurnk/plurnk-providers";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

// Mock can't return `meta`; wrap it so the turn still concludes (SEND[200]) but the
// response carries an opaque blob — exactly what a real hosted provider does.
class MetaProvider implements Provider {
    #base: Mock;
    #meta: Record<string, unknown>;
    constructor(meta: Record<string, unknown>) {
        this.#base = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        this.#meta = meta;
    }
    get contextWindow(): number | null { return this.#base.contextWindow; }
    get model(): string { return this.#base.model; }
    countTokens(text: string): number { return this.#base.countTokens(text); }
    costFor(usage: Parameters<Mock["costFor"]>[0]): number { return this.#base.costFor(usage); }
    async generate(args: Parameters<Mock["generate"]>[0]): Promise<ProviderResponse> {
        return { ...(await this.#base.generate(args)), meta: this.#meta };
    }
}

test("[§meta-passthrough] a provider's opaque meta blob rides through to the loop usage payload, unenforced (#252)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `meta-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        const meta = { balancePico: 123456789, vendorWhatever: { nested: true }, future: "field we never coded for" };
        await engine.runTurn({ provider: new MetaProvider(meta), workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });

        const usage = await engine.loopUsage(loopId);
        // Forwarded verbatim — including fields the service has never heard of (the honest passthrough).
        assert.deepEqual(usage.meta, meta, "the provider's whole meta blob reaches the loop payload, byte-for-byte");
        assert.equal((usage.meta as { balancePico: number }).balancePico, 123456789, "a canonical field (balancePico) is reachable by the client");
    } finally { await db.close(); }
});

test("[§meta-passthrough] no provider meta → empty {} (never null, never fabricated)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `meta-empty-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // A plain Mock returns no `meta`.
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });

        const usage = await engine.loopUsage(loopId);
        assert.deepEqual(usage.meta, {}, "absent provider meta surfaces as {}, so the client renders nothing");
    } finally { await db.close(); }
});
