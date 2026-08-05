#!/usr/bin/env node
// Coordinated grammar-family maintenance for {§grammar-family-lifecycle}.
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
const AGENT_ID = "plurnk_codex";

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

export const expectedGrammarLeaves = (manifest, only) => {
    const expected = Object.keys(manifest.devDependencies ?? {})
        .filter((name) => name.startsWith(PACKAGE_PREFIX))
        .map((name) => name.slice(PACKAGE_PREFIX.length))
        .filter((slug) => only === undefined || slug === only)
        .sort();
    invariant(expected.length > 0, only === undefined
        ? "framework declares no grammar leaf devDependencies"
        : `unknown grammar slug: ${only}`);
    return expected;
};

export const resolveGrammarLeaves = async ({ frameworkRoot, familyRoot, only }) => {
    const manifest = await readJson(path.join(frameworkRoot, "package.json"));
    const expected = expectedGrammarLeaves(manifest, only);
    const leaves = expected.map((slug) => ({
        slug,
        directory: path.join(familyRoot, `${DIRECTORY_PREFIX}${slug}`),
    }));
    const missing = [];
    for (const leaf of leaves) {
        try {
            await access(path.join(leaf.directory, "package.json"));
        } catch {
            missing.push(leaf.slug);
        }
    }
    invariant(missing.length === 0, `missing grammar leaf checkouts: ${missing.join(", ")}`);
    return leaves;
};

const checkIdentity = async (run, directory) => {
    const [{ stdout: author }, { stdout: email }] = await Promise.all([
        run("git", ["var", "GIT_AUTHOR_IDENT"], directory),
        run("git", ["config", "user.email"], directory),
    ]);
    invariant(author.startsWith(`${AGENT_ID} <`),
        `${path.basename(directory)}: active Git author is not ${AGENT_ID}`);
    invariant(email.trim() !== "", `${path.basename(directory)}: Git signer identity is unavailable`);
};

const admitLeafForUpdate = async (run, leaf, issue) => {
    const { directory, slug } = leaf;
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

const readIssueMap = async (filename, leaves) => {
    const issueMap = await readJson(filename);
    for (const { slug } of leaves) {
        invariant(Number.isSafeInteger(issueMap[slug]) && issueMap[slug] > 0,
            `${slug}: issue map must contain a positive repository-local issue number`);
    }
    return issueMap;
};

const probeLeaf = async (run, leaf) => {
    const { stdout } = await run("node", ["scripts/update-pin.mjs", "--check"], leaf.directory);
    const bump = stdout.match(/^BUMP .*/m)?.[0];
    if (bump !== undefined) return { ...leaf, state: "behind", note: bump };
    invariant(/up to date|no stable release tags upstream/i.test(stdout),
        `${leaf.slug}: update-pin probe returned no recognized verdict`);
    return { ...leaf, state: "current" };
};

const updateLeaf = async (run, leaf, issue) => {
    const branch = await admitLeafForUpdate(run, leaf, issue);
    await run("git", ["switch", "-c", branch], leaf.directory);
    try {
        await run("node", ["scripts/update-pin.mjs"], leaf.directory);
        await run("npm", ["run", "build:wasm"], leaf.directory);
        await run("npm", ["run", "verify:wasm"], leaf.directory);
        await run("npm", ["version", "patch", "--no-git-tag-version"], leaf.directory);
        const manifest = await readJson(path.join(leaf.directory, "package.json"));
        await run("git", ["add", "-A"], leaf.directory);
        await run("git", ["commit", "-S", "-m", `chore(grammar): update upstream pin (#${issue})`], leaf.directory);
        await run("git", ["push", "--set-upstream", "origin", branch], leaf.directory);
        return { ...leaf, state: "pushed", note: `${manifest.version} on ${branch}` };
    } catch (cause) {
        throw new Error(`${leaf.slug}: update stopped on ${branch}`, { cause });
    }
};

export const runGrammarLifecycle = async ({
    check,
    familyRoot,
    frameworkRoot,
    issueMapPath,
    only,
    run = defaultRun,
}) => {
    const leaves = await resolveGrammarLeaves({ frameworkRoot, familyRoot, only });
    const probes = [];
    for (const leaf of leaves) probes.push(await probeLeaf(run, leaf));
    if (check) return probes;

    const behind = probes.filter(({ state }) => state === "behind");
    if (behind.length === 0) return probes;
    invariant(issueMapPath !== undefined, "update requires --issue-map with repository-local issue numbers");
    const issueMap = await readIssueMap(issueMapPath, behind);
    const results = probes.filter(({ state }) => state === "current");
    for (const leaf of behind) results.push(await updateLeaf(run, leaf, issueMap[leaf.slug]));
    return results.sort((left, right) => left.slug.localeCompare(right.slug));
};

const main = async () => {
    const { values } = parseArgs({
        options: {
            check: { type: "boolean", default: false },
            "family-root": { type: "string" },
            "issue-map": { type: "string" },
            only: { type: "string" },
        },
    });
    const here = path.dirname(fileURLToPath(import.meta.url));
    const frameworkRoot = path.resolve(here, "..");
    const familyRoot = path.resolve(values["family-root"]
        ?? process.env.PLURNK_MIMETYPES_GRAMMARS_ROOT
        ?? path.join(frameworkRoot, "..", ".."));
    const results = await runGrammarLifecycle({
        check: values.check,
        familyRoot,
        frameworkRoot,
        issueMapPath: values["issue-map"] === undefined
            ? undefined
            : path.resolve(values["issue-map"]),
        only: values.only,
    });
    console.log(`${values.check ? "CHECK" : "UPDATE"} — ${results.length} grammar packages under ${familyRoot}`);
    for (const result of results) {
        console.log(`  ${result.state.padEnd(8)} ${result.slug}${result.note === undefined ? "" : `  ${result.note}`}`);
    }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
