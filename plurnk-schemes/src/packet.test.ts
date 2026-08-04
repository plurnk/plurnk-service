import test from "node:test";
import { strict as assert } from "node:assert";
import { PacketSections, type PacketSectionDraft, type PacketSectionTransformer } from "./index.ts";

const section = (over: Partial<PacketSectionDraft> = {}): PacketSectionDraft =>
    ({ name: "x", slot: "system", header: null, content: "", ...over });

test("PacketSectionTransformer: a scheme reshapes the section list (add/reorder)", async () => {
    const t: PacketSectionTransformer = {
        transformSections(sections) {
            return [...sections, section({ name: "footer", slot: "user", content: "fin" })];
        },
    };
    const out = await t.transformSections([section({ name: "tools" })]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((s) => s.name), ["tools", "footer"]);
});

test("PacketSectionTransformer: async transform + removal supported", async () => {
    const t: PacketSectionTransformer = {
        async transformSections(sections) {
            return sections.filter((s) => s.slot === "system");
        },
    };
    const out = await t.transformSections([section({ slot: "system" }), section({ name: "u", slot: "user" })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].slot, "system");
});

test("PacketSections: exact valid drafts preserve their list", () => {
    const drafts = [section({ name: "definition" }), section({ name: "prompt", slot: "user" })];
    assert.equal(PacketSections.assertDrafts(drafts), drafts);
});

test("PacketSections: malformed draft lists fail with their exact location", () => {
    assert.throws(() => PacketSections.assertDrafts(null), /packet section drafts must be an array/);
    assert.throws(
        () => PacketSections.assertDrafts([{ name: "x", slot: "assistant", header: null, content: "" }]),
        /packet section drafts\[0\]\.slot must be system or user/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ name: "x", slot: "user", header: null }]),
        /packet section drafts\[0\] is missing field 'content'/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ ...section(), tokens: 0 }]),
        /packet section drafts\[0\] has unexpected field 'tokens'/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([section(), section()]),
        /packet section drafts has duplicate section name 'x'/,
    );
});
