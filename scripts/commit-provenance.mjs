// pre-push provenance ({§lint-gate}):
//
//   1. Commits pushed to `refs/heads/main` or `refs/tags/*` on a canonical
//      `possumtech.com` remote (or when `remote-ref` is omitted) must carry a
//      good signature (`G`). Non-canonical fork remotes and WIP feature branches
//      (`refs/heads/<type>/<slug>`) do not require a PossumTech GPG key.
//   2. Author and committer identities are checked against any local clone policy:
//
//       git config --add plurnk.allowedAuthor "Name <address>"
//       git config plurnk.allowedCommitter    "Name <address>"
//
// Each allowedAuthor is one exact `Name <address>`; repeat the flag for more. The
// committer is single-valued and doubles as the required signer on protected refs.
import { spawnSync } from "node:child_process";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: node scripts/commit-provenance.mjs <remote> <local-sha> <remote-sha> [remote-ref]
Checks commit provenance before a push ({§lint-gate}): enforces good GPG signatures on canonical possumtech.com pushes to refs/heads/main or refs/tags/* (and when remote-ref is omitted), and validates author/committer identities against any local plurnk.allowedAuthor / plurnk.allowedCommitter git config.
Reads: git config plurnk.allowedAuthor, plurnk.allowedCommitter, git remote get-url, git rev-list, git log.
Writes: rejection details to stderr; exits 1 on violation.
`);

const ZERO = "0".repeat(40);
const CANONICAL_DOMAIN = "possumtech.com";

const isCanonicalHost = (host) => {
    const normalized = host.trim().toLowerCase().replace(/\.$/u, "");
    return normalized === CANONICAL_DOMAIN || normalized.endsWith(`.${CANONICAL_DOMAIN}`);
};

export const isCanonicalRemoteUrl = (remoteUrl) => {
    if (typeof remoteUrl !== "string" || remoteUrl.trim().length === 0) return false;
    const trimmed = remoteUrl.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
        try {
            return isCanonicalHost(new URL(trimmed).hostname);
        } catch {
            return false;
        }
    }
    const scpMatch = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):[^/]/u.exec(trimmed);
    return scpMatch !== null && isCanonicalHost(scpMatch[1]);
};

export const isSignatureProtectedRef = (remoteRef) =>
    remoteRef === undefined
    || remoteRef === "refs/heads/main"
    || remoteRef.startsWith("refs/tags/");

export const requiresSignature = ({ remoteUrl, remoteRef } = {}) => {
    const canonicalRemote = remoteUrl === undefined ? true : isCanonicalRemoteUrl(remoteUrl);
    return canonicalRemote && isSignatureProtectedRef(remoteRef);
};

const config = (key) => {
    const result = spawnSync("git", ["config", "--get-all", key], { encoding: "utf8" });
    // Exit 1 is "not set", which is the ordinary unconfigured case, not a failure.
    return result.status === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
};

const resolveRemoteUrl = (remote) => {
    const pushUrl = spawnSync("git", ["remote", "get-url", "--push", remote], { encoding: "utf8" });
    if (pushUrl.status === 0 && pushUrl.stdout.trim().length > 0) {
        return pushUrl.stdout.trim().split("\n")[0].trim();
    }
    return remote;
};

export const readPolicy = () => ({
    authors: new Set(config("plurnk.allowedAuthor")),
    committer: config("plurnk.allowedCommitter")[0] ?? null,
});

export const identity = (name, email) => `${name} <${email}>`;

export const validateCommit = (
    { sha, authorName, authorEmail, committerName, committerEmail, signature },
    policy = { authors: new Set(), committer: null },
    { requireSignature = true } = {},
) => {
    const errors = [];
    if (policy.authors.size > 0 && !policy.authors.has(identity(authorName, authorEmail))) {
        errors.push(`unexpected author ${identity(authorName, authorEmail)}`);
    }
    if (policy.committer !== null && identity(committerName, committerEmail) !== policy.committer) {
        errors.push(`unexpected committer ${identity(committerName, committerEmail)}`);
    }
    if (requireSignature && signature !== "G") {
        errors.push(`signature status is ${signature || "missing"}, expected G`);
    }
    return errors.map((error) => `${sha.slice(0, 12)}: ${error}`);
};

const git = (args, input) => {
    const result = spawnSync("git", args, { encoding: "utf8", input });
    if (result.status !== 0) {
        process.stderr.write(result.stderr);
        process.exit(result.status ?? 1);
    }
    return result.stdout;
};

const pushedCommits = (remote, localSha, remoteSha) => {
    const args = ["rev-list", localSha];
    if (remoteSha !== ZERO) args.push(`^${remoteSha}`);
    args.push("--not", `--remotes=${remote}`);
    return git(args).trim().split("\n").filter(Boolean);
};

const inspect = (commits) => {
    if (commits.length === 0) return [];
    const format = "%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%G?%x1e";
    return git(["log", "--no-walk", "--stdin", `--format=${format}`], `${commits.join("\n")}\n`)
        .split("\x1e")
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
            const [sha, authorName, authorEmail, committerName, committerEmail, signature] = record.split("\x1f");
            return { sha, authorName, authorEmail, committerName, committerEmail, signature };
        });
};

if (import.meta.main) {
    const [remote, localSha, remoteSha, remoteRef] = process.argv.slice(2);
    if (!remote || !localSha || !remoteSha) {
        console.error("usage: commit-provenance.mjs <remote> <local-sha> <remote-sha> [remote-ref]");
        process.exit(2);
    }
    const policy = readPolicy();
    const remoteUrl = resolveRemoteUrl(remote);
    const requireSignature = requiresSignature({ remoteUrl, remoteRef });
    if (!requireSignature && policy.authors.size === 0 && policy.committer === null) {
        process.exit(0);
    }
    // Never degrade in silence on signature-protected refs: a clone that configures no register
    // still gets the signature rule, and is told once that the identity half is off.
    if (requireSignature && policy.authors.size === 0 && policy.committer === null) {
        console.error("pre-push: no commit-identity policy in this clone; checking signatures only.");
        console.error("  set one with git config --add plurnk.allowedAuthor \"Name <address>\"");
    }
    const errors = inspect(pushedCommits(remote, localSha, remoteSha))
        .flatMap((commit) => validateCommit(commit, policy, { requireSignature }));
    if (errors.length > 0) {
        console.error("pre-push: commit provenance rejected:");
        for (const error of errors) console.error(`  ${error}`);
        if (policy.authors.size > 0) console.error(`authors may be ${[...policy.authors].join(" or ")}`);
        if (policy.committer !== null) console.error(`the committer${requireSignature ? " and signer" : ""} must be ${policy.committer}`);
        console.error("this clone's policy is git config plurnk.allowedAuthor / plurnk.allowedCommitter");
        process.exit(1);
    }
}
