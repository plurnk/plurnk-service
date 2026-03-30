import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const VENDOR = path.join(ROOT, "vendor", "grammars-v4");
const LANGUAGES = path.join(ROOT, "languages");

// Build config for each active language.
// baseFiles: files to copy from the grammar zoo's JavaScript/ target dir.
// portedBases: files we hand-ported (already in languages/<id>/bases/).
// extraG4: additional .g4 files needed (e.g., UnicodeClasses for Kotlin).
// extraSupport: non-base JS files needed from JavaScript/ dir.
const BUILDS = [
	{
		id: "javascript--javascript",
		grammarDir: "javascript/javascript",
		g4: ["JavaScriptLexer.g4", "JavaScriptParser.g4"],
		baseFiles: ["JavaScriptLexerBase.js", "JavaScriptParserBase.js"],
	},
	{
		id: "javascript--typescript",
		grammarDir: "javascript/typescript",
		g4: ["TypeScriptLexer.g4", "TypeScriptParser.g4"],
		portedBases: ["TypeScriptLexerBase.js", "TypeScriptParserBase.js"],
	},
	{
		id: "python--python3",
		grammarDir: "python/python3",
		g4: ["Python3Lexer.g4", "Python3Parser.g4"],
		baseFiles: ["Python3LexerBase.js", "Python3ParserBase.js"],
	},
	{
		id: "rust",
		grammarDir: "rust",
		g4: ["RustLexer.g4", "RustParser.g4"],
		portedBases: ["RustLexerBase.js", "RustParserBase.js"],
	},
	{
		id: "golang",
		grammarDir: "golang",
		g4: ["GoLexer.g4", "GoParser.g4"],
		baseFiles: ["GoParserBase.js"],
	},
	{
		id: "java--java",
		grammarDir: "java/java",
		g4: ["JavaLexer.g4", "JavaParser.g4"],
		portedBases: ["JavaParserBase.js"],
	},
	{
		id: "c",
		grammarDir: "c",
		g4: ["CLexer.g4", "CParser.g4"],
		baseFiles: ["CLexerBase.js", "CParserBase.js"],
		extraSupport: [
			"Symbol.js",
			"SymbolTable.js",
			"TypeClassification.js",
			"ErrorListener.js",
		],
	},
	{
		id: "cpp",
		grammarDir: "cpp",
		g4: ["CPP14Lexer.g4", "CPP14Parser.g4"],
		baseFiles: ["CPP14ParserBase.js"],
	},
	{
		id: "kotlin--kotlin",
		grammarDir: "kotlin/kotlin",
		g4: ["UnicodeClasses.g4", "KotlinLexer.g4", "KotlinParser.g4"],
	},
	{
		id: "php",
		grammarDir: "php",
		g4: ["PhpLexer.g4", "PhpParser.g4"],
		portedBases: ["PhpLexerBase.js"],
	},
	{
		id: "lua",
		grammarDir: "lua",
		g4: ["LuaLexer.g4", "LuaParser.g4"],
		baseFiles: ["LuaLexerBase.js", "LuaParserBase.js"],
	},
	{
		id: "sql--sqlite",
		grammarDir: "sql/sqlite",
		g4: ["SQLiteLexer.g4", "SQLiteParser.g4"],
	},
	{
		id: "dart2",
		grammarDir: "dart2",
		g4: ["Dart2Lexer.g4", "Dart2Parser.g4"],
		baseFiles: ["Dart2LexerBase.js"],
	},
	{
		id: "scala",
		grammarDir: "scala",
		g4: ["Scala.g4"],
	},
	{
		id: "cobol85",
		grammarDir: "cobol85",
		g4: ["Cobol85.g4"],
	},
	{
		id: "clojure",
		grammarDir: "clojure",
		g4: ["Clojure.g4"],
	},
	{
		id: "elixir",
		grammarDir: "elixir",
		g4: ["ElixirLexer.g4", "ElixirParser.g4"],
	},
	{
		id: "zig",
		grammarDir: "zig",
		g4: ["ZigLexer.g4", "ZigParser.g4"],
	},
	{
		id: "r",
		grammarDir: "r",
		g4: ["R.g4"],
	},
	{
		id: "matlab",
		grammarDir: "matlab",
		g4: ["matlab.g4"],
	},
	{
		id: "verilog",
		grammarDir: "verilog/verilog",
		g4: ["VerilogLexer.g4", "VerilogParser.g4"],
	},
	{
		id: "vhdl",
		grammarDir: "vhdl/vhdl",
		g4: ["vhdl.g4"],
	},
	{
		id: "objc",
		grammarDir: "objc",
		g4: ["ObjectiveCLexer.g4", "ObjectiveCParser.g4"],
	},
	{
		id: "terraform",
		grammarDir: "terraform",
		g4: ["terraform.g4"],
	},
	{
		id: "fortran",
		grammarDir: "fortran/fortran90",
		g4: ["Fortran90Lexer.g4", "Fortran90Parser.g4"],
		baseFiles: ["Fortran90LexerBase.js"],
	},
	{
		id: "erlang",
		grammarDir: "erlang",
		g4: ["Erlang.g4"],
	},
	{
		id: "thrift",
		grammarDir: "thrift",
		g4: ["Thrift.g4"],
	},
	{
		id: "graphql",
		grammarDir: "graphql",
		g4: ["GraphQL.g4"],
	},
	{
		id: "pgn",
		grammarDir: "pgn",
		g4: ["PGN.g4"],
	},
	{
		id: "awk",
		grammarDir: "awk",
		g4: ["awk.g4"],
	},
];

