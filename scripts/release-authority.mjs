import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const CANONICAL_NPM_IDENTITY = "possumtechcom";
export const CANONICAL_NPM_REGISTRY = "https://registry.npmjs.org/";

export const canonicalForgeOrigin = (repo) => {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(repo)) throw new Error(`invalid canonical repository name: ${repo}`);
    return `ssh://git@ssh.possumtech.com/plurnk/${repo}.git`;
};

export const repositoryAuthorityViolations = ({ repo, origin, branch, head, remoteHead }) => {
    const violations = [];
    const expectedOrigin = canonicalForgeOrigin(repo);
    if (origin !== expectedOrigin) violations.push(`origin is ${origin}, expected ${expectedOrigin}`);
    if (branch !== "main") violations.push(`branch is ${branch || "detached HEAD"}, expected main`);
    if (head !== remoteHead) violations.push(`HEAD ${head} does not equal origin/main ${remoteHead || "missing"}`);
    return violations;
};

const output = async (command, args, cwd) => (await run(command, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
})).stdout.trim();

export const assertReleaseRepository = async (root, repo) => {
    const origin = await output("git", ["remote", "get-url", "origin"], root);
    const branch = await output("git", ["branch", "--show-current"], root);
    const head = await output("git", ["rev-parse", "HEAD"], root);
    const remoteLine = await output("git", ["ls-remote", "origin", "refs/heads/main"], root);
    const remoteHead = remoteLine.split(/\s+/)[0] ?? "";
    const violations = repositoryAuthorityViolations({ repo, origin, branch, head, remoteHead });
    if (violations.length > 0) throw new Error(`${repo}: release authority rejected — ${violations.join("; ")}`);
    try {
        await output("git", ["verify-commit", "HEAD"], root);
    } catch (cause) {
        throw new Error(`${repo}: release HEAD is not signed by a trusted key`, { cause });
    }
    return { origin, branch, head };
};

export const assertNpmPublisher = async (cwd) => {
    const registry = await output("npm", ["config", "get", "registry"], cwd);
    if (registry !== CANONICAL_NPM_REGISTRY) {
        throw new Error(`npm registry is ${registry}, expected ${CANONICAL_NPM_REGISTRY}`);
    }
    let identity;
    try {
        identity = await output("npm", ["whoami"], cwd);
    } catch (cause) {
        throw new Error("npm publisher authentication is unavailable", { cause });
    }
    if (identity !== CANONICAL_NPM_IDENTITY) {
        throw new Error(`npm identity is ${identity}, expected ${CANONICAL_NPM_IDENTITY}`);
    }
    return { identity, registry };
};
