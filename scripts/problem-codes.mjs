// {§problem-codes-declared} — the tag lint in reverse: every Problem code a package mints is named in
// that package's SPEC.md inside a tagged block, so a code can be found from its symptom (#888).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A code is minted where a kebab-case literal is followed by an HTTP status (`failure("code", 4xx`),
// where `Problems.create("owner", "code"` names it, or where a result shape carries `code: "…"`.
const MINTED = [
    /\(\s*"([a-z][a-z0-9-]*)"\s*,\s*\d{3}\b/g,
    /Problems\.create\(\s*"[^"]+"\s*,\s*"([a-z][a-z0-9-]*)"/g,
    /\bcode:\s*"([a-z][a-z0-9-]*)"/g,
];
const SOURCE = /\.(?:ts|mjs|sql)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "generated"]);
const DECLARATION = /(?:^|[ \t|*-])§[a-z][a-z0-9-]*(?![a-z0-9-])/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

const sourceFiles = async (dir, out = []) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await sourceFiles(full, out);
        else if (SOURCE.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
    }
    return out;
};

export const mintedCodes = (text) => {
    const codes = new Set();
    for (const pattern of MINTED) for (const match of text.matchAll(pattern)) codes.add(match[1]);
    return codes;
};

// The SPEC's blocks are blank-line separated; fenced code is inert. A block is tagged when it carries a
// declaration, and a table is tagged when the paragraph before it does.
export const declaredCodes = (spec) => {
    const blocks = [];
    let current = [];
    let fence = null;
    for (const line of spec.split("\n")) {
        const marker = line.match(FENCE)?.[1];
        // A backtick fence's info string carries no backtick, so a line such as ```` ```EDIT … ```` is
        // an inline example, not a fence. A fence closes only on its own character at its length or
        // longer; inner fences are inert.
        if (marker !== undefined && (fence !== null || marker[0] !== "`" || !line.slice(line.indexOf(marker) + marker.length).includes("`"))) {
            if (fence === null) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length && line.slice(line.indexOf(marker) + marker.length).trim() === "") fence = null;
            continue;
        }
        if (fence !== null) continue;
        if (line.trim() === "") { if (current.length > 0) blocks.push(current); current = []; continue; }
        current.push(line);
    }
    if (current.length > 0) blocks.push(current);
    const declared = new Set();
    let previousTagged = false;
    for (const block of blocks) {
        const tagged = block.some((line) => DECLARATION.test(line));
        const table = block.every((line) => /^ {0,3}\|/.test(line));
        if (tagged || (table && previousTagged)) {
            for (const match of block.join("\n").matchAll(/`([a-z][a-z0-9-]*)`/g)) declared.add(match[1]);
        }
        previousTagged = tagged;
    }
    return declared;
};

export const undeclaredCodes = async (root) => {
    const findings = [];
    for (const name of (await fs.readdir(root)).filter((entry) => entry.startsWith("plurnk-")).sort()) {
        const src = path.join(root, name, "src");
        try { await fs.access(src); } catch { continue; }
        const codes = new Map();
        for (const file of await sourceFiles(src)) {
            for (const code of mintedCodes(await fs.readFile(file, "utf8"))) {
                codes.set(code, [...(codes.get(code) ?? []), path.relative(root, file)]);
            }
        }
        if (codes.size === 0) continue;
        let spec = "";
        try { spec = await fs.readFile(path.join(root, name, "SPEC.md"), "utf8"); } catch { /* no SPEC: every code is undeclared */ }
        const declared = declaredCodes(spec);
        for (const [code, files] of codes) {
            if (!declared.has(code)) findings.push({ package: name, code, files: [...new Set(files)] });
        }
    }
    return findings;
};

const main = async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const findings = await undeclaredCodes(root);
    if (findings.length === 0) {
        console.log("problem codes OK — every minted code is named by its owner's SPEC");
        return;
    }
    console.error("Problem codes no owning SPEC.md names in a tagged block:");
    for (const { package: name, code, files } of findings) console.error(`  ${name}: ${code}  ← ${files.join(", ")}`);
    process.exitCode = 1;
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
