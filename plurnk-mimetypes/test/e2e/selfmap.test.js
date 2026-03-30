import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLI = path.join(ROOT, "lib", "index.js");

async function run(...files) {
	const { stdout } = await exec("node", [CLI, ...files], { cwd: ROOT });
	return JSON.parse(stdout);
}

function flatten(symbols) {
	const result = [];
	for (const sym of symbols) {
		result.push(sym);
		if (sym.children) result.push(...flatten(sym.children));
	}
	return result;
}

describe("antlrmap e2e — self-mapping", () => {
	it("maps its own source files to JSON", async () => {
		const output = await run(
			"lib/antlrmap.js",
			"lib/Parser.js",
			"lib/Formatter.js",
		);

		assert.equal(Array.isArray(output), true);
		assert.equal(output.length, 3);

		const files = output.map((e) => e.file);
		assert.ok(files.includes("lib/antlrmap.js"));
		assert.ok(files.includes("lib/Parser.js"));
		assert.ok(files.includes("lib/Formatter.js"));
	});

	it("nests class members under their parent class", async () => {
		const [entry] = await run("lib/Parser.js");
		const parserClass = entry.symbols.find(
			(s) => s.name === "Parser" && s.kind === "class",
		);
		assert.ok(parserClass, "Parser class should be at top level");
		assert.ok(
			Array.isArray(parserClass.children),
			"class should have children",
		);

		const childNames = parserClass.children.map((c) => c.name);
		assert.ok(
			childNames.includes("parse"),
			"parse should be a child of Parser",
		);
		assert.ok(childNames.includes("load"), "load should be a child of Parser");
		assert.ok(
			childNames.includes("#lexerClass"),
			"#lexerClass field should be a child of Parser",
		);

		// Methods should NOT appear at the top level
		const topNames = entry.symbols.map((s) => s.name);
		assert.ok(
			!topNames.includes("parse"),
			"parse should not be a top-level symbol",
		);
	});

	it("captures class declarations with methods and params", async () => {
		const [entry] = await run("lib/Parser.js");
		const all = flatten(entry.symbols);

		const parserClass = all.find(
			(s) => s.name === "Parser" && s.kind === "class",
		);
		assert.ok(parserClass, "Parser class should be found");

		const parseMethod = all.find(
			(s) => s.name === "parse" && s.kind === "method",
		);
		assert.ok(parseMethod, "parse method should be found");
		assert.deepEqual(parseMethod.params, ["source"]);

		const loadMethod = all.find(
			(s) => s.name === "load" && s.kind === "method",
		);
		assert.ok(loadMethod, "load method should be found");
		assert.deepEqual(loadMethod.params, ["languageDir"]);
	});

	it("excludes imports — they are dependencies, not definitions", async () => {
		const [entry] = await run("lib/Parser.js");
		const all = flatten(entry.symbols);
		const kinds = all.map((s) => s.kind);
		assert.ok(!kinds.includes("import"), "no import symbols should appear");
	});

	it("excludes local variables inside function bodies", async () => {
		const [entry] = await run("lib/Parser.js");
		const all = flatten(entry.symbols);
		const names = all.map((s) => s.name);
		assert.ok(!names.includes("chars"), "local 'chars' should not appear");
		assert.ok(!names.includes("tokens"), "local 'tokens' should not appear");
		assert.ok(!names.includes("lexer"), "local 'lexer' should not appear");
	});

	it("excludes unexported module-scope variables", async () => {
		const [entry] = await run("lib/antlrmap.js");
		const all = flatten(entry.symbols);
		const names = all.map((s) => s.name);
		assert.ok(
			!names.includes("LANGUAGES_DIR"),
			"unexported 'LANGUAGES_DIR' should not appear",
		);
		assert.ok(
			!names.includes("BUILTIN_EXTENSIONS"),
			"unexported 'BUILTIN_EXTENSIONS' should not appear",
		);
	});

	it("captures fields on classes", async () => {
		const [entry] = await run("lib/Parser.js");
		const parserClass = entry.symbols.find(
			(s) => s.name === "Parser" && s.kind === "class",
		);
		const fields = parserClass.children.filter((s) => s.kind === "field");
		const fieldNames = fields.map((f) => f.name);
		assert.ok(fieldNames.includes("#lexerClass"));
		assert.ok(fieldNames.includes("#parserClass"));
		assert.ok(fieldNames.includes("#mapClass"));
		assert.ok(fieldNames.includes("#entryRule"));
	});

	it("produces consistent format for single and multiple files", async () => {
		const single = await run("lib/Formatter.js");
		const multi = await run("lib/Formatter.js", "lib/Parser.js");

		assert.equal(Array.isArray(single), true);
		assert.equal(Array.isArray(multi), true);
		assert.equal(single.length, 1);
		assert.equal(multi.length, 2);

		assert.deepEqual(
			single[0],
			multi.find((e) => e.file === "lib/Formatter.js"),
		);
	});

	it("exits with error when no files given", async () => {
		await assert.rejects(
			() => exec("node", [CLI], { cwd: ROOT }),
			(err) => {
				assert.equal(err.code, 1);
				return true;
			},
		);
	});
});
