import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import Audio from "./Audio.ts";
import { wav } from "../test/wav.ts";

for (const mimetype of ["audio/wav", "audio/x-wav", "audio/vnd.wave"]) {
    test(`{§mimetype-audio-facts} ${mimetype} has duration facts and a compact readable projection`, async () => {
        const handler = new Audio({ mimetype, glyph: "🎵", extensions: [] });
        const bytes = wav();
        await handler.validate(bytes);
        const facts = await handler.facts(bytes);
        assert.deepEqual(facts, { format: "WAVE", duration: 1, bytes: bytes.length });
        assert.strictEqual(await handler.deepJson(bytes), facts);
        assert.equal(await handler.content(bytes), `WAVE audio, 1 s, ${bytes.length} bytes`);
        assert.equal(await handler.summary(bytes), await handler.content(bytes));
    });
}

test("{§mimetype-audio-facts} invalid bytes and text are not presented as native audio", async () => {
    const handler = new Audio({ mimetype: "audio/wav", glyph: "🎵", extensions: [] });
    await assert.rejects(handler.validate("not binary"), /Uint8Array/u);
    await assert.rejects(handler.validate(new TextEncoder().encode("not an audio container")), { name: "SyntaxError", message: "No audio track identified in the source bytes." });
});

test("{§mimetype-audio-facts} MPEG frames without a reliable duration preserve unknown rather than inventing time", async () => {
    const bytes = Buffer.alloc(417 * 3);
    for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
    const handler = new Audio({ mimetype: "audio/mpeg", glyph: "🎵", extensions: [] });
    assert.deepEqual(await handler.facts(bytes), { format: "MPEG", duration: null, bytes: 1251 });
    assert.equal(await handler.content(bytes), "MPEG audio, 1251 bytes");
});

test("{§mimetype-audio-facts} loading the handler does not load the media parser", () => {
    execFileSync(process.execPath, ["--conditions=plurnk-dev", "--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { registerHooks } from "node:module";
        let parserLoaded = false;
        registerHooks({ load(url, context, next) {
            if (url.includes("/music-metadata/")) parserLoaded = true;
            return next(url, context);
        } });
        const { default: Audio } = await import(${JSON.stringify(new URL("./Audio.ts", import.meta.url).href)});
        const audio = new Audio({ mimetype: "audio/wav", glyph: "", extensions: [] });
        assert.equal(parserLoaded, false);
        await assert.rejects(audio.validate(new Uint8Array(20)));
        assert.equal(parserLoaded, true);
    `], { stdio: "pipe" });
});