async function compileLang(build) {
	const outDir = path.join(LANGUAGES, build.id, "generated");
	const grammarPath = path.join(VENDOR, build.grammarDir);

	await fs.rm(outDir, { recursive: true, force: true });
	await fs.mkdir(outDir, { recursive: true });

	// Compile .g4 files
	const g4Paths = build.g4.map((f) => path.join(grammarPath, f));
	await exec(
		"npx",
		[
			"antlr-ng",
			"-Dlanguage=JavaScript",
			"--generate-visitor",
			"-o",
			outDir,
			...g4Paths,
		],
		{ cwd: ROOT },
	);

	// antlr-ng dumps stdin.c and stdin.c.p in cwd — clean up
	await fs.rm(path.join(ROOT, "stdin.c"), { force: true });
	await fs.rm(path.join(ROOT, "stdin.c.p"), { force: true });

	// Copy base files from grammar zoo's JavaScript/ dir
	if (build.baseFiles) {
		const jsDir = path.join(grammarPath, "JavaScript");
		for (const file of build.baseFiles) {
			await fs.copyFile(path.join(jsDir, file), path.join(outDir, file));
		}
	}

	// Copy hand-ported base files from languages/<id>/bases/
	if (build.portedBases) {
		const basesDir = path.join(LANGUAGES, build.id, "bases");
		for (const file of build.portedBases) {
			await fs.copyFile(path.join(basesDir, file), path.join(outDir, file));
		}
	}

	// Copy extra support files from JavaScript/ dir
	if (build.extraSupport) {
		const jsDir = path.join(grammarPath, "JavaScript");
		for (const file of build.extraSupport) {
			await fs.copyFile(path.join(jsDir, file), path.join(outDir, file));
		}
	}
}

// Allow compiling a single language: node scripts/compile.js rust
const target = process.argv[2];
const builds = target ? BUILDS.filter((b) => b.id === target) : BUILDS;

if (target && builds.length === 0) {
	console.error(`Unknown language: ${target}`);
	process.exit(1);
}

for (const build of builds) {
	process.stdout.write(`Compiling ${build.id}...`);
	try {
		await compileLang(build);
		console.log(" OK");
	} catch (err) {
		console.log(` FAILED: ${err.message}`);
		process.exit(1);
	}
}

console.log(`\nCompiled ${builds.length} language(s).`);
