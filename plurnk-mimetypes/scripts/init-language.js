#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		name: { type: "string", short: "n" },
		"grammar-dir": { type: "string", short: "g" },
		entry: { type: "string", short: "e", default: "program" },
		extensions: { type: "string", short: "x" },
		out: { type: "string", short: "o" },
	},
});

if (!values.name || !values["grammar-dir"] || !values.extensions) {
	console.error(`Usage: node scripts/init-language.js \\
  --name <language-id> \\
  --grammar-dir <path/to/grammar> \\
  --entry <entry-rule> \\
  --extensions '.ext1,.ext2' \\
  [--out <output-dir>]

Example:
  node scripts/init-language.js \\
    --name smalltalk \\
    --grammar-dir vendor/grammars-v4/smalltalk \\
    --entry program \\
    --extensions '.st,.sm'

This creates a ready-to-customize language directory with:
  - Compiled ANTLR4 parser (generated/)
  - Starter map.js with the visitor skeleton
  - map.test.js wired to grammar zoo examples
  - Instructions for writing the symbol mapping`);
	process.exit(1);
}

const name = values.name;
const grammarDir = path.resolve(values["grammar-dir"]);
const entry = values.entry;
const extensions = values.extensions.split(",").map((e) => e.trim());
const outDir = path.resolve(values.out ?? path.join("languages", name));

// Find .g4 files
const allFiles = await fs.readdir(grammarDir);
const g4Files = allFiles.filter((f) => f.endsWith(".g4"));

if (g4Files.length === 0) {
	console.error(`No .g4 files found in ${grammarDir}`);
	process.exit(1);
}

// Find the parser .g4 (the one with "Parser" in the name, or the largest)
const parserG4 =
	g4Files.find((f) => f.includes("Parser")) ?? g4Files[g4Files.length - 1];
const visitorName = parserG4.replace(".g4", "Visitor.js");

console.log(`Language: ${name}`);
console.log(`Grammar:  ${grammarDir}`);
console.log(`G4 files: ${g4Files.join(", ")}`);
console.log(`Entry:    ${entry}`);
console.log(`Exts:     ${extensions.join(", ")}`);
console.log(`Output:   ${outDir}`);
console.log();

// Create directories
const generatedDir = path.join(outDir, "generated");
await fs.mkdir(generatedDir, { recursive: true });

// Compile grammar
console.log("Compiling grammar...");
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const exec = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, "..");
const g4Paths = g4Files.map((f) => path.join(grammarDir, f));

await exec(
	"npx",
	[
		"antlr-ng",
		"-Dlanguage=JavaScript",
		"--generate-visitor",
		"-o",
		generatedDir,
		...g4Paths,
	],
	{ cwd: ROOT },
);

// Clean antlr-ng artifacts
await fs.rm(path.join(ROOT, "stdin.c"), { force: true });
await fs.rm(path.join(ROOT, "stdin.c.p"), { force: true });

// Copy JavaScript base classes if they exist
const jsDir = path.join(grammarDir, "JavaScript");
try {
	const jsFiles = await fs.readdir(jsDir);
	const baseFiles = jsFiles.filter((f) => f.endsWith(".js"));
	for (const file of baseFiles) {
		await fs.copyFile(path.join(jsDir, file), path.join(generatedDir, file));
	}
	if (baseFiles.length > 0) {
		console.log(`Copied base classes: ${baseFiles.join(", ")}`);
	}
} catch {
	console.log(
		"No JavaScript/ base classes found — you may need to port them from Java/TypeScript.",
	);
}

// Read the visitor to find available visit methods
const visitorPath = path.join(generatedDir, visitorName);
let visitorSource;
try {
	visitorSource = await fs.readFile(visitorPath, "utf-8");
} catch {
	console.error(`Could not read visitor at ${visitorPath}`);
	process.exit(1);
}

const visitMethods = [...visitorSource.matchAll(/visit(\w+)\(ctx\)/g)]
	.map((m) => m[1])
	.filter(
		(name) =>
			!["Children", "Terminal", "ErrorNode"].includes(name) &&
			!name.startsWith("_"),
	);

