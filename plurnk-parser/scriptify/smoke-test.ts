// Install the packed parser and contracts candidates into a clean consumer,
// then exercise the entrypoint, CLI and browser-Worker bundle ({§parser-build}).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as SourceParser from "../src/index.ts";

const run = promisify(execFile);
// npm exports its config as npm_config_* into lifecycle children — when this smoke runs
// inside `npm publish --workspaces` (prepublishOnly), the inner npm would inherit
// --workspaces/omit and misread the temp consumer. The consumer gets a CLEAN npm env.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
const parserDir = process.cwd();
const contractsDir = join(parserDir, "..", "plurnk-contracts");
const expectedRootValues = Object.keys(SourceParser).sort();
const tempDir = await mkdtemp(join(tmpdir(), "plurnk-parser-smoke-"));

const cleanup = async (): Promise<void> => {
    await rm(tempDir, { recursive: true, force: true });
};

try {
    const candidates = await Promise.all([contractsDir, parserDir].map(async (cwd) => {
        const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
        const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tempDir], { cwd, env: cleanEnv });
        const tarball = join(tempDir, JSON.parse(stdout)[0].filename);
        process.stdout.write(`[smoke] candidate: ${manifest.name}@${manifest.version}\n`);
        return { name: manifest.name as string, version: manifest.version as string, tarball };
    }));

    process.stdout.write(`[smoke] setting up consumer in ${tempDir}...\n`);
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
        name: "plurnk-parser-smoke-consumer",
        version: "0.0.0",
        type: "module",
        private: true,
    }, null, 2) + "\n");

    process.stdout.write(`[smoke] installing candidate tarballs...\n`);
    await run("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund", ...candidates.map(({ tarball }) => tarball)], { cwd: tempDir, env: cleanEnv });
    for (const { name, version } of candidates) {
        const installed = JSON.parse(await readFile(join(tempDir, "node_modules", name, "package.json"), "utf8"));
        assert.equal(installed.version, version, `installed ${name} must be the packed candidate`);
    }

    const installedRoot = join(tempDir, "node_modules", "@plurnk", "plurnk-parser");
    const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    if (Object.keys(installedPackage.exports).some((entry) => entry.endsWith(".gbnf"))) {
        throw new Error("installed package ships a bundled GBNF profile; grammars are operator files, never package exports");
    }

    await writeFile(join(tempDir, "consume.js"), `
import * as Parser from "@plurnk/plurnk-parser";

const expectedRootValues = ${JSON.stringify(expectedRootValues)};
const rootValues = Object.keys(Parser).sort();
if (JSON.stringify(rootValues) !== JSON.stringify(expectedRootValues)) {
    throw new Error("unexpected package-root values: " + JSON.stringify(rootValues));
}

const { PlurnkParser, parsePath } = Parser;

const assertClean = (label, result) => {
    const errors = result.items.filter(({ kind }) => kind === "error");
    if (errors.length > 0 || result.unparsedTail !== undefined) {
        throw new Error(label + " failed: " + JSON.stringify(result));
    }
};

const program = PlurnkParser.frame("NOTE", "smoke");
assertClean("model turn", PlurnkParser.parse(program));
const result = PlurnkParser.parseStatements(PlurnkParser.frame("EDIT (worker:///foo)", "body content"));
assertClean("statement sequence", result);
assertClean("client tier", PlurnkParser.parseClient(PlurnkParser.frame("LOOK (known://foo)", null)));

const selected = PlurnkParser.parseStatements(PlurnkParser.frame('READ (https://example.com) [{"headers":{"Accept":"text/plain"}}] /needle/', null));
assertClean("owner metadata with matcher", selected);
const selection = selected.items[0]?.statement;
if (selection?.matcher?.raw !== "/needle/" || selection.metadata?.[0] !== '{"headers":{"Accept":"text/plain"}}') {
    throw new Error("owner metadata erased the resource selection: " + JSON.stringify(selection));
}
const reparsedSelection = PlurnkParser.parseStatements(PlurnkParser.stringify([selection]));
assertClean("rendered resource selection", reparsedSelection);
if (JSON.stringify(reparsedSelection.items[0]?.statement) !== JSON.stringify(selection)) {
    throw new Error("rendering erased the resource selection");
}

const interstitial = "Prelude.\\n" + PlurnkParser.frame("SEND", "Only this is a message.")
    + "\\n3\\n" + program + "\\nPostscript.";
for (const parse of [PlurnkParser.parse, PlurnkParser.parseStatements, PlurnkParser.parseClient]) {
    const parsed = parse(interstitial);
    assertClean("interstitial text", parsed);
    const operations = parsed.items.filter(({ kind }) => kind === "statement");
    if (operations.length !== 2 || operations[0]?.statement?.body?.raw !== "Only this is a message."
        || operations[1]?.statement?.op !== "NOTE") throw new Error("outside text changed the parsed program");
    const outside = parsed.items.filter(({ kind }) => kind === "text").map(({ content }) => content);
    const expected = parse === PlurnkParser.parse ? ["Prelude.\\n", "\\n3\\n", "\\nPostscript."] : [];
    if (JSON.stringify(outside) !== JSON.stringify(expected)) throw new Error("outside text did not retain its tier's delivery semantics");
}

// A quoted example rides a numeric delimiter ({§numeric-delimiter}): the SEND's body holds the
// literal heading without executing it, and the disposition still follows.
const literalExample = PlurnkParser.frame("KILL (worker:///notes.md)", null);
const outer = String.fromCharCode(96).repeat(5);
const quoted = outer + "42SEND <!-- literal example -->\\n" + literalExample + "\\n" + outer + "42\\n" + program;
const quotedSend = PlurnkParser.parse(quoted);
assertClean("delimited SEND", quotedSend);
if (quotedSend.items.length !== 2 || quotedSend.items[0]?.statement?.op !== "SEND"
    || quotedSend.items[0]?.statement?.aside !== "literal example"
    || quotedSend.items[0]?.statement?.body?.raw !== literalExample
    || quotedSend.items[1]?.statement?.op !== "NOTE") throw new Error("delimited SEND did not quote its literal example");

const balancedBody = "Literal example:\\n" + literalExample + "\\nThe answer continues here.";
const balanced = PlurnkParser.parse(outer + "SEND\\n" + balancedBody + "\\n" + outer + "\\n" + program);
assertClean("balanced SEND", balanced);
if (balanced.items.length !== 2 || balanced.items[0]?.statement?.op !== "SEND"
    || balanced.items[0]?.statement?.body?.raw !== balancedBody
    || balanced.items[1]?.statement?.op !== "NOTE") throw new Error("balanced nesting truncated the reply or executed its example");

const item = result.items[0];
if (item.kind !== "statement") throw new Error("expected statement, got " + item.kind);
if (item.statement.op !== "EDIT") throw new Error("expected EDIT, got " + item.statement.op);

const dest = parsePath("worker:///archive/draft");
if (dest?.kind !== "url" || dest.scheme !== "worker" || dest.pathname !== "/archive/draft") throw new Error("parsePath export not working: " + JSON.stringify(dest));

console.log("OK: the parser is consumable through one installed entrypoint.");
`);

    process.stdout.write(`[smoke] running consume.js...\n`);
    const { stdout: consumeOut, stderr: consumeErr } = await run("node", ["consume.js"], { cwd: tempDir });
    if (consumeErr) process.stderr.write(consumeErr);
    process.stdout.write(consumeOut);

    process.stdout.write("[smoke] running the CLI against a turn...\n");
    const cli = join(installedRoot, "bin", "plurnk-parser.js");
    // {§operation-fences} — installed ingestion accepts three; canonical output stays four.
    await writeFile(join(tempDir, "turn.plurnk"), "```WAIT\n```\n");
    const { stdout: cliOut } = await run("node", [cli, "turn.plurnk"], { cwd: tempDir });
    const cliResult = JSON.parse(cliOut) as { items: Array<{ kind: string; statement?: { op: string } }> };
    if (cliResult.items.some(({ kind }) => kind === "error")) throw new Error(`CLI reported parse errors: ${cliOut}`);
    assert.deepEqual(cliResult.items.filter(({ kind }) => kind === "statement").map(({ statement }) => statement?.op), ["WAIT"]);

    await writeFile(join(tempDir, "consume-browser.js"), `
import { PlurnkParser } from "@plurnk/plurnk-parser";
export const parse = (input) => PlurnkParser.parse(input);
`);
    const browserBundle = join(tempDir, "consume-browser.bundle.mjs");
    process.stdout.write("[smoke] bundling the installed package for a browser Worker...\n");
    await build({
        absWorkingDir: tempDir,
        entryPoints: ["consume-browser.js"],
        outfile: browserBundle,
        bundle: true,
        format: "esm",
        platform: "browser",
        logLevel: "silent",
    });
    const browserConsumer = await import(`${pathToFileURL(browserBundle).href}?${crypto.randomUUID()}`) as {
        parse(input: string): { items: Array<{ kind: string }> };
    };
    const browserResult = browserConsumer.parse("````NOTE\nbrowser bundle initialized\n````");
    if (browserResult.items.some(({ kind }) => kind === "error")) {
        throw new Error(`browser bundle returned parse errors: ${JSON.stringify(browserResult.items)}`);
    }
    process.stdout.write("[smoke] browser bundle initialized and parsed a turn\n");

    await cleanup();
    process.stdout.write(`[smoke] PASS\n`);
} catch (e) {
    await cleanup();
    const err = e as { message?: string; stdout?: string; stderr?: string };
    process.stderr.write(`[smoke] FAIL: ${err.message ?? e}\n`);
    if (err.stdout) process.stderr.write(`[stdout] ${err.stdout}\n`);
    if (err.stderr) process.stderr.write(`[stderr] ${err.stderr}\n`);
    process.exit(1);
}
