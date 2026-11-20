// {§acp-first-party-client-conformance} — pack the platform and terminal
// client into a candidate archive directory, then run plurnk-web's hermetic
// candidate gate (clean clone, lint, browser suites, and packed daemon installation).
import { execFile, spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isProviderCredentialName } from "@plurnk/plurnk-models";
import { packRecords } from "./lib/npm-json.mjs";
import { projectTarball } from "./lib/package-projection.mjs";
import { resolveClientCheckout, resolveWebCheckout } from "./lib/project-topology.mjs";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: npm run test:web-conformance
Packs the platform and the terminal client into a candidate archive directory and runs plurnk-web's test:candidate gate ({§acp-first-party-client-conformance}).
Reads: PLURNK_WEB_CHECKOUT (default ../plurnk-web), PLURNK_CLIENT_CHECKOUT (default ../plurnk), and this checkout's built packages, packed as they stand: run npm run build first (the drill builds once, before its phases).
Writes: ephemeral archives under the system tmpdir; exit 1 on a failed check.
`);

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const webRoot = resolveWebCheckout(process.env, process.cwd(), resolve(root, "../plurnk-web"));
const terminalRoot = resolveClientCheckout(process.env, process.cwd(), resolve(root, "../plurnk"));

try {
    await access(join(webRoot, "package.json"));
} catch (cause) {
    throw new Error(
        `web conformance needs a plurnk-web checkout: ${webRoot}. Clone ../plurnk-web, or set PLURNK_WEB_CHECKOUT to another checkout.`,
        { cause },
    );
}
try {
    await access(join(terminalRoot, "package.json"));
} catch (cause) {
    throw new Error(
        `web conformance needs an installed terminal client checkout: ${terminalRoot}. Run npm ci there, or set PLURNK_CLIENT_CHECKOUT to another installed checkout.`,
        { cause },
    );
}

process.stdout.write(`web conformance: ${webRoot}\n`);

const STALE_EVIDENCE_MS = 60 * 60 * 1000;
for (const entry of await readdir(tmpdir())) {
    if (!entry.startsWith("plurnk-web-conformance-")) continue;
    const preserved = join(tmpdir(), entry);
    if (Date.now() - (await stat(preserved)).mtimeMs < STALE_EVIDENCE_MS) continue;
    await rm(preserved, { recursive: true, force: true });
    process.stderr.write(`web conformance reaped stale evidence at ${preserved}\n`);
}

const temp = await mkdtemp(join(tmpdir(), "plurnk-web-conformance-"));
const archivesDir = join(temp, "archives");
const terminalStage = join(temp, "terminal");

const pack = async (cwd, args = []) => {
    const packed = packRecords((await run("npm", [
        "pack", ...args, "--ignore-scripts", "--json", "--pack-destination", archivesDir,
    ], { cwd, maxBuffer: 128 * 1024 * 1024 })).stdout);
    return packed.map(({ filename }) => join(archivesDir, filename));
};

const runCandidate = (cwd, candidateDir, env) => new Promise((accept, reject) => {
    const child = spawn("npm", ["run", "test:candidate", "--", candidateDir], {
        cwd,
        env,
        stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
        if (code === 0) accept(undefined);
        else reject(new Error(`plurnk-web test:candidate exited ${code ?? signal}`));
    });
});

let passed = false;
try {
    await Promise.all([
        mkdir(archivesDir, { recursive: true }),
        mkdir(terminalStage, { recursive: true }),
    ]);
    const serviceSpecs = await pack(root, ["--workspaces"]);
    for (const archive of serviceSpecs) await projectTarball(archive);
    const contractsSpec = serviceSpecs.find((spec) => spec.includes("plurnk-plurnk-contracts-"));
    if (contractsSpec === undefined) throw new Error("packed platform omitted @plurnk/plurnk-contracts");

    await cp(terminalRoot, terminalStage, {
        recursive: true,
        filter: (source) => {
            const [top] = relative(terminalRoot, source).split(sep);
            return !["node_modules", "dist"].includes(top);
        },
    });
    await run("npm", [
        "install", "--ignore-scripts", "--no-audit", "--no-fund",
        "--package-lock=false", "--no-save", contractsSpec,
    ], { cwd: terminalStage, maxBuffer: 64 * 1024 * 1024 });
    await run("npm", ["run", "build"], { cwd: terminalStage, maxBuffer: 64 * 1024 * 1024 });
    await pack(terminalStage);

    const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) =>
                value !== undefined
                && key !== "INIT_CWD"
                && !/^npm_(?:config|package|lifecycle)_/iu.test(key)
                && !key.startsWith("PLURNK_")
                && !isProviderCredentialName(key),
        ),
    );
    await runCandidate(webRoot, archivesDir, cleanEnv);
    process.stdout.write("web conformance GREEN: candidate clone, lint, browser suites, and packed daemon installation\n");
    passed = true;
} finally {
    if (passed) await rm(temp, { recursive: true, force: true });
    else process.stderr.write(`web conformance evidence preserved at ${temp}\n`);
}
