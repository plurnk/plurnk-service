import { spawnSync } from "node:child_process";

const ZERO = "0".repeat(40);

export const ALLOWED_AUTHORS = new Set([
    "wikitopian\0wikitopian@pm.me",
    "plurnk_codex\0wikitopian+plurnk_codex@pm.me",
]);

export const validateCommit = ({ sha, authorName, authorEmail, committerName, committerEmail, signature }) => {
    const errors = [];
    if (!ALLOWED_AUTHORS.has(`${authorName}\0${authorEmail}`)) {
        errors.push(`unexpected author ${authorName} <${authorEmail}>`);
    }
    if (committerName !== "wikitopian" || committerEmail !== "wikitopian@pm.me") {
        errors.push(`unexpected committer ${committerName} <${committerEmail}>`);
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

export const pushedCommits = (remote, localSha, remoteSha) => {
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
    const errors = inspect(pushedCommits(remote, localSha, remoteSha)).flatMap(validateCommit);
    if (errors.length > 0) {
        console.error("pre-push: commit provenance rejected:");
        for (const error of errors) console.error(`  ${error}`);
        console.error("authors may be plurnk_codex or wikitopian; the committer and signer must be wikitopian");
        process.exit(1);
    }
}
