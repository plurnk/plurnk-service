// Pack the complete contracts package, install it into a clean consumer, and
// exercise both the lightweight wire-contract root and the grammar subpath.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const run = promisify(execFile);
// npm exports its config as npm_config_* into lifecycle children — when this smoke runs
// inside `npm publish --workspaces` (prepublishOnly), the inner npm would inherit
// --workspaces/omit and misread the temp consumer. The consumer gets a CLEAN npm env.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
const contractsDir = process.cwd();
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
    for (const gbnf of ["plurnk.gbnf"]) {
        const shipped = await readFile(join(installedRoot, "dist", gbnf), "utf8");
        const local = await readFile(join(contractsDir, "dist", gbnf), "utf8");
        if (shipped !== local) throw new Error(`shipped dist/${gbnf} diverges from the local build`);
        process.stdout.write(`[smoke] dist/${gbnf} shipped intact (${shipped.length} bytes)\n`);
    }

    await writeFile(join(tempDir, "consume.js"), `
import { Problems, Validator as ContractValidator } from "@plurnk/plurnk-contracts";
import { PlurnkParser, Validator as GrammarValidator, PlurnkParseError, parsePath } from "@plurnk/plurnk-contracts/grammar";

// 1. Parse a simple plurnk statement.
const result = PlurnkParser.parseStatements("<<EDIT(worker:///foo):body content:EDIT");
const item = result.items[0];
if (item.kind !== "statement") throw new Error("expected statement, got " + item.kind);
if (item.statement.op !== "EDIT") throw new Error("expected EDIT, got " + item.statement.op);

// 2. Validator round-trip (exercises JSON schema imports).
const pos = item.statement.position;
const posResult = GrammarValidator.validatePosition(pos);
if (!posResult.valid) throw new Error("position validation failed: " + JSON.stringify(posResult.errors));

// 3. Validate the runtime-neutral result contract through the package root.
const problem = Problems.create("smoke", "missing", 404, "Missing.");
ContractValidator.assertOperationResult({ status: 404, problem });

// 4. Confirm an error class is importable as a value.
if (typeof PlurnkParseError !== "function") throw new Error("PlurnkParseError is not a class");

// 5. Confirm the parsePath helper is a callable grammar export.
const dest = parsePath("worker:///archive/draft");
if (dest?.kind !== "url" || dest.scheme !== "worker" || dest.pathname !== "/archive/draft") throw new Error("parsePath export not working: " + JSON.stringify(dest));

console.log("OK: wire contracts and grammar are consumable through their installed entrypoints.");
`);

    process.stdout.write(`[smoke] running consume.js...\n`);
    const { stdout: consumeOut, stderr: consumeErr } = await run("node", ["consume.js"], { cwd: tempDir });
    if (consumeErr) process.stderr.write(consumeErr);
    process.stdout.write(consumeOut);

    await writeFile(join(tempDir, "consume-contracts-browser.js"), `
import { Problems } from "@plurnk/plurnk-contracts";
export const makeProblem = () => Problems.create("smoke", "missing", 404, "Missing.");
`);
    const contractsBundle = join(tempDir, "consume-contracts-browser.bundle.mjs");
    const contractsBuild = await build({
        absWorkingDir: tempDir,
        entryPoints: ["consume-contracts-browser.js"],
        outfile: contractsBundle,
        bundle: true,
        format: "esm",
        platform: "browser",
        logLevel: "silent",
        metafile: true,
    });
    const grammarRuntimeInput = Object.keys(contractsBuild.metafile.inputs).find((input) =>
        input.includes("antlr4ng") || input.includes("PlurnkParser"),
    );
    if (grammarRuntimeInput !== undefined) {
        throw new Error(`wire-contract root loaded grammar runtime: ${grammarRuntimeInput}`);
    }
    process.stdout.write("[smoke] root entrypoint excludes the grammar runtime\n");

    await writeFile(join(tempDir, "consume-browser.js"), `
import { PlurnkParser } from "@plurnk/plurnk-contracts/grammar";
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
