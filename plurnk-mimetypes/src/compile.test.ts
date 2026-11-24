import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as MimetypesPackage from "./index.ts";

test("{§mimetype-handler-contract} package root exports the orchestrator, handler bases, query primitives, and runCompile", () => {
    assert.equal(typeof MimetypesPackage.Mimetypes, "function");
    assert.equal(typeof MimetypesPackage.BaseHandler, "function");
    assert.equal(MimetypesPackage.default, MimetypesPackage.BaseHandler);
    assert.equal(typeof MimetypesPackage.AntlrExtractor, "function");
    assert.equal(typeof MimetypesPackage.TreeSitterExtractor, "function");
    assert.equal(typeof MimetypesPackage.runCompile, "function");
    assert.equal(typeof MimetypesPackage.classifyMimetype, "function");
});

test("{§treesitter-runtime-gate} runCompile validates grammar directories, surfaces antlr-ng spawn errors, and rewrites generated TypeScript", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mimetypes-compile-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    // 1. Missing grammar directory
    await assert.rejects(
        () => MimetypesPackage.runCompile({ cwd: root, grammarDir: "missing" }),
        /Cannot read grammar directory/u,
    );

    // 2. Empty grammar directory
    const emptyGrammar = join(root, "empty-grammar");
    await mkdir(emptyGrammar, { recursive: true });
    await writeFile(join(emptyGrammar, "README.txt"), "not a grammar");
    await assert.rejects(
        () => MimetypesPackage.runCompile({ cwd: root, grammarDir: "empty-grammar" }),
        /No \.g4 files found/u,
    );

    // 3. Missing antlr-ng on PATH -> actionable ENOENT guidance
    const grammarDir = join(root, "grammar");
    await mkdir(grammarDir, { recursive: true });
    await writeFile(join(grammarDir, "Sample.g4"), "grammar Sample; root: EOF;\n");
    const prevPath = process.env.PATH;
    t.after(() => {
        process.env.PATH = prevPath;
    });
    process.env.PATH = join(root, "empty-bin");
    await assert.rejects(
        () => MimetypesPackage.runCompile({ cwd: root }),
        /antlr-ng not found on PATH/u,
    );

    // 4. Non-zero exit from antlr-ng
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeBin = join(binDir, "antlr-ng");
    await writeFile(fakeBin, "#!/bin/sh\nexit 2\n");
    await chmod(fakeBin, 0o755);
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;
    await assert.rejects(
        () => MimetypesPackage.runCompile({ cwd: root }),
        /antlr-ng exited with code 2/u,
    );

    // 5. Successful compile rewrites relative .js imports and injects missing *Base imports recursively
    const script = [
        "#!/bin/sh",
        'out=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi',
        "done",
        'mkdir -p "$out/sub"',
        'cat <<\'EOF\' > "$out/SampleParser.ts"',
        'import { Parser } from "antlr4ng";',
        'import { Helper } from "./Helper.js";',
        "",
        "export class SampleParser extends SampleParserBase {}",
        "EOF",
        'cat <<\'EOF\' > "$out/SampleLexer.ts"',
        "export class SampleLexer extends SampleLexerBase {}",
        "EOF",
        'cat <<\'EOF\' > "$out/sub/AlreadyImported.ts"',
        'import AlreadyBase from "./AlreadyBase.ts";',
        'import { Sub } from "../Helper.js";',
        "export class AlreadyImported extends AlreadyBase {}",
        "EOF",
        "",
    ].join("\n");
    await writeFile(fakeBin, script);
    await chmod(fakeBin, 0o755);

    await MimetypesPackage.runCompile({ cwd: root });

    const parserSource = await readFile(join(root, "src/generated/SampleParser.ts"), "utf8");
    assert.match(parserSource, /from "\.\/Helper\.ts";/u);
    assert.match(parserSource, /import SampleParserBase from "\.\/SampleParserBase\.ts";/u);

    const lexerSource = await readFile(join(root, "src/generated/SampleLexer.ts"), "utf8");
    assert.match(lexerSource, /^import SampleLexerBase from "\.\/SampleLexerBase\.ts";\nexport class SampleLexer/u);

    const nestedSource = await readFile(join(root, "src/generated/sub/AlreadyImported.ts"), "utf8");
    assert.match(nestedSource, /from "\.\.\/Helper\.ts";/u);
    assert.equal(nestedSource.match(/import AlreadyBase/gu)?.length, 1);
});
