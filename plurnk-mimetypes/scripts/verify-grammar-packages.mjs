#!/usr/bin/env node
// Family acceptance for {§grammar-leaf-reproducibility}.
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_PREFIX = "@plurnk/plurnk-mimetypes-grammar-";
const DIRECTORY_PREFIX = "plurnk-mimetypes-grammar-";
const CLI_PACKAGE = "tree-sitter-cli";
const LOCAL_CLI = 'path.join(repoRoot, "node_modules", ".bin", "tree-sitter")';
const SOURCE_READ = 'const source = (await readFile(path.join(repoRoot, ".grammar-source"), "utf-8")).trim();';
const PIN_VALIDATION = "if (!/^[0-9a-f]{40}$/i.test(pin)) {";
const UPSTREAM_INSTALL = 'await run("npm", ["ci", "--ignore-scripts", "--omit=dev"], { cwd: path.join(work, "src") });';
const DISPOSABLE_CHECKOUT = "await using temporary = await mkdtempDisposable(";
const TEMPORARY_PATH = "const work = temporary.path;";
const GIT_INIT = 'await run("git", ["init", "--quiet", "src"], { cwd: work });';
const GIT_CHECKOUT = 'await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: path.join(work, "src") });';
const GIT_FETCH = 'await run("git", ["fetch", "--quiet", "--depth=1", source, pin], { cwd: path.join(work, "src") });';
const GIT_LS_REMOTE = 'execFileSync("git", ["ls-remote", "--tags", source]';

const readJson = async (name) => JSON.parse(await readFile(name, "utf8"));

const invariant = (condition, message) => {
    if (!condition) throw new Error(message);
};

export const assertGrammarLeafContract = async (directory) => {
    const manifest = await readJson(path.join(directory, "package.json"));
    const lock = await readJson(path.join(directory, "package-lock.json"));
    const npmrc = await readFile(path.join(directory, ".npmrc"), "utf8");
    const source = (await readFile(path.join(directory, ".grammar-source"), "utf8")).trim();
    const pin = (await readFile(path.join(directory, ".grammar-pin"), "utf8")).trim();
    const cliVersion = manifest.devDependencies?.[CLI_PACKAGE];
    const label = manifest.name ?? path.basename(directory);

    const sourceUrl = URL.canParse(source) ? new URL(source) : null;
    invariant(sourceUrl?.protocol === "https:"
        && sourceUrl.username === ""
        && sourceUrl.password === ""
        && sourceUrl.search === ""
        && sourceUrl.hash === ""
        && sourceUrl.pathname.endsWith(".git"),
        `${label}: .grammar-source must contain a credential-free HTTPS git URL`);
    invariant(manifest.files?.includes(".grammar-source") && manifest.files.includes(".grammar-pin"),
        `${label}: package files must publish .grammar-source and .grammar-pin as source provenance`);
    invariant(/^[0-9a-f]{40}$/i.test(pin),
        `${label}: .grammar-pin must contain a full git commit SHA`);
    invariant(/^\d+\.\d+\.\d+$/.test(cliVersion ?? ""),
        `${label}: devDependencies.${CLI_PACKAGE} must be an exact version`);
    const allowedKey = `${CLI_PACKAGE}@${cliVersion}`;
    const cliPolicies = Object.entries(manifest.allowScripts ?? {})
        .filter(([key]) => key === CLI_PACKAGE || key.startsWith(`${CLI_PACKAGE}@`));
    invariant(cliPolicies.length === 1 && cliPolicies[0][0] === allowedKey && cliPolicies[0][1] === true,
        `${label}: allowScripts must authorize only ${allowedKey} for the CLI`);
    invariant(npmrc.split(/\r?\n/).includes("strict-allow-scripts=true"),
        `${label}: .npmrc must enable strict allow-script enforcement`);
    invariant(lock.packages?.[""]?.devDependencies?.[CLI_PACKAGE] === cliVersion,
        `${label}: package-lock root does not pin ${CLI_PACKAGE}@${cliVersion}`);
    const lockedCli = lock.packages?.[`node_modules/${CLI_PACKAGE}`];
    invariant(lockedCli?.version === cliVersion && typeof lockedCli.integrity === "string" && lockedCli.integrity !== "",
        `${label}: package-lock has no integrity-locked ${CLI_PACKAGE}@${cliVersion}`);

    for (const scriptName of ["build-wasm.mjs", "verify-wasm.mjs"]) {
        const script = await readFile(path.join(directory, "scripts", scriptName), "utf8");
        invariant(script.includes(SOURCE_READ) && !script.includes("https://"),
            `${label}: ${scriptName} must consume only the owned .grammar-source locator`);
        invariant(script.includes(PIN_VALIDATION),
            `${label}: ${scriptName} must validate the full source pin`);
        invariant(script.includes(LOCAL_CLI),
            `${label}: ${scriptName} does not resolve the checkout-local CLI`);
        invariant(!script.includes(`${CLI_PACKAGE}@`) && !script.includes('["install", "--no-save"'),
            `${label}: ${scriptName} retains an ad hoc CLI install`);
        const upstreamInstalls = script.split("\n")
            .filter((line) => line.includes('await run("npm"') && line.includes('path.join(work, "src")'));
        invariant(upstreamInstalls.every((line) => line.trim() === UPSTREAM_INSTALL),
            `${label}: ${scriptName} has an uncontained upstream dependency install`);
        invariant(script.split(DISPOSABLE_CHECKOUT).length === 2
            && script.includes(TEMPORARY_PATH)
            && !script.includes("mkdtemp(")
            && !script.includes('["clone"'),
            `${label}: ${scriptName} must use one disposable temporary checkout`);
        invariant(script.includes(GIT_INIT) && script.includes(GIT_CHECKOUT),
            `${label}: ${scriptName} does not initialize and detach the temporary checkout`);
        invariant(script.split(GIT_FETCH).length === 2,
            `${label}: ${scriptName} must fetch only the pinned commit at depth one`);
        invariant(!script.includes("process.exit("),
            `${label}: ${scriptName} bypasses temporary checkout disposal with process.exit()`);
    }
    const updateScript = await readFile(path.join(directory, "scripts", "update-pin.mjs"), "utf8");
    invariant(updateScript.includes(SOURCE_READ)
        && updateScript.includes(PIN_VALIDATION)
        && updateScript.includes(GIT_LS_REMOTE)
        && !updateScript.includes("build-wasm.mjs")
        && !updateScript.includes("https://"),
        `${label}: update-pin.mjs must consume only the owned .grammar-source locator`);
};

