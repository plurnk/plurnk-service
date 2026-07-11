// Coverage: SPEC §19 (tokenizer seam).
// Issue #44 (providers agent): the tokenizer seam — exact LLM token counting
// on the embeddings pattern. Mimetypes.tokenizer(modelRef) resolves through the
// opt-in @plurnk/plurnk-mimetypes-tokenizers artifact:
//
//   T1. bundled match → exact:true, artifact's countTokens + vocab-sha id.
//   T2. package missing → chars/2 upper bound, exact:false, tokenizer_unavailable
//       warn naming the model + plurnkPackage install hint. Never silent.
//   T3. package present but no bundled match → same degrade, no install hint.
//   T4. strict throws instead of degrading (both flavors).
//   T5. present-but-broken artifact rethrows (never downgraded to "absent" —
//       the Embeddings loader lesson).
//   T6. artifact loads once per orchestrator lifetime (primed-promise cache).

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
    extensions: [".txt"],
    binary: false,
    source: "package",
};

function makeDiscovery(): Discovery {
    const registry: Registry = {
        byExtension: new Map([[".txt", "text/plain"]]),
        byFilename: new Map(),
    };
    return { registry, handlers: new Map([["text/plain", INFO]]) };
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
                if (artifact === null) throw Object.assign(new Error("MODULE_NOT_FOUND"), { code: "ERR_MODULE_NOT_FOUND" });
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
        assert.equal(r.telemetry, undefined);
        assert.equal(await r.countTokens("one two three"), 3, "delegates to the artifact's tokenizer");
    });
});

describe("Issue #44 — T2: missing package degrades honestly", () => {
    it("chars/2 upper bound + tokenizer_unavailable warn with install hint", async () => {
        const { m } = mk(null);
        const r = await m.tokenizer("gemma-4-26b");
        assert.equal(r.exact, false);
        assert.equal(r.tokenizerId, "heuristic:chars2");
        assert.equal(await r.countTokens("abc"), 2, "ceil(3/2)");
        assert.equal(await r.countTokens(""), 0);
        assert.equal(r.telemetry?.length, 1);
        const ev = r.telemetry![0];
        assert.equal(ev.kind, "tokenizer_unavailable");
        assert.equal(ev.level, "warn");
        assert.equal(ev.source, "tokenizer");
        assert.equal(ev.model, "gemma-4-26b");
        assert.equal(ev.plurnkPackage, TOK_PKG);
    });
});

describe("Issue #44 — T3: no bundled match degrades honestly", () => {
    it("same degrade shape, names the model, no install hint", async () => {
        const { m } = mk(fakeArtifact);
        const r = await m.tokenizer("claude-fable-5");
        assert.equal(r.exact, false);
        assert.equal(r.tokenizerId, "heuristic:chars2");
        assert.equal(r.telemetry?.[0].kind, "tokenizer_unavailable");
        assert.equal(r.telemetry?.[0].model, "claude-fable-5");
        assert.equal(r.telemetry?.[0].plurnkPackage, undefined);
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
});

describe("Issue #44 — T6: artifact loads once", () => {
    it("two tokenizer() calls share one load", async () => {
        const { m, loads } = mk(fakeArtifact);
        await m.tokenizer("gemma-4-26b");
        await m.tokenizer("gemma-4-26b");
        assert.equal(loads(), 1);
    });
});
