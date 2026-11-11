// Install the packed parser and contracts candidates into a clean consumer,
// then exercise the entrypoint, CLI and browser-Session bundle ({§parser-build}).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as SourceParser from "../src/index.ts";
import { isRecord } from "@plurnk/plurnk-contracts";

const run = promisify(execFile);
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
const parserDir = process.cwd();
const contractsDir = join(parserDir, "..", "plurnk-contracts");
const expectedRootValues = Object.keys(SourceParser).toSorted();
const tempDir = await mkdtemp(join(tmpdir(), "plurnk-parser-smoke-"));

const cleanup = async (): Promise<void> => {
    await rm(tempDir, { recursive: true, force: true });
};

const parseItems = (result: unknown, source: string): readonly unknown[] => {
    if (!isRecord(result) || !Array.isArray(result.items)) throw new Error(`${source} returned no parse items: ${JSON.stringify(result)}`);
    return result.items;
};
const isParseError = (item: unknown): boolean => isRecord(item) && item.kind === "error";

try {
    const candidates = await Promise.all([contractsDir, parserDir].map(async (cwd) => {
        const manifest: unknown = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
        if (!isRecord(manifest) || typeof manifest.name !== "string" || typeof manifest.version !== "string") {
            throw new Error(`${cwd}/package.json names no package and version`);
        }
        const { stdout } = await run("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", tempDir], { cwd, env: cleanEnv });
        const tarballName = stdout.trim().split("\n").at(-1) ?? "";
        if (!tarballName.endsWith(".tgz")) throw new Error(`npm pack printed no archive name: ${JSON.stringify(stdout)}`);
        const tarball = join(tempDir, tarballName);
        process.stdout.write(`[smoke] candidate: ${manifest.name}@${manifest.version}\n`);
        return { name: manifest.name, version: manifest.version, tarball };
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

const program = 'plurnk.note({"text":"smoke"});';
assertClean("model turn", PlurnkParser.parse(program));
const result = PlurnkParser.parseStatements('plurnk.edit({"path":"workspace:///foo","content":"body content"});');
assertClean("statement sequence", result);

const selected = PlurnkParser.parseStatements('plurnk.read({"path":"https://example.com","pattern":"/needle/","headers":{"Accept":"text/plain"}});');
assertClean("owner headers with matcher", selected);
const selection = selected.items[0]?.statement;
if (selection?.matcher?.raw !== "/needle/" || selection.headers?.Accept !== "text/plain") {
    throw new Error("owner headers erased the resource selection: " + JSON.stringify(selection));
}
const reparsedSelection = PlurnkParser.parseStatements(PlurnkParser.stringify([selection]));
assertClean("rendered resource selection", reparsedSelection);
if (JSON.stringify(reparsedSelection.items[0]?.statement) !== JSON.stringify(selection)) {
    throw new Error("rendering erased the resource selection");
}

const dest = parsePath("workspace:///archive/draft");
if (dest?.kind !== "url" || dest.scheme !== "workspace" || dest.pathname !== "/archive/draft") throw new Error("parsePath export not working: " + JSON.stringify(dest));

console.log("OK: the parser is consumable through one installed entrypoint.");
`);

    process.stdout.write(`[smoke] running consume.js...\n`);
    const { stdout: consumeOut, stderr: consumeErr } = await run("node", ["consume.js"], { cwd: tempDir });
    if (consumeErr) process.stderr.write(consumeErr);
    process.stdout.write(consumeOut);

    process.stdout.write("[smoke] running the CLI against a turn...\n");
    const cli = join(installedRoot, "bin", "plurnk-parser.js");
    await writeFile(join(tempDir, "turn.plurnk"), 'plurnk.wait({});\n');
    const { stdout: cliOut } = await run("node", [cli, "turn.plurnk"], { cwd: tempDir });
    if (parseItems(JSON.parse(cliOut), "the CLI").some(isParseError)) throw new Error(`CLI reported parse errors: ${cliOut}`);

    await writeFile(join(tempDir, "consume-browser.js"), `
import { PlurnkParser } from "@plurnk/plurnk-parser";
export const parse = (input) => PlurnkParser.parse(input);
`);
    const browserBundle = join(tempDir, "consume-browser.bundle.mjs");
    process.stdout.write("[smoke] bundling the installed package for a browser Session...\n");
    await build({
        absWorkingDir: tempDir,
        entryPoints: ["consume-browser.js"],
        outfile: browserBundle,
        bundle: true,
        format: "esm",
        platform: "browser",
        logLevel: "silent",
    });
    const browserConsumer: unknown = await import(`${pathToFileURL(browserBundle).href}?${crypto.randomUUID()}`);
    if (!isRecord(browserConsumer) || typeof browserConsumer.parse !== "function") throw new Error("the browser bundle exports no parse");
    const browserItems = parseItems(Reflect.apply(browserConsumer.parse, undefined, ['plurnk.note({"text":"browser bundle initialized"});']), "the browser bundle");
    if (browserItems.some(isParseError)) {
        throw new Error(`browser bundle returned parse errors: ${JSON.stringify(browserItems)}`);
    }
    process.stdout.write("[smoke] browser bundle initialized and parsed a turn\n");

    await cleanup();
    process.stdout.write(`[smoke] PASS\n`);
} catch (e) {
    await cleanup();
    const failure: Readonly<Record<string, unknown>> = isRecord(e) ? e : {};
    process.stderr.write(`[smoke] FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
    if (typeof failure.stdout === "string" && failure.stdout !== "") process.stderr.write(`[stdout] ${failure.stdout}\n`);
    if (typeof failure.stderr === "string" && failure.stderr !== "") process.stderr.write(`[stderr] ${failure.stderr}\n`);
    process.exit(1);
}
