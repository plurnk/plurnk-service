import test from "node:test";
import assert from "node:assert/strict";
import Mock from "./Mock.ts";
import Pool from "./Pool.ts";
import { estimatePromptTokens } from "./promptTokens.ts";
import { chatMessageText, type ChatMessage, type PromptTokenMeasurement } from "./types.ts";

const tokensOf = (measurement: PromptTokenMeasurement): number => "tokens" in measurement ? measurement.tokens : -1;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const parts: ChatMessage = { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", image: PNG, mediaType: "image/png" }] };

test("{§provider-image-input} message text is the text parts alone; an image part counts nothing here", () => {
    assert.equal(chatMessageText(parts), "look at this");
    assert.equal(chatMessageText({ content: "plain" }), "plain");
    assert.equal(tokensOf(estimatePromptTokens([parts])), Math.ceil("look at this".length / 2));
});

test("{§provider-image-input} the Mock declares image input by option and records what it received", async () => {
    const blind = new Mock({ contextWindow: 200000, responses: [] });
    assert.equal(blind.imageInput, false);
    const seeing = new Mock({ contextWindow: 200000, responses: [], imageInput: true });
    assert.equal(seeing.imageInput, true);
    assert.equal(tokensOf(await seeing.countPromptTokens([parts])), Math.ceil("look at this".length / 2));
    await assert.rejects(seeing.generate({ messages: [parts], maxOutputTokens: 16, workerId: 1, primaryWorkerId: 1, callKind: "bare" } as never));
    assert.equal(seeing.received.length, 1, "the request was recorded before the empty queue refused it");
    const received = seeing.received[0]?.[0]?.content;
    assert.ok(Array.isArray(received) && received[1]?.type === "image" && received[1].mediaType === "image/png");
});

test("{§provider-image-input} a pool sees only when every backend sees", () => {
    const seeing = new Mock({ contextWindow: 200000, responses: [], imageInput: true });
    const blind = new Mock({ contextWindow: 200000, responses: [] });
    assert.equal(new Pool([seeing, seeing]).imageInput, true);
    assert.equal(new Pool([seeing, blind]).imageInput, false);
});
