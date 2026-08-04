// Contract: {§mimetype-tokenizer}. Issue #44 is provenance.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

const TOK_PKG = "@plurnk/plurnk-mimetypes-tokenizers";

const INFO: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    projectionRevision: "test-1",
    extensions: [".txt"],
    binary: false,
    source: "package",
};

function makeDiscovery(): Discovery {
    const registry: Registry = {
        byExtension: new Map([[".txt", "text/plain"]]),
        byFilename: new Map(),
    };
    return { registry, handlers: new Map([["text/plain", INFO]]), skipped: [] };
}

// Fake artifact: knows "gemma" only; counts words so delegation to THIS
// function is provable (chars/2 of the fixtures never equals the word count).
const fakeArtifact = {
    async resolve(modelRef: string) {
        if (!/gemma/i.test(modelRef)) return null;
        return {
            tokenizerId: "abc123def4567890",
            async countTokens(text: string): Promise<number> {
                return text.split(/\s+/).filter(Boolean).length;
            },
        };
    },
};

function mk(artifact: unknown | null, loadError?: Error) {
    let loads = 0;
    const m = new Mimetypes({
        discovery: makeDiscovery(),
        loader: async (pkg) => {
            if (pkg === TOK_PKG) {
                loads += 1;
                if (loadError) throw loadError;
                if (artifact === null) {
                    throw Object.assign(
                        new Error(`Cannot find package '${TOK_PKG}' imported from test`),
                        { code: "ERR_MODULE_NOT_FOUND" },
                    );
                }
                return artifact;
            }
            return { default: BaseHandler };
        },
    });
    return { m, loads: () => loads };
}

describe("Issue #44 — T1: bundled match resolves exact", () => {
    it("returns the artifact's counter and vocab-sha id, exact:true", async () => {
        const { m } = mk(fakeArtifact);
        const r = await m.tokenizer("gemma-4-26b");
        assert.equal(r.exact, true);
        assert.equal(r.tokenizerId, "abc123def4567890");
        assert.equal(r.notices, undefined);
        assert.equal(await r.countTokens("one two three"), 3, "delegates to the artifact's tokenizer");
    });
});

describe("Issue #44 — T2: missing package degrades honestly", () => {
    it("chars/2 estimate + tokenizer_unavailable warn with install hint", async () => {
        const { m } = mk(null);
        const r = await m.tokenizer("gemma-4-26b");
        assert.equal(r.exact, false);
        assert.equal(r.tokenizerId, "heuristic:chars2");
        assert.equal(await r.countTokens("abc"), 2, "ceil(3/2)");
        assert.equal(await r.countTokens(""), 0);
        assert.equal(r.notices?.length, 1);
        const ev = r.notices![0];
        assert.equal(ev.kind, "tokenizer_unavailable");
        assert.equal(ev.level, "warn");
        assert.equal(ev.source, "tokenizer");
        assert.equal(ev.model, "gemma-4-26b");
        assert.equal(ev.plurnkPackage, TOK_PKG);
        assert.match(String(ev.message), /degraded chars\/2 estimate/);
        assert.doesNotMatch(String(ev.message), /upper bound/);
    });
});

describe("Issue #44 — T3: no bundled match degrades honestly", () => {
    it("same degrade shape, names the model, no install hint", async () => {
        const { m } = mk(fakeArtifact);
        const r = await m.tokenizer("claude-fable-5");
        assert.equal(r.exact, false);
        assert.equal(r.tokenizerId, "heuristic:chars2");
        assert.equal(r.notices?.[0].kind, "tokenizer_unavailable");
        assert.equal(r.notices?.[0].model, "claude-fable-5");
        assert.equal(r.notices?.[0].plurnkPackage, undefined);
    });
});

describe("Issue #44 — T4: strict throws instead of degrading", () => {
    it("missing package → throws with the install hint", async () => {
        const { m } = mk(null);
        await assert.rejects(
            () => m.tokenizer("gemma-4-26b", { strict: true }),
            /is not installed/,
        );
    });
    it("no bundled match → throws naming the ref", async () => {
        const { m } = mk(fakeArtifact);
        await assert.rejects(
            () => m.tokenizer("claude-fable-5", { strict: true }),
            /no tokenizer matching/,
        );
    });
});

describe("Issue #44 — T5: present-but-broken artifact rethrows", () => {
    it("a non-MODULE_NOT_FOUND load error propagates, never degrades", async () => {
        const { m } = mk(null, new RangeError("tokenizers artifact misconfigured"));
        await assert.rejects(
            () => m.tokenizer("gemma-4-26b"),
            /misconfigured/,
        );
    });

    it("an installed artifact without resolve() fails as incompatible (#85)", async () => {
        const { m } = mk({});
        await assert.rejects(
            () => m.tokenizer("gemma-4-26b"),
            /does not implement resolve\(\)/,
        );
    });
});

describe("Issue #44 — T6: artifact loads once", () => {
    it("two tokenizer() calls share one load", async () => {
        const { m, loads } = mk(fakeArtifact);
        await m.tokenizer("gemma-4-26b");
        await m.tokenizer("gemma-4-26b");
        assert.equal(loads(), 1);
    });
});
