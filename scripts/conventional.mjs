import { readFile } from "node:fs/promises";

export const CONVENTIONAL_TYPES = [
    "feat",
    "fix",
    "chore",
    "docs",
    "refactor",
    "test",
    "perf",
    "build",
    "ci",
    "revert",
    "style",
];

const types = CONVENTIONAL_TYPES.join("|");
const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
const branchPattern = new RegExp(`^(?:main|(?:${types})/${slug})$`);
const subjectPattern = new RegExp(`^(?:${types})(?:\\([a-z0-9-]+\\))?!?: .+`);

export const validateBranchName = (branch) => branchPattern.test(branch)
    ? []
    : [`branch '${branch}' violates policy — main or type/kebab-slug`];

export const validateCommitMessage = (source) => {
    const lines = source.split(/\r?\n/);
    const subject = lines[0] ?? "";
    const generated = subject.startsWith("Merge ") || subject.startsWith("Revert ");
    const violations = [];

    if (!generated && !subjectPattern.test(subject)) {
        violations.push("subject must be conventional — type(scope): summary");
    }
    if (Array.from(subject).length > 80) {
        violations.push("subject exceeds 80 characters — cite an issue, commit hash, or SPEC tag instead");
    }
    if (lines.slice(1).some((line) => line.trim() !== "" && !line.startsWith("#"))) {
        violations.push("one-liner doctrine — no body; rationale belongs in SPEC.md or an issue");
    }
    if (/^(?:Co-Authored-By|Claude-Session):/im.test(source)) {
        violations.push("no Co-Authored-By / Claude-Session trailers");
    }
    return violations;
};

if (import.meta.main) {
    const [mode, value] = process.argv.slice(2);
    let violations;
    if (mode === "branch" && value !== undefined) {
        violations = validateBranchName(value);
    } else if (mode === "commit" && value !== undefined) {
        violations = validateCommitMessage(await readFile(value, "utf8"));
    } else {
        throw new Error("usage: conventional.mjs branch <name> | commit <message-file>");
    }
    for (const violation of violations) console.error(`conventional: ${violation}`);
    if (violations.length > 0) process.exit(1);
}
