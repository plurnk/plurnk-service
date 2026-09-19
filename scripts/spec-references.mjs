import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HEADING = /^ {0,3}#{1,6}[ \t]+/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/;
const BLOCK_WITHOUT_DECLARATION = /^ {0,3}(?:>|\||<)/;
const NAMED_TAG = "§([a-z][a-z0-9-]*)(?![a-z0-9_-])(?=[ \\t]|$)";
const HEADING_DECLARATION = new RegExp(`^ {0,3}#{1,6}[ \\t]+${NAMED_TAG}`);
const LIST_DECLARATION = new RegExp(`^ {0,3}(?:[-+*]|\\d{1,9}[.)])[ \\t]+${NAMED_TAG}`);
const TABLE_ROW_DECLARATION = new RegExp(`^ {0,3}\\|[ \\t]*${NAMED_TAG}`);
const PARAGRAPH_DECLARATION = new RegExp(`^ {0,3}${NAMED_TAG}`);
const REFERENCE_TAG = /\{§([a-z][a-z0-9-]*)\}(?![a-z0-9_-])/g;
const UNBRACED_NAMED_TAG = /§([A-Za-z][A-Za-z0-9_-]*)/g;
const AMBIGUOUS_ISSUE_SHORTHAND = /\b((?:plurnk-[a-z0-9-]+|service|svc|(?:grammar|schemes|mimetypes|providers|execs|embeddings|endpoint)(?:-[a-z0-9-]+)?)#\d+)\b/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)([^`]*?)\1/g;
const UNBRACED_SOURCE_EXTENSIONS = new Set([
    ".cjs", ".g4", ".js", ".jsx", ".md", ".mjs", ".mts", ".sh", ".sql",
    ".ts", ".tsx", ".yaml", ".yml",
]);

const locationOrder = (left, right) =>
    left.name.localeCompare(right.name)
    || left.line - right.line
    || left.tag.localeCompare(right.tag);

const mask = (text) => " ".repeat(text.length);
const maskSemanticCode = (text) => "x".repeat(text.length);

const maskInlineCode = (line) => line.replace(INLINE_CODE, maskSemanticCode);

const markdownLines = (name, text) => {
    if (path.extname(name).toLowerCase() !== ".md") {
        return text.split("\n").map((line, index) => ({ line, number: index + 1, ignored: false }));
    }

    let fence = null;
    return text.split("\n").map((line, index) => {
        const marker = line.match(FENCE)?.[1];
        if (marker !== undefined && (fence !== null || marker[0] !== "`"
            || !line.slice(line.indexOf(marker) + marker.length).includes("`"))) {
            if (fence === null) {
                fence = { character: marker[0], length: marker.length };
            } else if (
                marker[0] === fence.character
                && marker.length >= fence.length
                && line.slice(line.indexOf(marker) + marker.length).trim().length === 0
            ) {
                fence = null;
            }
            return { line: "", number: index + 1, ignored: true };
        }
        if (fence !== null || /^(?: {4}|\t)/.test(line)) {
            return { line: "", number: index + 1, ignored: true };
        }
        return { line: maskInlineCode(line), number: index + 1, ignored: false };
    });
};

const declarationIn = (line, paragraphStart) => {
    const structural = line.match(HEADING_DECLARATION)
        ?? line.match(LIST_DECLARATION)
        ?? line.match(TABLE_ROW_DECLARATION);
    if (structural !== null) return structural;
    return paragraphStart ? line.match(PARAGRAPH_DECLARATION) : null;
};

const checksUnbracedTags = (name) =>
    UNBRACED_SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())
    || path.basename(name).startsWith(".env");

