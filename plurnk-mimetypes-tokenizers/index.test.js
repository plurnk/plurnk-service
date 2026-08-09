// {§mimetype-tokenizer} Every bundled family must load through the engine and
// count plausibly; the registry must route refs to the right vocabulary;
// unmatched refs are an honest null.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dispose } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("./tokenizers/manifest.json", import.meta.url), "utf-8"));

// The family key is the caller's explicit vocabulary selection.
const REFS = Object.fromEntries(Object.keys(manifest).map((family) => [family, family]));

// Representative {§mimetype-tokenizer} input: English + code + plurnk DSL.
const SAMPLE = 'READ<<EDIT[fix](src/index.ts)<12>:const x = users.filter((u) => u.active);:EDIT — apply the patch, then re-run the failing test and report the count.';

describe("every bundled family loads and counts", () => {
    for (const [family, ref] of Object.entries(REFS)) {
        it(`${family} ← ${JSON.stringify(ref)}`, async () => {
            const hit = await resolve(ref);
            assert.notEqual(hit, null, `expected ${ref} to route to ${family}`);
            assert.equal(hit.tokenizerId, manifest[family].tokenizerId, "id must be the manifest's vocab sha prefix");
            const n = await hit.countTokens(SAMPLE);
            // Plausibility band: real tokenizers run ~2–5 chars/token on this
            // text; a broken load would produce 0 or char-count-scale numbers.
            assert.ok(n > SAMPLE.length / 8 && n < SAMPLE.length, `${family}: implausible count ${n} for ${SAMPLE.length} chars`);
            assert.equal(await hit.countTokens(""), 0, "empty text counts zero");
        });
    }
});

describe("exact selection and honesty", () => {
    it("every pinned source ref selects its own manifest vocabulary", async () => {
        for (const [family, entry] of Object.entries(manifest)) {
            assert.equal((await resolve(entry.repo)).tokenizerId, entry.tokenizerId, family);
        }
    });
    it("the embedding-space wrapper preserves an exact pinned source ref", async () => {
        const hit = await resolve("remote:Qwen/Qwen2.5-7B-Instruct@d768");
        assert.equal(hit.tokenizerId, manifest.qwen.tokenizerId);
    });
    it("an aborted count is terminal before vocabulary work begins", async () => {
        const hit = await resolve("gemma");
        const reason = new DOMException("planning cancelled", "AbortError");
        await assert.rejects(
            hit.countTokens("never counted", { signal: AbortSignal.abort(reason) }),
            (error) => error === reason,
        );
    });
    it("an unknown ref is an honest null, never a close-enough guess", async () => {
        assert.equal(await resolve("claude-fable-5"), null);
        assert.equal(await resolve("roberta-base"), null, "roberta is not bert");
    });
    it("family-looking future generations and custom labels are not exact vocabulary claims (#173)", async () => {
        for (const ref of ["llama-5", "gemma-4-26b", "deepseek-v4-pro", "mistral-custom"]) {
            assert.equal(await resolve(ref), null, `${ref} has no exact pinned mapping`);
        }
    });
    it("a non-string / empty ref is a contract violation", async () => {
        await assert.rejects(() => resolve(""), TypeError);
        await assert.rejects(() => resolve(undefined), TypeError);
    });
});

describe("engine lifecycle", () => {
    it("dispose() drops engines; resolve re-lazy-inits", async () => {
        const before = await (await resolve("gemma")).countTokens("hello world");
        dispose();
        const after = await (await resolve("gemma")).countTokens("hello world");
        assert.equal(before, after);
    });
});
