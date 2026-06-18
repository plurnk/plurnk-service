// PacketWire.previewPrompt — the prompt-body cap rendered in user.prompt
// (PLURNK_PROMPT_PREVIEW_CHARS). A long prompt is sliced to the cap + a pointer to the full
// body (its READable entry); a short prompt and a negative cap pass through untouched.

import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "./packet-wire.ts";

const ADDR = "plurnk://prompt/7/3";

test("previewPrompt slices a long prompt and appends the full-body pointer", () => {
    const long = "x".repeat(1000);
    const out = PacketWire.previewPrompt(long, ADDR, 512);
    assert.equal(out.slice(0, 512), "x".repeat(512), "the first cap chars are preserved verbatim");
    assert.match(out, /full body READable at plurnk:\/\/prompt\/7\/3/, "a pointer to the full entry is appended");
    assert.ok(out.length < long.length, "the body is truncated, not duplicated");
});

test("previewPrompt passes a prompt at or under the cap through untouched", () => {
    const short = "describe this project";
    assert.equal(PacketWire.previewPrompt(short, ADDR, 512), short);
    assert.equal(PacketWire.previewPrompt("x".repeat(512), ADDR, 512), "x".repeat(512), "exactly-cap is not truncated");
});

test("previewPrompt with a negative cap renders the full prompt (no cap)", () => {
    const long = "x".repeat(1000);
    assert.equal(PacketWire.previewPrompt(long, ADDR, -1), long);
});