// Generate map.js skeleton
const extArray = extensions.map((e) => `"${e}"`).join(", ");
const mapContent = `import { withExtractor, createMap } from "../../lib/BaseExtractor.js";
import ${parserG4.replace(".g4", "")}Visitor from "./generated/${visitorName}";

// Available visitor methods (from the grammar):
// ${visitMethods.map((m) => `visit${m}`).join("\n// ")}
//
// See SPEC.md for the mapping policy:
// - Include: classes, functions, methods, fields, interfaces, enums, types, modules
// - Exclude: imports, local variables inside function/method bodies
// - Functions and methods must include params
// - Identify the scope boundary rule (e.g., functionBody, block) that separates
//   "visible definitions" from "local implementation"
//
// Inherited from withExtractor():
//   this._add(kind, name, ctx, params) — emit a symbol
//   this._inBody — true when inside a function/method body
//   this._gateBody(ctx) — call from the scope boundary visitor
//   this._endLine(ctx) — override if the grammar needs custom endLine logic

class Extractor extends withExtractor(${parserG4.replace(".g4", "")}Visitor) {
	// TODO: Implement visitors for this language's definitions.
	//
	// 1. Scope boundary — find the rule for function/method body and gate it:
	//    visitFunctionBody(ctx) { return this._gateBody(ctx); }
	//
	// 2. Declarations — override visitors and call this._add():
	//    visitFunctionDeclaration(ctx) {
	//        if (this._inBody) return null;
	//        const id = ctx.identifier();
	//        if (id) this._add("function", id.getText(), ctx, this.#extractParams(...));
	//        return this.visitChildren(ctx);
	//    }
	//
	// 3. Params — add a private #extractParams method for this grammar's param rules
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "${entry}",
	extensions: [${extArray}],
});
`;

await fs.writeFile(path.join(outDir, "map.js"), mapContent);

// Generate map.test.js
const examplesDir = path.join(grammarDir, "examples");
let hasExamples = false;
try {
	await fs.access(examplesDir);
	hasExamples = true;
} catch {}

const relExamples = path.relative(ROOT, examplesDir);
const testContent = hasExamples
	? `import { testLanguage } from "../../lib/testutil.js";

await testLanguage("${name}", {
	examplesDir: "${relExamples}",
	extensions: [${extArray}],
});
`
	: `// No examples/ directory found in the grammar zoo for this language.
// Add test files manually or create an examples/ directory.
`;

await fs.writeFile(path.join(outDir, "map.test.js"), testContent);

// Generate package.json
const pkgContent = JSON.stringify(
	{
		name: `@antlrmap/${name}`,
		version: "0.0.1",
		type: "module",
		private: true,
		files: ["map.js", "generated/"],
		peerDependencies: { antlr4: "*" },
	},
	null,
	2,
);
await fs.writeFile(path.join(outDir, "package.json"), `${pkgContent}\n`);

console.log();
console.log("Created:");
console.log(
	`  ${outDir}/map.js          — symbol mapping (TODO: implement visitors)`,
);
console.log(`  ${outDir}/map.test.js     — grammar zoo tests`);
console.log(`  ${outDir}/generated/      — compiled ANTLR4 parser`);
console.log(`  ${outDir}/package.json`);
console.log();
console.log("Next steps:");
console.log(
	"  1. Open map.js — the available visitor methods are listed at the top",
);
console.log(
	"  2. Implement visitors for declarations (see SPEC.md for the policy)",
);
console.log('  3. Change status from "todo" to "done" when ready');
console.log(
	"  4. Run: node --test " +
		path.relative(ROOT, path.join(outDir, "map.test.js")),
);
console.log();
console.log("To use with the CLI:");
console.log(
	`  antlrmap --lang-dir ${path.relative(ROOT, outDir)} yourfile${extensions[0]}`,
);
console.log();
console.log("To use with the API:");
console.log(`  mapper.registerLanguage("${name}", {`);
console.log(`    dir: "${path.relative(ROOT, outDir)}",`);
console.log(`    extensions: [${extArray}],`);
console.log("  });");
