// pre-push provenance. Two rules, one of them universal:
//
//   1. Every pushed commit carries a good signature. This holds in any clone.
//   2. Its author and committer are identities this clone accepts — a local policy,
//      because who may author here is a property of the installation, not of the
//      project. Configure it per clone; unconfigured, rule 1 still applies.
//
//       git config --add plurnk.allowedAuthor "Name <address>"
//       git config plurnk.allowedCommitter    "Name <address>"
//
// Each allowedAuthor is one exact `Name <address>`; repeat the flag for more. The
// committer is single-valued and doubles as the required signer. Nothing here names
// an identity: a register of who may push belongs to the clone that enforces it.
import { spawnSync } from "node:child_process";

const ZERO = "0".repeat(40);

const config = (key) => {
    const result = spawnSync("git", ["config", "--get-all", key], { encoding: "utf8" });
    // Exit 1 is "not set", which is the ordinary unconfigured case, not a failure.
    return result.status === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
};

export const readPolicy = () => ({
    authors: new Set(config("plurnk.allowedAuthor")),
    committer: config("plurnk.allowedCommitter")[0] ?? null,
});

export const identity = (name, email) => `${name} <${email}>`;

export const validateCommit = (
    { sha, authorName, authorEmail, committerName, committerEmail, signature },
    policy = { authors: new Set(), committer: null },
) => {
    const errors = [];
    if (policy.authors.size > 0 && !policy.authors.has(identity(authorName, authorEmail))) {
        errors.push(`unexpected author ${identity(authorName, authorEmail)}`);
    }
    if (policy.committer !== null && identity(committerName, committerEmail) !== policy.committer) {
        errors.push(`unexpected committer ${identity(committerName, committerEmail)}`);
    }
    if (signature !== "G") errors.push(`signature status is ${signature || "missing"}, expected G`);
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
    const [remote, localSha, remoteSha] = process.argv.slice(2);
    if (!remote || !localSha || !remoteSha) {
        console.error("usage: commit-provenance.mjs <remote> <local-sha> <remote-sha>");
        process.exit(2);
    }
    const policy = readPolicy();
    // Never degrade in silence: a clone that configures no register still gets the signature
    // rule, and is told once that the identity half is off rather than assuming it ran.
    if (policy.authors.size === 0 && policy.committer === null) {
        console.error("pre-push: no commit-identity policy in this clone; checking signatures only.");
        console.error("  set one with git config --add plurnk.allowedAuthor \"Name <address>\"");
    }
    const errors = inspect(pushedCommits(remote, localSha, remoteSha))
        .flatMap((commit) => validateCommit(commit, policy));
    if (errors.length > 0) {
        console.error("pre-push: commit provenance rejected:");
        for (const error of errors) console.error(`  ${error}`);
        if (policy.authors.size > 0) console.error(`authors may be ${[...policy.authors].join(" or ")}`);
        if (policy.committer !== null) console.error(`the committer and signer must be ${policy.committer}`);
        console.error("this clone's policy is git config plurnk.allowedAuthor / plurnk.allowedCommitter");
        process.exit(1);
    }
}
