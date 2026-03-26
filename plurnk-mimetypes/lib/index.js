#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Antlrmap from "./antlrmap.js";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		supported: { type: "boolean", default: false },
		stdin: { type: "boolean", default: false },
		"lang-dir": { type: "string", multiple: true },
	},
});

if (values.supported) {
	console.log(JSON.stringify(Antlrmap.supported, null, 2));
	process.exit(0);
}

let files = positionals;

if (values.stdin || (!process.stdin.isTTY && positionals.length === 0)) {
	const input = readFileSync(0, "utf-8");
	files = input
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

if (files.length === 0) {
	console.error(
		"Usage: antlrmap [--supported] [--stdin] [--lang-dir <path>] <file1> [file2] ...",
	);
	console.error("       find . -name '*.js' | antlrmap");
	console.error("       antlrmap --lang-dir ./my-lang src/*.xyz");
	process.exit(1);
}

const mapper = new Antlrmap();

// Register custom language directories
// Each dir must contain map.js and generated/ (same structure as built-in languages)
if (values["lang-dir"]) {
	for (const dir of values["lang-dir"]) {
		const resolved = path.resolve(dir);
		const langId = path.basename(resolved);
		const { default: MapClass } = await import(path.join(resolved, "map.js"));
		const extensions = MapClass.extensions ?? [];
		mapper.registerLanguage(langId, { dir: resolved, extensions });
	}
}

const results = await mapper.mapFiles(files);
console.log(JSON.stringify(results, null, 2));
