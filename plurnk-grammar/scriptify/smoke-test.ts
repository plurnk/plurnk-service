// Smoke test: pack the grammar package, install the tarball into a temp
// sibling dir, and verify a real `import { PlurnkParser, Validator }` works
// at runtime. Catches issues like #4 (npm-installed package failing because
// of Node 25's node_modules type-stripping restriction).
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(exec);
const grammarDir = process.cwd();
const tempDir = await mkdtemp(join(tmpdir(), "plurnk-smoke-"));
let tarballPath: string | undefined;

const cleanup = async (): Promise<void> => {
    if (tarballPath) await rm(tarballPath, { force: true });
    await rm(tempDir, { recursive: true, force: true });
};

try {
    process.stdout.write(`[smoke] packing tarball in ${grammarDir}...\n`);
    const { stdout: packOut } = await run("npm pack --json --silent", { cwd: grammarDir });
    const tarballName = JSON.parse(packOut)[0].filename;
    tarballPath = join(grammarDir, tarballName);
    process.stdout.write(`[smoke] tarball: ${tarballName}\n`);

    process.stdout.write(`[smoke] setting up consumer in ${tempDir}...\n`);
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
        name: "plurnk-smoke-consumer",
        version: "0.0.0",
        type: "module",
        private: true,
    }, null, 2) + "\n");

    process.stdout.write(`[smoke] installing tarball...\n`);
    await run(`npm install --no-package-lock --no-audit --no-fund --silent ${tarballPath}`, { cwd: tempDir });

    // Stale-artifact guard: the shipped dist/schema must mirror source schema/
    // exactly — a deleted schema surviving in dist (issue #27) fails here.
    const sourceSchemas = (await readdir(join(grammarDir, "schema"))).sort();
    const shippedSchemas = (await readdir(join(tempDir, "node_modules", "@plurnk", "plurnk-grammar", "dist", "schema"))).sort();
    if (JSON.stringify(sourceSchemas) !== JSON.stringify(shippedSchemas)) {
        throw new Error(`dist/schema diverges from schema/: shipped [${shippedSchemas}] vs source [${sourceSchemas}]`);
    }
    process.stdout.write(`[smoke] dist/schema mirrors schema/ (${sourceSchemas.length} files)\n`);

    const installedRoot = join(tempDir, "node_modules", "@plurnk", "plurnk-grammar");
    const shippedGbnf = await readFile(join(installedRoot, "dist", "plurnk.gbnf"), "utf8");
    const localGbnf = await readFile(join(grammarDir, "dist", "plurnk.gbnf"), "utf8");
    if (shippedGbnf !== localGbnf) throw new Error("shipped dist/plurnk.gbnf diverges from the local build");
    process.stdout.write(`[smoke] dist/plurnk.gbnf shipped intact (${shippedGbnf.length} bytes)\n`);

    await writeFile(join(tempDir, "consume.js"), `
import { PlurnkParser, Validator, PlurnkParseError } from "@plurnk/plurnk-grammar";

// 1. Parse a simple plurnk statement.
const result = PlurnkParser.parse("<<EDIT(known://foo):body content:EDIT");
const item = result.items[0];
if (item.kind !== "statement") throw new Error("expected statement, got " + item.kind);
if (item.statement.op !== "EDIT") throw new Error("expected EDIT, got " + item.statement.op);

// 2. Validator round-trip (exercises JSON schema imports).
const pos = item.statement.position;
const posResult = Validator.validatePosition(pos);
if (!posResult.valid) throw new Error("position validation failed: " + JSON.stringify(posResult.errors));

// 3. Confirm an error class is importable as a value.
if (typeof PlurnkParseError !== "function") throw new Error("PlurnkParseError is not a class");

console.log("OK: parser, validator, and error class all consumable from npm-installed package.");
`);

    process.stdout.write(`[smoke] running consume.js...\n`);
    const { stdout: consumeOut, stderr: consumeErr } = await run("node consume.js", { cwd: tempDir });
    if (consumeErr) process.stderr.write(consumeErr);
    process.stdout.write(consumeOut);

    await cleanup();
    process.stdout.write(`[smoke] PASS\n`);
} catch (e: any) {
    await cleanup();
    process.stderr.write(`[smoke] FAIL: ${e?.message ?? e}\n`);
    if (e?.stdout) process.stderr.write(`[stdout] ${e.stdout}\n`);
    if (e?.stderr) process.stderr.write(`[stderr] ${e.stderr}\n`);
    process.exit(1);
}
