// Pack the parser package, install it into a clean consumer beside its published
// dependency, and exercise its entrypoint and a browser-Worker bundle ({§parser-build}).
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
const expectedRootValues = Object.keys(SourceParser).sort();
const tempDir = await mkdtemp(join(tmpdir(), "plurnk-parser-smoke-"));
let tarballPath: string | undefined;

const cleanup = async (): Promise<void> => {
    if (tarballPath) await rm(tarballPath, { force: true });
    await rm(tempDir, { recursive: true, force: true });
};

try {
    process.stdout.write(`[smoke] packing tarball in ${parserDir}...\n`);
    const { stdout: packOut } = await run("npm", ["pack", "--json", "--silent", "--ignore-scripts"], { cwd: parserDir, env: cleanEnv });
    const tarballName = JSON.parse(packOut)[0].filename;
    tarballPath = join(parserDir, tarballName);
    process.stdout.write(`[smoke] tarball: ${tarballName}\n`);

    process.stdout.write(`[smoke] setting up consumer in ${tempDir}...\n`);
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
        name: "plurnk-parser-smoke-consumer",
        version: "0.0.0",
        type: "module",
        private: true,
    }, null, 2) + "\n");

    process.stdout.write(`[smoke] installing tarball...\n`);
    await run("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund", "--silent", tarballPath], { cwd: tempDir, env: cleanEnv });

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

const program = PlurnkParser.frame("TASK", '[{"content":"smoke","status":"in_progress"}]');
assertClean("model turn", PlurnkParser.parse(program));
const result = PlurnkParser.parseStatements(PlurnkParser.frame("EDIT (worker:///foo)", "body content"));
assertClean("statement sequence", result);
assertClean("turn log", PlurnkParser.parseLog(program));
assertClean("client tier", PlurnkParser.parseClient(PlurnkParser.frame("LOOK (known://foo)", null)));

const interstitial = "Prelude.\\n" + PlurnkParser.frame("SEND", "Only this is a message.")
    + "\\n3\\n" + program + "\\nPostscript.";
for (const parse of [PlurnkParser.parse, PlurnkParser.parseStatements, PlurnkParser.parseLog, PlurnkParser.parseClient]) {
    const parsed = parse(interstitial);
    assertClean("interstitial text", parsed);
    if (parsed.items.length !== 2 || parsed.items[0]?.statement?.body?.raw !== "Only this is a message."
        || parsed.items[1]?.statement?.op !== "TASK") throw new Error("outside text changed the parsed program");
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
    || quotedSend.items[1]?.statement?.op !== "TASK") throw new Error("delimited SEND did not quote its literal example");

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
    await writeFile(join(tempDir, "turn.plurnk"), "```TASK\n[{\"content\":\"cli\",\"status\":\"completed\"}]\n```\n");
    const { stdout: cliOut } = await run("node", [cli, "turn.plurnk"], { cwd: tempDir });
    const cliResult = JSON.parse(cliOut) as { items: Array<{ kind: string }> };
    if (cliResult.items.some(({ kind }) => kind === "error")) throw new Error(`CLI reported parse errors: ${cliOut}`);

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
    const browserResult = browserConsumer.parse("```TASK\n[{\"content\":\"browser bundle initialized\",\"status\":\"in_progress\"}]\n```");
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
