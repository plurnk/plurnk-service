#!/usr/bin/env node
// Coordinated grammar maintenance for {§grammar-package-lifecycle}.
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const PACKAGE_PREFIX = "@plurnk/plurnk-mimetypes-grammar-";
const DIRECTORY_PREFIX = "plurnk-mimetypes-grammar-";
const CANONICAL_REMOTE_PREFIX = "ssh://git@ssh.possumtech.com/plurnk/";

const invariant = (condition, message) => {
    if (!condition) throw new Error(message);
};

const readJson = async (filename) => JSON.parse(await readFile(filename, "utf8"));

const defaultRun = async (command, args, cwd) => {
    try {
        const { stdout = "", stderr = "" } = await execFileAsync(command, args, {
            cwd,
            encoding: "utf8",
        });
        return { stdout, stderr };
    } catch (cause) {
        throw new Error(
            `${command} ${args.join(" ")} failed in ${cwd}`,
            { cause },
        );
    }
};

export const expectedGrammarPackages = (manifest, only) => {
    const expected = Object.keys(manifest.devDependencies ?? {})
        .filter((name) => name.startsWith(PACKAGE_PREFIX))
        .map((name) => name.slice(PACKAGE_PREFIX.length))
        .filter((slug) => only === undefined || slug === only)
        .sort();
    invariant(expected.length > 0, only === undefined
        ? "framework declares no grammar package devDependencies"
        : `unknown grammar slug: ${only}`);
    return expected;
};

export const resolveGrammarPackages = async ({ frameworkRoot, grammarsRoot, only }) => {
    const manifest = await readJson(path.join(frameworkRoot, "package.json"));
    const expected = expectedGrammarPackages(manifest, only);
    const grammars = expected.map((slug) => ({
        slug,
        directory: path.join(grammarsRoot, `${DIRECTORY_PREFIX}${slug}`),
    }));
    const missing = [];
    for (const grammar of grammars) {
        try {
            await access(path.join(grammar.directory, "package.json"));
        } catch {
            missing.push(grammar.slug);
        }
    }
    invariant(missing.length === 0, `missing grammar package checkouts: ${missing.join(", ")}`);
    return grammars;
};

const checkIdentity = async (run, directory) => {
    const [{ stdout: author }, { stdout: email }] = await Promise.all([
        run("git", ["var", "GIT_AUTHOR_IDENT"], directory),
        run("git", ["config", "user.email"], directory),
    ]);
    // The identity is the checkout's to configure; the procedure requires only that one
    // exists and can sign, because the commit it creates is signed.
    invariant(author.trim() !== "", `${path.basename(directory)}: no Git author is configured`);
    invariant(email.trim() !== "", `${path.basename(directory)}: Git signer identity is unavailable`);
};

const admitGrammarForUpdate = async (run, grammar, issue) => {
    const { directory, slug } = grammar;
    const [{ stdout: status }, { stdout: branch }, { stdout: remote }, { stdout: head }, { stdout: upstream }] = await Promise.all([
        run("git", ["status", "--porcelain"], directory),
        run("git", ["branch", "--show-current"], directory),
        run("git", ["remote", "get-url", "origin"], directory),
        run("git", ["rev-parse", "HEAD"], directory),
        run("git", ["rev-parse", "origin/main"], directory),
    ]);
    invariant(status === "", `${slug}: checkout is dirty`);
    invariant(branch.trim() === "main", `${slug}: expected main, found ${branch.trim() || "detached HEAD"}`);
    invariant(remote.trim() === `${CANONICAL_REMOTE_PREFIX}${DIRECTORY_PREFIX}${slug}.git`,
        `${slug}: origin is not the canonical Gitea repository`);
    invariant(head.trim() === upstream.trim(), `${slug}: main does not equal origin/main`);
    await checkIdentity(run, directory);
    return `chore/grammar-upstream-${issue}`;
};