const collectSpecTags = (files) => {
    const declarations = new Map();
    const references = [];
    const invalidTagUsages = [];
    const emptyDeclarations = [];

    for (const { name, text } of files) {
        const isSpec = path.basename(name) === "SPEC.md";
        const checksUnbraced = checksUnbracedTags(name);
        let paragraphOpen = false;
        let openDeclaration = null;
        const closeDeclaration = () => {
            if (openDeclaration !== null && !openDeclaration.hasContent) {
                const { line, tag } = openDeclaration;
                emptyDeclarations.push({ name, line, tag });
            }
            openDeclaration = null;
        };
        for (const { line, number, ignored } of markdownLines(name, text)) {
            if (ignored || line.trim().length === 0) {
                closeDeclaration();
                paragraphOpen = false;
                continue;
            }
            const heading = HEADING.test(line);
            const listItem = LIST_ITEM.test(line);
            const otherBlock = BLOCK_WITHOUT_DECLARATION.test(line);
            const paragraphStart = !paragraphOpen && !heading && !listItem && !otherBlock;
            if (heading || listItem || otherBlock || paragraphStart) closeDeclaration();
            const declaration = isSpec ? declarationIn(line, paragraphStart) : null;
            if (declaration !== null) {
                const tag = declaration[1];
                const locations = declarations.get(tag) ?? [];
                locations.push({ name, line: number });
                declarations.set(tag, locations);
                const remainder = line.slice(declaration.index + declaration[0].length);
                openDeclaration = {
                    line: number,
                    tag,
                    hasContent: remainder.replaceAll("|", "").trim().length > 0,
                };
            } else if (openDeclaration !== null) {
                openDeclaration.hasContent = true;
            }

            for (const match of line.matchAll(REFERENCE_TAG)) {
                references.push({ name, line: number, tag: match[1] });
            }

            const withoutReferences = line.replace(REFERENCE_TAG, mask);
            const declarationOffset = declaration?.index ?? -1;
            const declarationTag = declaration?.[1];
            const withoutDeclaration = declarationTag === undefined
                ? withoutReferences
                : [
                    withoutReferences.slice(0, declarationOffset),
                    withoutReferences.slice(declarationOffset).replace(
                        `§${declarationTag}`,
                        mask(`§${declarationTag}`),
                    ),
                ].join("");
            if (checksUnbraced) {
                for (const match of withoutDeclaration.matchAll(UNBRACED_NAMED_TAG)) {
                    invalidTagUsages.push({ name, line: number, tag: match[1] });
                }
            }

            paragraphOpen = !heading && !otherBlock;
        }
        closeDeclaration();
    }

    const duplicateDeclarations = [...declarations.entries()]
        .filter(([, locations]) => locations.length > 1)
        .map(([tag, locations]) => ({
            tag,
            declarations: locations.toSorted(locationOrder),
        }))
        .toSorted((left, right) => left.tag.localeCompare(right.tag));
    const unresolvedReferences = references
        .filter(({ tag }) => !declarations.has(tag))
        .toSorted(locationOrder);
    const ambiguousReferences = references
        .filter(({ tag }) => (declarations.get(tag)?.length ?? 0) > 1)
        .toSorted(locationOrder);

    return {
        declarations,
        references,
        verdicts: {
            duplicateDeclarations,
            unresolvedReferences,
            ambiguousReferences,
            invalidTagUsages: invalidTagUsages.toSorted(locationOrder),
            emptyDeclarations: emptyDeclarations.toSorted(locationOrder),
        },
    };
};

export const analyzeSpecReferences = (files) => collectSpecTags(files).verdicts;

// SPEC.md is documentation anchored to the implementation, the panels and the tests. An anchor that
// nothing outside prose cites is not doing that job: it is a principle in the wrong document
// (ARCHITECTURE.md lectures), orientation in the wrong document (AGENTS.md guides), or a contract
// nobody witnesses — and, cited by nothing, it rots without anything failing. Citing an anchor from
// a test that does not witness it is worse than leaving it here: this counts honesty, not tags.
const isProse = (name) => path.extname(name).toLowerCase() === ".md";

export const unwitnessedAnchors = (files) => {
    const { declarations, references } = collectSpecTags(files);
    const witnessed = new Set(references.filter(({ name }) => !isProse(name)).map(({ tag }) => tag));
    const bySpec = new Map();
    for (const [tag, locations] of declarations) {
        if (witnessed.has(tag)) continue;
        const { name } = locations[0];
        bySpec.set(name, [...(bySpec.get(name) ?? []), tag]);
    }
    return Object.fromEntries([...bySpec.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, tags]) => [name, tags.toSorted()]));
};

