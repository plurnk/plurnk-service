import test from "node:test";
import { strict as assert } from "node:assert";
import type { PacketSection, PacketSectionTransformer } from "./index.ts";

const section = (over: Partial<PacketSection>): PacketSection =>
    ({ name: "x", slot: "system", header: null, content: "", tokens: 0, ...over });

test("PacketSectionTransformer: a scheme reshapes the section list (add/reorder)", async () => {
    const t: PacketSectionTransformer = {
        transformSections(sections) {
            return [...sections, section({ name: "footer", slot: "user", content: "fin", tokens: 1 })];
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