const readIssueMap = async (filename, grammars) => {
    const issueMap = await readJson(filename);
    for (const { slug } of grammars) {
        invariant(Number.isSafeInteger(issueMap[slug]) && issueMap[slug] > 0,
            `${slug}: issue map must contain a positive repository-local issue number`);
    }
    return issueMap;
};

const probeGrammar = async (run, grammar) => {
    const { stdout } = await run("node", ["scripts/update-pin.mjs", "--check"], grammar.directory);
    const bump = stdout.match(/^BUMP .*/m)?.[0];
    if (bump !== undefined) return { ...grammar, state: "behind", note: bump };
    invariant(/up to date|no stable release tags upstream/i.test(stdout),
        `${grammar.slug}: update-pin probe returned no recognized verdict`);
    return { ...grammar, state: "current" };
};

const updateGrammar = async (run, grammar, issue) => {
    const branch = await admitGrammarForUpdate(run, grammar, issue);
    await run("git", ["switch", "-c", branch], grammar.directory);
    try {
        await run("node", ["scripts/update-pin.mjs"], grammar.directory);
        await run("npm", ["run", "build:wasm"], grammar.directory);
        await run("npm", ["run", "verify:wasm"], grammar.directory);
        await run("npm", ["version", "patch", "--no-git-tag-version"], grammar.directory);
        const manifest = await readJson(path.join(grammar.directory, "package.json"));
        await run("git", ["add", "-A"], grammar.directory);
        await run("git", ["commit", "-S", "-m", `chore(grammar): update upstream pin (#${issue})`], grammar.directory);
        await run("git", ["push", "--set-upstream", "origin", branch], grammar.directory);
        return { ...grammar, state: "pushed", note: `${manifest.version} on ${branch}` };
    } catch (cause) {
        throw new Error(`${grammar.slug}: update stopped on ${branch}`, { cause });
    }
};

export const runGrammarLifecycle = async ({
    check,
    grammarsRoot,
    frameworkRoot,
    issueMapPath,
    only,
    run = defaultRun,
}) => {
    const grammars = await resolveGrammarPackages({ frameworkRoot, grammarsRoot, only });
    const probes = [];
    for (const grammar of grammars) probes.push(await probeGrammar(run, grammar));
    if (check) return probes;

    const behind = probes.filter(({ state }) => state === "behind");
    if (behind.length === 0) return probes;
    invariant(issueMapPath !== undefined, "update requires --issue-map with repository-local issue numbers");
    const issueMap = await readIssueMap(issueMapPath, behind);
    const results = probes.filter(({ state }) => state === "current");
    for (const grammar of behind) results.push(await updateGrammar(run, grammar, issueMap[grammar.slug]));
    return results.sort((left, right) => left.slug.localeCompare(right.slug));
};

const main = async () => {
    const { values } = parseArgs({
        options: {
            check: { type: "boolean", default: false },
            "grammars-root": { type: "string" },
            "issue-map": { type: "string" },
            only: { type: "string" },
        },
    });
    const here = path.dirname(fileURLToPath(import.meta.url));
    const frameworkRoot = path.resolve(here, "..");
    const grammarsRoot = path.resolve(values["grammars-root"]
        ?? process.env.PLURNK_MIMETYPES_GRAMMARS_ROOT
        ?? path.join(frameworkRoot, "..", ".."));
    const results = await runGrammarLifecycle({
        check: values.check,
        grammarsRoot,
        frameworkRoot,
        issueMapPath: values["issue-map"] === undefined
            ? undefined
            : path.resolve(values["issue-map"]),
        only: values.only,
    });
    console.log(`${values.check ? "CHECK" : "UPDATE"} — ${results.length} grammar packages under ${grammarsRoot}`);
    for (const result of results) {
        console.log(`  ${result.state.padEnd(8)} ${result.slug}${result.note === undefined ? "" : `  ${result.note}`}`);
    }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
