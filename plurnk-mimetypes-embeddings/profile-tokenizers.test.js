import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    countProfileTokens,
    disposeProfileTokenizers,
    profileTokenizerFacts,
} from "./profile-tokenizers.js";

const manifest = JSON.parse(readFileSync(new URL("./profile-tokenizers/manifest.json", import.meta.url), "utf8"));
const sample = "Repair the leaking garden hose, then verify the connection under pressure.";

describe("embedding-profile exact tokenizers ({§mimetype-embedding-profile})", () => {
    for (const family of Object.keys(manifest)) {
        it(`${family} owns one exact vocabulary identity and counter`, async () => {
            assert.equal(profileTokenizerFacts(family).tokenizerId, manifest[family].tokenizerId);
            const count = await countProfileTokens(family, sample);
            assert.ok(count > 0 && count < sample.length, `${family}: implausible token count ${count}`);
            assert.equal(await countProfileTokens(family, ""), 0);
        });
    }

    it("honors cancellation before loading or encoding", async () => {
        const reason = new DOMException("planning cancelled", "AbortError");
        await assert.rejects(
            countProfileTokens("qwen3embed06", "never counted", { signal: AbortSignal.abort(reason) }),
            (error) => error === reason,
        );
    });

    it("disposes cached engines without changing exact results", async () => {
        const before = await countProfileTokens("cl100k", sample);
        disposeProfileTokenizers();
        assert.equal(await countProfileTokens("cl100k", sample), before);
    });
});
