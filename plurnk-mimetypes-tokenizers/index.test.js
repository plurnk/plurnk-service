// Real-data tests: every bundled family must load through the engine and count
// plausibly; the registry must route refs to the right vocab; unmatched refs are
// an honest null (plurnk-mimetypes#44 / SPEC §19).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dispose } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("./tokenizers/manifest.json", import.meta.url), "utf-8"));

// One representative ref per family — the routing truth table.
const REFS = {
    o200k: "gpt-4o-mini",
    cl100k: "gpt-4-turbo",
    llama3: "llama-3.1-8b-instruct",
    llama2: "Llama-2-13b-chat",
    gemma: "gemma-4-26b",
    deepseek: "deepseek-v4-pro",
    qwen: "qwen2.5-coder-32b",
    mistral: "mistral-large-latest",
    bert: "bert-base-uncased",
    t5: "flan-t5-xl",
};

// The #44 measurement text shape: English + code + plurnk DSL.
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

describe("routing precedence and honesty", () => {
    it("gpt-4o routes to o200k, not the gpt-4 cl100k rule", async () => {
        assert.equal((await resolve("gpt-4o")).tokenizerId, manifest.o200k.tokenizerId);
        assert.equal((await resolve("gpt-4")).tokenizerId, manifest.cl100k.tokenizerId);
    });
    it("llama-3 routes past the llama-2 catch-all; bare llama falls to llama2", async () => {
        assert.equal((await resolve("meta-llama/llama-3.3-70b")).tokenizerId, manifest.llama3.tokenizerId);
        assert.equal((await resolve("llama-2-7b")).tokenizerId, manifest.llama2.tokenizerId);
    });
    it("o-series reasoning refs route to o200k", async () => {
        assert.equal((await resolve("o3-mini")).tokenizerId, manifest.o200k.tokenizerId);
        assert.equal((await resolve("openai/o1")).tokenizerId, manifest.o200k.tokenizerId);
    });
    it("vocab identity is shared across model refs on the same vocabulary (#44)", async () => {
        const pro = await resolve("deepseek-v4-pro");
        const flash = await resolve("deepseek-v4-flash");
        assert.equal(pro.tokenizerId, flash.tokenizerId);
    });
    it("an unknown ref is an honest null, never a close-enough guess", async () => {
        assert.equal(await resolve("claude-fable-5"), null);
        assert.equal(await resolve("roberta-base"), null, "roberta is not bert");
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
