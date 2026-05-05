import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import Parser from "../../lib/Parser.js";
import { testLanguage } from "../../lib/testutil.js";

await testLanguage("markdown", {
	examplesDir: "languages/markdown/examples",
	extensions: [".md", ".markdown"],
});

describe("markdown — heading extraction", () => {
	it("extracts ATX headings at every level", async () => {
		const parser = await Parser.load(path.resolve(import.meta.dirname));
		const source = await fs.readFile(
			path.join(import.meta.dirname, "examples/test.md"),
			"utf-8",
		);
		const flat = flatten(parser.parse(source));

		const names = flat.map((s) => s.name);
		const levels = flat.map((s) => s.level);

		assert.ok(names.includes("Top-level Heading"), "missing top-level heading");
		assert.ok(names.includes("Section One"), "missing Section One");
		assert.ok(names.includes("Subsection"), "missing Subsection");
		assert.ok(names.includes("Level Four"), "missing Level Four");
		assert.ok(names.includes("Level Five"), "missing Level Five");
		assert.ok(names.includes("Level Six"), "missing Level Six");
		assert.ok(names.includes("Final Section"), "missing Final Section");

		for (const level of levels) {
			assert.ok(level >= 1 && level <= 6, `bad level ${level}`);
		}
	});

	it("strips trailing closing hashes", async () => {
		const parser = await Parser.load(path.resolve(import.meta.dirname));
		const symbols = flatten(parser.parse("## Title with closer ##\n"));
		assert.equal(symbols.length, 1);
		assert.equal(symbols[0].name, "Title with closer");
		assert.equal(symbols[0].level, 2);
	});

	it("ignores '#' lines inside fenced code blocks", async () => {
		const parser = await Parser.load(path.resolve(import.meta.dirname));
		const src = "# Real heading\n\n```\n# fake heading\n```\n# Another real\n";
		const symbols = flatten(parser.parse(src));
		const names = symbols.map((s) => s.name);
		assert.deepEqual(names, ["Real heading", "Another real"]);
	});

	it("ignores '#' lines inside tilde fences", async () => {
		const parser = await Parser.load(path.resolve(import.meta.dirname));
		const src = "~~~\n# fake\n~~~\n## real\n";
		const symbols = flatten(parser.parse(src));
		assert.deepEqual(
			symbols.map((s) => s.name),
			["real"],
		);
	});

	it("ignores indented code blocks (4+ space prefix)", async () => {
		const parser = await Parser.load(path.resolve(import.meta.dirname));
		const src = "    # not a heading\n# real heading\n";
		const symbols = flatten(parser.parse(src));
		assert.deepEqual(
			symbols.map((s) => s.name),
			["real heading"],
		);
	});

	it("requires a space (or tab) after the # marks", async () => {
		const parser = await Parser.load(path.resolve(import.meta.dirname));
		const symbols = flatten(parser.parse("#nope\n# yes\n"));
		assert.deepEqual(
			symbols.map((s) => s.name),
			["yes"],
		);
	});

	it("rejects more than 6 # marks", async () => {
		const parser = await Parser.load(path.resolve(import.meta.dirname));
		const symbols = flatten(parser.parse("####### too many\n###### h6\n"));
		assert.deepEqual(
			symbols.map((s) => s.name),
			["h6"],
		);
	});
});

function flatten(roots) {
	const out = [];
	const walk = (nodes) => {
		for (const n of nodes) {
			out.push(n);
			if (n.children) walk(n.children);
		}
	};
	walk(roots);
	return out;
}