// The allowance only shrinks: an anchor is born witnessed, and one that gains a witness, moves to the
// document whose job it is, or is deleted must be struck in the same change.
export const witnessViolations = (files, allowance) => {
    const actual = unwitnessedAnchors(files);
    const violations = [];
    for (const [name, tags] of Object.entries(actual)) {
        const allowed = new Set(allowance[name] ?? []);
        for (const tag of tags) {
            if (!allowed.has(tag)) violations.push(`${name} §${tag} is cited by no implementation, panel or test`);
        }
    }
    for (const [name, tags] of Object.entries(allowance)) {
        const still = new Set(actual[name] ?? []);
        for (const tag of tags) {
            if (!still.has(tag)) violations.push(`${name} §${tag} is witnessed or gone; strike it from the allowance`);
        }
    }
    return violations.toSorted();
};

export const unresolvedSpecReferences = (files) =>
    analyzeSpecReferences(files).unresolvedReferences;

export const ambiguousIssueShorthands = (files) => files
    .flatMap(({ name, text }) => markdownLines(name, text)
        .filter(({ ignored }) => !ignored)
        .flatMap(({ line, number }) => [...line.matchAll(AMBIGUOUS_ISSUE_SHORTHAND)]
            .map((match) => ({ name, line: number, reference: match[1] }))))
    .toSorted((left, right) =>
        left.name.localeCompare(right.name)
        || left.line - right.line
        || left.reference.localeCompare(right.reference));

const repositoryFiles = async (root) => {
    const names = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
    ).split("\0").filter(Boolean);
    const files = [];
    for (const name of names) {
        let bytes;
        try {
            bytes = await fs.readFile(path.join(root, name));
        } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw error;
        }
        if (bytes.includes(0)) continue;
        files.push({ name, text: bytes.toString("utf8") });
    }
    return files;
};

const printLocations = (title, entries, render) => {
    if (entries.length === 0) return;
    console.error(`${title}:`);
    for (const entry of entries) console.error(`  ${render(entry)}`);
};

const main = async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const allowancePath = path.join(root, "scripts/spec-witness-allowance.json");
    const files = await repositoryFiles(root);
    if (process.argv.includes("--write")) {
        await fs.writeFile(allowancePath, `${JSON.stringify(unwitnessedAnchors(files), null, 4)}\n`);
    }
    const analysis = analyzeSpecReferences(files);
    const issueShorthands = ambiguousIssueShorthands(files);
    const allowance = JSON.parse(await fs.readFile(allowancePath, "utf8"));
    const unwitnessed = witnessViolations(files, allowance);
    const failed = Object.values(analysis).some((entries) => entries.length > 0)
        || issueShorthands.length > 0 || unwitnessed.length > 0;
    if (!failed) {
        const debt = Object.values(allowance).reduce((sum, tags) => sum + tags.length, 0);
        console.log(`spec references OK${debt === 0 ? "" : ` — ${debt} anchors await a witness or their proper document`}`);
        return;
    }
    printLocations("Anchors without a witness", unwitnessed, (violation) => violation);

    printLocations(
        "Duplicate specification-tag declarations",
        analysis.duplicateDeclarations,
        ({ tag, declarations }) => `${tag}: ${declarations.map(({ name, line }) => `${name}:${line}`).join(", ")}`,
    );
    printLocations(
        "Unresolved specification-tag citations",
        analysis.unresolvedReferences,
        ({ name, line, tag }) => `${name}:${line} {§${tag}}`,
    );
    printLocations(
        "Ambiguous specification-tag citations",
        analysis.ambiguousReferences,
        ({ name, line, tag }) => `${name}:${line} {§${tag}}`,
    );
    printLocations(
        "Invalid specification-tag usages (named tags must be lowercase kebab declarations or braced citations)",
        analysis.invalidTagUsages,
        ({ name, line, tag }) => `${name}:${line} §${tag}`,
    );
    printLocations(
        "Specification-tag declarations without an owning contract",
        analysis.emptyDeclarations,
        ({ name, line, tag }) => `${name}:${line} §${tag}`,
    );
    printLocations(
        "Ambiguous issue shorthands (use a current local #N, a specification tag, or a full URL)",
        issueShorthands,
        ({ name, line, reference }) => `${name}:${line} ${reference}`,
    );
    process.exitCode = 1;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