const run = (command, args, cwd) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", (cause) => reject(new Error(
        `${command} ${args.join(" ")} could not start in ${cwd}`,
        { cause },
    )));
    child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(
            `${command} ${args.join(" ")} failed in ${cwd} (${signal ?? `status ${code}`})`,
        ));
    });
});

const main = async () => {
    const { values: { "contract-only": contractOnly, only } } = parseArgs({
        options: {
            "contract-only": { type: "boolean", default: false },
            only: { type: "string" },
        },
    });
    const here = path.dirname(fileURLToPath(import.meta.url));
    const frameworkRoot = path.resolve(here, "..");
    const familyRoot = path.resolve(
        process.env.PLURNK_MIMETYPES_GRAMMARS_ROOT ?? path.join(frameworkRoot, "..", ".."),
    );
    const framework = await readJson(path.join(frameworkRoot, "package.json"));
    const expected = Object.keys(framework.devDependencies ?? {})
        .filter((name) => name.startsWith(PACKAGE_PREFIX))
        .map((name) => name.slice(PACKAGE_PREFIX.length))
        .filter((slug) => only === undefined || slug === only)
        .sort();
    invariant(expected.length > 0, only === undefined
        ? "framework declares no grammar leaf devDependencies"
        : `unknown grammar slug: ${only}`);
    const present = new Set((await readdir(familyRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(DIRECTORY_PREFIX))
        .map((entry) => entry.name.slice(DIRECTORY_PREFIX.length)));
    const missing = expected.filter((slug) => !present.has(slug));
    invariant(missing.length === 0, `missing grammar leaf checkouts: ${missing.join(", ")}`);

    const leaves = expected.map((slug) => ({
        slug,
        directory: path.join(familyRoot, `${DIRECTORY_PREFIX}${slug}`),
    }));
    for (const { slug, directory } of leaves) {
        await assertGrammarLeafContract(directory);
        console.log(`contract OK: ${slug}`);
    }
    if (contractOnly) return;

    for (const { slug, directory } of leaves) {
        console.log(`\n[${slug}] npm ci`);
        await run("npm", ["ci"], directory);
        console.log(`[${slug}] npm run verify:wasm`);
        await run("npm", ["run", "verify:wasm"], directory);
    }
    console.log(`\n${leaves.length} grammar artifacts verified`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
