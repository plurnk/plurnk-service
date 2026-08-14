import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel, serializeGbnf } from "../plurnk-contracts/scriptify/generate-gbnf.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IGNORED_DIRECTORIES = new Set([
    ".git",
    ".tmp",
    "coverage",
    "dist",
    "node_modules",
]);
const TEXT_EXTENSIONS = new Set([
    ".cjs",
    ".g4",
    ".gbnf",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".sql",
    ".toml",
    ".ts",
    ".txt",
    ".yaml",
    ".yml",
]);
const RETIRED_NAMES = "OP|TURN|PLAN|FIND|READ|EDIT|COPY|MOVE|OPEN|FOLD|SEND|EXEC|BARE|WORK|FORK|KILL|LOOK|BUFF";
const RETIRED_FORMS = [
    new RegExp(`<\\|(?:${RETIRED_NAMES})[A-Za-z0-9_]*(?=[\\[>(<|])`, "g"),
    new RegExp(`<(?:${RETIRED_NAMES})[A-Za-z0-9_]*\\|>`, "g"),
];

const filesUnder = async (directory) => {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name)) files.push(...await filesUnder(join(directory, entry.name)));
        } else if (entry.name !== "package-lock.json" && TEXT_EXTENSIONS.has(extname(entry.name))) {
            files.push(join(directory, entry.name));
        }
    }
    return files;
};

test("retired PLURNK delimiters never reappear", async () => {
    const violations = [];
    const sources = [
        ...await Promise.all((await filesUnder(ROOT)).map(async (file) => ({
            name: relative(ROOT, file),
            content: await readFile(file, "utf8"),
        }))),
        {
            name: "generated:plurnk.gemma.gbnf",
            content: serializeGbnf(buildModel(), "root-gemma"),
        },
        {
            name: "generated:plurnk.qwen.gbnf",
            content: serializeGbnf(buildModel(), "root-qwen"),
        },
    ];
    for (const { name, content } of sources) {
        for (const pattern of RETIRED_FORMS) {
            for (const match of content.matchAll(pattern)) {
                const line = content.slice(0, match.index).split("\n").length;
                violations.push(`${name}:${line}: ${match[0]}`);
            }
        }
    }
    assert.deepEqual(violations, [], `retired PLURNK syntax found:\n${violations.join("\n")}`);
});
