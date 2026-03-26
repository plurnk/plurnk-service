#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import Formatter from "./Formatter.js";
import Parser from "./Parser.js";

const EXTENSIONS = Object.freeze({
	".js": "javascript--javascript",
	".mjs": "javascript--javascript",
});

const { positionals } = parseArgs({
	allowPositionals: true,
	options: {},
});

if (positionals.length === 0) {
	console.error("Usage: antlrmap <file1> [file2] [file3] ...");
	process.exit(1);
}

const languagesDir = path.resolve(import.meta.dirname, "..", "languages");

// Load parsers for the file extensions we encounter
const parserCache = new Map();

async function getParser(ext) {
	const langId = EXTENSIONS[ext];
	if (!langId) return null;
	if (parserCache.has(langId)) return parserCache.get(langId);

	const parser = await Parser.load(path.join(languagesDir, langId));
	parserCache.set(langId, parser);
	return parser;
}

const cwd = process.cwd();
const results = [];

for (const filePath of positionals) {
	const resolved = path.resolve(filePath);
	const ext = path.extname(resolved);
	const parser = await getParser(ext);
	if (!parser) continue;

	const source = await fs.readFile(resolved, "utf-8");
	const symbols = parser.parse(source);
	if (symbols.length > 0) {
		results.push({ file: resolved, symbols });
	}
}

const output = Formatter.toJSON(results, cwd);
console.log(JSON.stringify(output, null, 2));
