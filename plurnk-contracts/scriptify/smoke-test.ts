// Pack the complete contracts package, install it into a clean consumer, and
// exercise its singular code entrypoint.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as SourceContracts from "../src/index.ts";

const run = promisify(execFile);
// npm exports its config as npm_config_* into lifecycle children — when this smoke runs
// inside `npm publish --workspaces` (prepublishOnly), the inner npm would inherit
// --workspaces/omit and misread the temp consumer. The consumer gets a CLEAN npm env.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
const contractsDir = process.cwd();
const expectedRootValues = Object.keys(SourceContracts).sort();
const tempDir = await mkdtemp(join(tmpdir(), "plurnk-smoke-"));
let tarballPath: string | undefined;

const cleanup = async (): Promise<void> => {
    if (tarballPath) await rm(tarballPath, { force: true });
    await rm(tempDir, { recursive: true, force: true });
};

try {
    process.stdout.write(`[smoke] packing tarball in ${contractsDir}...\n`);
    // The caller built the candidate before smoke. Re-running prepack here would
    // rebuild the same artifact inside its own verification and used to compound
    // the generator's lifecycle cost.
    const { stdout: packOut } = await run("npm", ["pack", "--json", "--silent", "--ignore-scripts"], { cwd: contractsDir, env: cleanEnv });
    const tarballName = JSON.parse(packOut)[0].filename;
    tarballPath = join(contractsDir, tarballName);
    process.stdout.write(`[smoke] tarball: ${tarballName}\n`);

    process.stdout.write(`[smoke] setting up consumer in ${tempDir}...\n`);
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
        name: "plurnk-smoke-consumer",
        version: "0.0.0",
        type: "module",
        private: true,
    }, null, 2) + "\n");

    process.stdout.write(`[smoke] installing tarball...\n`);
    await run("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund", "--silent", tarballPath], { cwd: tempDir, env: cleanEnv });

    // Stale-artifact guard: the shipped dist/schema must mirror source schema/
    // exactly — a deleted schema surviving in dist (issue #27) fails here.
    const sourceSchemas = (await readdir(join(contractsDir, "schema"))).sort();
    const shippedSchemas = (await readdir(join(tempDir, "node_modules", "@plurnk", "plurnk-contracts", "dist", "schema"))).sort();
    if (JSON.stringify(sourceSchemas) !== JSON.stringify(shippedSchemas)) {
        throw new Error(`dist/schema diverges from schema/: shipped [${shippedSchemas}] vs source [${sourceSchemas}]`);
    }
    process.stdout.write(`[smoke] dist/schema mirrors schema/ (${sourceSchemas.length} files)\n`);

    const installedRoot = join(tempDir, "node_modules", "@plurnk", "plurnk-contracts");
    const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    if (Object.hasOwn(installedPackage.exports, "./grammar")) {
        throw new Error("installed package retains a second grammar code entrypoint");
    }
    for (const gbnf of ["plurnk.gbnf"]) {
        const shipped = await readFile(join(installedRoot, "dist", gbnf), "utf8");
        const local = await readFile(join(contractsDir, "dist", gbnf), "utf8");
        if (shipped !== local) throw new Error(`shipped dist/${gbnf} diverges from the local build`);
        process.stdout.write(`[smoke] dist/${gbnf} shipped intact (${shipped.length} bytes)\n`);
    }

    await writeFile(join(tempDir, "consume.js"), `
import * as Contracts from "@plurnk/plurnk-contracts";

const expectedRootValues = ${JSON.stringify(expectedRootValues)};
const rootValues = Object.keys(Contracts).sort();
if (JSON.stringify(rootValues) !== JSON.stringify(expectedRootValues)) {
    throw new Error("unexpected package-root values: " + JSON.stringify(rootValues));
}

const {
    InvalidOperationResultError,
    PathSyntax,
    PlurnkParseError,
    PlurnkParser,
    PLURNK_OPS,
    Problems,
    RESERVED_AUTHORITIES,
    UNKNOWN_POSITION,
    Validator,
    WORKER_NAME,
    parsePath,
    parseResourceSelection,
} = Contracts;

const assertClean = (label, result) => {
    const errors = result.items.filter(({ kind }) => kind === "error");
    if (errors.length > 0 || result.unparsedTail !== undefined) {
        throw new Error(label + " failed: " + JSON.stringify(result));
    }
};

assertClean("model turn", PlurnkParser.parse("<<PLAN:smoke:PLAN\\n<<SEND[200]:done:SEND"));
const result = PlurnkParser.parseStatements("<<EDIT(worker:///foo):body content:EDIT");
assertClean("statement sequence", result);
assertClean("wrapped log", PlurnkParser.parseLog("<<TURN:<<PLAN:smoke:PLAN\\n<<SEND[200]:done:SEND:TURN"));
assertClean("client tier", PlurnkParser.parseClient("<<LOOK(known://foo)::LOOK"));

// Parse a simple statement and validate its schema-derived position.
const item = result.items[0];
if (item.kind !== "statement") throw new Error("expected statement, got " + item.kind);
if (item.statement.op !== "EDIT") throw new Error("expected EDIT, got " + item.statement.op);
const pos = item.statement.position;
const posResult = Validator.validatePosition(pos);
if (!posResult.valid) throw new Error("position validation failed: " + JSON.stringify(posResult.errors));

const problem = Problems.create("smoke", "missing", 404, "Missing.");
Validator.assertOperationResult({ status: 404, problem });
try {
    Validator.assertOperationResult({ status: 400 });
    throw new Error("invalid operation result was accepted");
} catch (error) {
    if (!(error instanceof InvalidOperationResultError)) throw error;
}

if (typeof PlurnkParseError !== "function") throw new Error("PlurnkParseError is not a class");

const dest = parsePath("worker:///archive/draft");
if (dest?.kind !== "url" || dest.scheme !== "worker" || dest.pathname !== "/archive/draft") throw new Error("parsePath export not working: " + JSON.stringify(dest));
const selection = parseResourceSelection("worker:///archive/draft<12,5,12,5>");
if (selection?.target.kind !== "url" || JSON.stringify(selection.lineMarker?.marks) !== "[12,5,12,5]") {
    throw new Error("parseResourceSelection export not working: " + JSON.stringify(selection));
}
if (PathSyntax.encodeParens("/draft(1)") !== "/draft%281%29") throw new Error("PathSyntax encode failed");
if (PathSyntax.decodeParens("/draft%281%29") !== "/draft(1)") throw new Error("PathSyntax decode failed");
if (!PLURNK_OPS.includes("PLAN") || !WORKER_NAME.test("worker-1") || RESERVED_AUTHORITIES.join(",") !== "commons,plurnk") {
    throw new Error("contracts constants are not usable");
}
if (UNKNOWN_POSITION.line !== 0 || UNKNOWN_POSITION.column !== 0 || !Object.isFrozen(UNKNOWN_POSITION)) {
    throw new Error("unknown position sentinel is not intact");
}

console.log("OK: wire contracts and grammar are consumable through one installed entrypoint.");
`);

    process.stdout.write(`[smoke] running consume.js...\n`);
    const { stdout: consumeOut, stderr: consumeErr } = await run("node", ["consume.js"], { cwd: tempDir });
    if (consumeErr) process.stderr.write(consumeErr);
    process.stdout.write(consumeOut);

    await writeFile(join(tempDir, "consume-browser.js"), `
import { PlurnkParser } from "@plurnk/plurnk-contracts";
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
    const browserResult = browserConsumer.parse("<<PLAN:browser bundle initialized:PLAN\n<<SEND[200]:browser-safe:SEND");
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
