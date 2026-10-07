import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalForgeOrigin } from "./release-authority.mjs";
import { releaseNotes } from "./changelog.mjs";
import { readCandidate, readJson } from "./release-candidate.mjs";

const exec = promisify(execFile);
const output = async (command, args, cwd) => (await exec(command, args, {
    cwd, maxBuffer: 64 * 1024 * 1024,
})).stdout.trim();

export const assertReleaseHosting = async (root, repo, run = output) => {
    const origin = await run("git", ["remote", "get-url", "origin"], root);
    if (origin !== canonicalForgeOrigin(repo)) throw new Error(`${repo}: noncanonical release origin ${origin}`);
    const github = await run("git", ["remote", "get-url", "github"], root);
    if (![`git@github.com:plurnk/${repo}.git`, `https://github.com/plurnk/${repo}.git`].includes(github)) {
        throw new Error(`${repo}: unexpected GitHub mirror ${github}`);
    }
    const hosting = JSON.parse(await run("gh", ["api", `repos/plurnk/${repo}`], root));
    if (hosting.permissions?.push !== true) throw new Error(`${repo}: GitHub release write permission unavailable`);
};

// {§release-finalization}: explicit commits come only from the verified train;
// the repair command requires existing tags and never guesses from current HEAD.
export const finalizeRelease = async ({ root, repo, packageFile, version, commit, tagName, record = true, notes, composition }, run = output) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid release version: ${version}`);
    await assertReleaseHosting(root, repo, run);
    const tag = tagName ?? `v${version}`;
    const git = (...args) => run("git", args, root);
    const hasTag = (await git("tag", "--list", tag)) === tag;
    if (commit === undefined && !hasTag) throw new Error(`${repo}: repair requires an existing signed tag ${tag}`);
    const revision = await git("rev-parse", `${commit ?? tag}^{commit}`);
    const manifest = JSON.parse(await git("show", `${revision}:${packageFile}`));
    if (manifest.version !== version) throw new Error(`${repo}: ${revision} contains ${manifest.version}, not ${version}`);
    const published = JSON.parse(await run("npm", ["view", `${manifest.name}@${version}`, "--json"], root));
    if (published.version !== version) throw new Error(`${manifest.name}@${version} is not served`);
    if (published.gitHead !== undefined && published.gitHead !== revision) {
        throw new Error(`${repo}: published gitHead ${published.gitHead} differs from ${revision}`);
    }
    const main = (await git("ls-remote", "origin", "refs/heads/main")).split(/\s/)[0];
    if (!main) throw new Error(`${repo}: origin/main is missing`);
    await git("merge-base", "--is-ancestor", revision, main);
    await git("verify-commit", revision);
    if (hasTag) {
        if (await git("rev-parse", `${tag}^{commit}`) !== revision) throw new Error(`${repo}: conflicting local tag ${tag}`);
    } else {
        // A prior train may have pushed the tag from a different checkout.
        const remote = await git("ls-remote", "origin", `refs/tags/${tag}`);
        if (remote !== "") await git("fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
        else await git("tag", "-s", tag, revision, "-m", `${manifest.name} ${version}`);
        if (await git("rev-parse", `${tag}^{commit}`) !== revision) throw new Error(`${repo}: conflicting fetched tag ${tag}`);
    }
    await git("verify-tag", tag);
    const tagObject = await git("rev-parse", `refs/tags/${tag}`);
    const missingTags = [];
    for (const remote of ["origin", "github"]) {
        const remoteObject = (await git("ls-remote", remote, `refs/tags/${tag}`)).split(/\s/)[0];
        if (remoteObject && remoteObject !== tagObject) throw new Error(`${repo}: conflicting ${remote} tag ${tag}`);
        if (!remoteObject) missingTags.push(remote);
    }
    for (const remote of missingTags) {
        // The canonical push owns verification; GitHub is the existing no-CI mirror.
        await git("push", ...(remote === "github" ? ["--no-verify"] : []), remote, `refs/tags/${tag}`);
    }
    if (!record) return;

    const releases = JSON.parse(await run("gh", [
        "api", "--paginate", "--slurp", `repos/plurnk/${repo}/releases?per_page=100`,
    ], root)).flat();
    const existing = releases.find((release) => release.tag_name === tag);
    if (existing !== undefined) {
        if (existing.draft || existing.prerelease) throw new Error(`${repo}: ${tag} exists but is not a stable published release`);
        return;
    }
    const changes = notes ?? await releaseNotes(root, tag, repo);
    const body = composition === undefined ? changes : `${changes}\n\n${composition}`;
    await run("gh", [
        "release", "create", tag, "--repo", `plurnk/${repo}`, "--verify-tag",
        "--title", `${manifest.name} ${version}`, "--notes", body,
    ], root);
};

export const finalizeCandidate = async ({ packages }, directory) => {
    // The successful registry-installed verification writes this evidence last.
    const installed = await readJson(path.join(directory, "registry-lock.json"));
    for (const { name, version } of packages) {
        if (installed.packages?.[`node_modules/${name}`]?.version !== version) throw new Error(`${name}@${version}: no successful registry-consumer evidence`);
    }
    const composition = `## Tested composition\n\n| Package | Version | Source |\n| --- | --- | --- |\n${packages.map(({ name, version, repo, commit }) =>
        `| ${name} | ${version} | [${commit.slice(0, 12)}](https://github.com/plurnk/${repo}/commit/${commit}) |`).join("\n")}\n`;
    const service = packages.find(({ name }) => name === "@plurnk/plurnk-service");
    for (const item of packages) {
        const module = item.repo === "plurnk-service" && item.name !== "@plurnk/plurnk-service";
        const tagName = module ? `${item.name}@${item.version}` : `v${item.version}`;
        const record = !module || service === undefined;
        let notes;
        if (module && record) {
            const file = path.join(path.dirname(item.packageFile), "CHANGELOG.md");
            const changelog = await output("git", ["show", `${item.commit}:${file}`], item.root);
            const heading = `## ${item.version}\n`;
            const start = changelog.indexOf(heading);
            if (start < 0) throw new Error(`${item.name}: no release notes for ${item.version}`);
            const next = changelog.indexOf("\n## ", start + heading.length);
            notes = changelog.slice(start, next < 0 ? undefined : next);
        }
        await finalizeRelease({ ...item, tagName, record, notes, composition });
    }
};

if (import.meta.main) {
    const [directory, ...extra] = process.argv.slice(2);
    if (directory === undefined || extra.length !== 0) {
        throw new Error("usage: release-finalize.mjs <qualified-artifact-directory>");
    }
    await finalizeCandidate(await readCandidate(directory), directory);
}
