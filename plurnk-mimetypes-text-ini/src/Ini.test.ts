import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ini from "./Ini.ts";

const META = { mimetype: "text/x-ini", glyph: "⚙️", extensions: [".ini"] };
const h = () => new Ini(META);

const CFG = [
    `root = true`,
    ``,
    `[metadata]`,
    `name = my-pkg`,
    `; a comment`,
    `version = 1.2.0`,
    ``,
    `[options]`,
    `python_requires = >=3.10`,
].join("\n");

describe("Ini — sections and keys as symbols", () => {
    it("sections are modules, keys are fields contained by their section", () => {
        const syms = h().extractRaw(CFG);
        const meta = syms.find((s) => s.name === "metadata");
        assert.equal(meta?.kind, "module");
        const version = syms.find((s) => s.name === "version");
        assert.equal(version?.kind, "field");
        assert.equal(version?.container, "metadata");
    });

    it("top-level keys before any section have no container", () => {
        const root = h().extractRaw(CFG).find((s) => s.name === "root");
        assert.equal(root?.kind, "field");
        assert.equal(root?.container, undefined);
    });
});

describe("Ini — deepJson nested object", () => {
    it("builds { section: { key: value } } with top-level keys at root", () => {
        const tree = h().deepJson(CFG) as Record<string, unknown>;
        assert.equal(tree.root, "true");
        assert.deepEqual(tree.metadata, { name: "my-pkg", version: "1.2.0" });
        assert.deepEqual(tree.options, { python_requires: ">=3.10" });
    });

    it("colon-delimited entries parse too", () => {
        const tree = h().deepJson(`[s]\nkey: value\n`) as Record<string, Record<string, string>>;
        assert.equal(tree.s.key, "value");
    });
});
