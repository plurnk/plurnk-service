import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateGrammar } from "../../scriptify/generate-grammar.ts";

const workspace = async (t: { after: (fn: () => Promise<void>) => void }) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-grammar-build-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "generated"));
    await writeFile(join(dir, "generated", "stale.ts"), "export const stale = true;\n");
    return dir;
};

test("#821: a grammar error fails the build and leaves the generated tree untouched", async (t) => {
    const dir = await workspace(t);
    await writeFile(join(dir, "brokenLexer.g4"), "lexer grammar brokenLexer;\nA : 'a' ;\nB : 'b'\nC : 'c' ;\n");
    await assert.rejects(
        generateGrammar({ grammars: ["brokenLexer.g4"], outDir: "generated", cwd: dir }),
        (error: Error) => /antlr-ng reported 1 error\(s\) \(exit 0\); generated is unchanged:\nerror\(21\): brokenLexer\.g4:4:2/u.test(error.message),
        "the failure names antlr's own diagnostic and the tree it declined to replace",
    );
    assert.deepEqual(await readdir(join(dir, "generated")), ["stale.ts"], "nothing was written beside or over the previous tree");
    assert.deepEqual((await readdir(dir)).filter((entry) => entry.startsWith(".generated-")), [], "no staging directory survives a failure");
});

test("#821: a clean grammar replaces the generated tree whole, with source-tree imports", async (t) => {
    const dir = await workspace(t);
    await writeFile(join(dir, "goodLexer.g4"), "lexer grammar goodLexer;\nA : 'a' ;\n");
    await writeFile(join(dir, "goodParser.g4"), "parser grammar goodParser;\noptions { tokenVocab = goodLexer; }\ndocument : A EOF ;\n");
    await generateGrammar({ grammars: ["goodLexer.g4", "goodParser.g4"], outDir: "generated", cwd: dir });
    const files = await readdir(join(dir, "generated"));
    assert.ok(files.includes("goodLexer.ts") && files.includes("goodParser.ts") && files.includes("goodParserVisitor.ts"), `generated: ${files.join(", ")}`);
    assert.equal(files.includes("stale.ts"), false, "the previous tree is gone, not merged");
    const parser = await readFile(join(dir, "generated", "goodParser.ts"), "utf8");
    assert.match(parser, /from "\.\/goodParserVisitor\.ts"/u, "generated modules import each other as .ts");
    assert.doesNotMatch(parser, /from "\.\/[^"]+\.js"/u);
});
