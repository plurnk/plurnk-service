import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REFERENCE_TAG = /\{§([a-z0-9][a-z0-9-]*)\}/g;
const SPEC_TAG = /§([a-z][a-z0-9-]*)/g;

const tagsIn = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);

export const unresolvedSpecReferences = (files) => {
    const declarations = new Set(
        files
            .filter(({ name }) => path.basename(name) === "SPEC.md")
            .flatMap(({ text }) => tagsIn(text, SPEC_TAG)),
    );
    return files
        .filter(({ name }) => path.basename(name) !== "SPEC.md")
        .flatMap(({ name, text }) => [...text.matchAll(REFERENCE_TAG)].flatMap((match) => {
            const tag = match[1];
            if (declarations.has(tag)) return [];
            const line = text.slice(0, match.index).split("\n").length;
            return [{ name, line, tag }];
        }));
};

const repositoryFiles = async (root) => {
    const names = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
    ).split("\0").filter(Boolean);
    const files = [];
    for (const name of names) {
        const bytes = await fs.readFile(path.join(root, name));
        if (bytes.includes(0)) continue;
        files.push({ name, text: bytes.toString("utf8") });
    }
    return files;
};

const main = async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const unresolved = unresolvedSpecReferences(await repositoryFiles(root));
    if (unresolved.length === 0) {
        console.log("spec references OK");
        return;
    }
    console.error("Unresolved specification references:");
    for (const { name, line, tag } of unresolved) {
        console.error(`  ${name}:${line} {§${tag}}`);
    }
    process.exitCode = 1;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
