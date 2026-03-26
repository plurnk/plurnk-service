import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import Parser from "./Parser.js";

const ROOT = path.resolve(import.meta.dirname, "..");

export async function testLanguage(
	langId,
	{ examplesDir, extensions, maxFiles = 100 },
) {
	const languageDir = path.join(ROOT, "languages", langId);
	const parser = await Parser.load(languageDir);
	assert.ok(parser, `Parser for ${langId} should load`);

	const examplesPath = path.join(ROOT, examplesDir);
	const allFiles = await collectFiles(examplesPath, extensions);
	const files = allFiles.slice(0, maxFiles);

	describe(`${langId} — grammar zoo examples (${files.length}/${allFiles.length} files)`, () => {
		for (const file of files) {
			const rel = path.relative(examplesPath, file);

			it(`parses ${rel}`, async () => {
				const source = await fs.readFile(file, "utf-8");
				const symbols = parser.parse(source);
				assert.ok(Array.isArray(symbols), "should return an array");
				for (const sym of symbols) {
					assert.ok(sym.name, "symbol must have a name");
					assert.ok(sym.kind, "symbol must have a kind");
					assert.ok(typeof sym.line === "number", "symbol must have a line");
					assert.ok(
						typeof sym.endLine === "number",
						"symbol must have an endLine",
					);
					if (sym.params) {
						assert.ok(Array.isArray(sym.params), "params must be an array");
					}
				}
			});
		}
	});
}

async function collectFiles(dir, extensions) {
	const results = [];
	const entries = await fs.readdir(dir, {
		withFileTypes: true,
		recursive: true,
	});
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const ext = path.extname(entry.name);
		if (!extensions.includes(ext)) continue;
		results.push(path.join(entry.parentPath ?? entry.path, entry.name));
	}
	return results.sort();
}
