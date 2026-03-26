#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Antlrmap from "./antlrmap.js";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		supported: { type: "boolean", default: false },
		stdin: { type: "boolean", default: false },
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
	console.error("Usage: antlrmap [--supported] [--stdin] <file1> [file2] ...");
	console.error("       find . -name '*.js' | antlrmap");
	process.exit(1);
}

const mapper = new Antlrmap();
const results = await mapper.mapFiles(files);
console.log(JSON.stringify(results, null, 2));
