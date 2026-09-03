import test from "node:test";
import assert from "node:assert/strict";
import Mock from "./Mock.ts";
import Pool from "./Pool.ts";
import { inputModalitiesOf } from "./catalogProvider.ts";
import { estimatePromptTokens } from "./promptTokens.ts";
import { chatMessageText, type ChatMessage, type PromptTokenMeasurement } from "./types.ts";

const tokensOf = (measurement: PromptTokenMeasurement): number => "tokens" in measurement ? measurement.tokens : -1;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const parts: ChatMessage = {
    role: "user",
    content: [
        { type: "text", text: "look at this" },
        { type: "image", image: PNG, mediaType: "image/png" },
        { type: "file", data: PDF, mediaType: "application/pdf" },
    ],
};

test("{§provider-input-modalities} message text is the text parts alone; image and file parts count nothing here", () => {
    assert.equal(chatMessageText(parts), "look at this");
    assert.equal(chatMessageText({ content: "plain" }), "plain");
    assert.equal(tokensOf(estimatePromptTokens([parts])), Math.ceil("look at this".length / 2));
});

test("{§provider-input-modalities} the catalog's modalities are kept to the wire vocabulary; unknown models declare none", () => {
    assert.deepEqual([...inputModalitiesOf(["text", "image", "video", "pdf"])], ["image", "video", "pdf"]);
    assert.deepEqual([...inputModalitiesOf(["text", "audio", "hologram"])], ["audio"]);
    assert.deepEqual([...inputModalitiesOf(undefined)], []);
});

test("{§provider-input-modalities} the Mock declares modalities by option and records what it received", async () => {
    const blind = new Mock({ contextWindow: 200000, responses: [] });
    assert.deepEqual([...blind.inputModalities], []);
    const seeing = new Mock({ contextWindow: 200000, responses: [], inputModalities: ["image", "pdf"] });
    assert.ok(seeing.inputModalities.has("image") && seeing.inputModalities.has("pdf") && !seeing.inputModalities.has("audio"));
    assert.equal(tokensOf(await seeing.countPromptTokens([parts])), Math.ceil("look at this".length / 2));
    await assert.rejects(seeing.generate({ messages: [parts], maxOutputTokens: 16, workerId: "1", primaryWorkerId: "1", callKind: "bare" } as never));
    assert.equal(seeing.received.length, 1, "the request was recorded before the empty queue refused it");
    const received = seeing.received[0]?.[0]?.content;
    assert.ok(Array.isArray(received) && received[1]?.type === "image" && received[2]?.type === "file" && received[2].mediaType === "application/pdf");
});

test("{§provider-input-modalities} a pool accepts a modality only when every backend does", () => {
    const both = new Mock({ contextWindow: 200000, responses: [], inputModalities: ["image", "pdf"] });
    const imageOnly = new Mock({ contextWindow: 200000, responses: [], inputModalities: ["image"] });
    const blind = new Mock({ contextWindow: 200000, responses: [] });
    assert.deepEqual([...new Pool([both, both]).inputModalities], ["image", "pdf"]);
    assert.deepEqual([...new Pool([both, imageOnly]).inputModalities], ["image"]);
    assert.deepEqual([...new Pool([both, blind]).inputModalities], []);
});
