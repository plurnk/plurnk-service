#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

const HEADING = /^ {0,3}#{1,6}[ \t]+/;
const NAMED_TAG = "§([a-z][a-z0-9-]*)(?![a-z0-9_-])(?=[ \\t]|$)";
const HEADING_DECLARATION = new RegExp(`^ {0,3}#{1,6}[ \\t]+${NAMED_TAG}`);
const REFERENCE_TAG = /\{§([a-z][a-z0-9-]*)\}(?![a-z0-9_-])/g;
const UNBRACED_NAMED_TAG = /§([A-Za-z][A-Za-z0-9_-]*)/g;
// A repository's issue abbreviated to `plurnk-x#N` names no host. An owner-qualified citation
// (`plurnk/plurnk-bench#38`) is not a shorthand: the lookbehind keeps the match from starting
// after the owner's slash.
const AMBIGUOUS_ISSUE_SHORTHAND = /(?<![\w/-])(plurnk(?:-[a-z0-9-]+)?#\d+)\b/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)([^`]*?)\1/g;
const UNBRACED_SOURCE_EXTENSIONS = new Set([
    ".cjs", ".g4", ".js", ".jsx", ".md", ".mjs", ".mts", ".sh", ".sql",
    ".ts", ".tsx", ".yaml", ".yml",
]);
const DETERMINISTIC_TEST_FILE = /\.test\.(?:[cm]?[jt]sx?)$/i;
const LIVE_OR_TERM_TEST_PATH = /(?:^|\/)(?:tiers\/(?:live|demo)|test\/(?:live|demo|term))\//;
const TEST_CALL = /^[ \t]*(?:await[ \t]+)?(?:[A-Za-z_$][\w$]*\.)?(?:test|it)\s*\(\s*(`(?:\\[\s\S]|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,/gm;

const locationOrder = (left, right) =>
    left.name.localeCompare(right.name)
    || left.line - right.line
    || (left.tag ?? "").localeCompare(right.tag ?? "");

const mask = (text) => " ".repeat(text.length);
const maskSemanticCode = (text) => "x".repeat(text.length);

const maskInlineCode = (line) => line.replace(INLINE_CODE, maskSemanticCode);

const markdownLines = (name, text) => {
    if (path.extname(name).toLowerCase() !== ".md") {
        return text.split("\n").map((line, index) => ({
            line,
            number: index + 1,
            ignored: false,
            hasText: line.trim().length > 0,
        }));
    }

    let fence = null;
    return text.split("\n").map((line, index) => {
        const hasText = line.trim().length > 0;
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
            return { line: "", number: index + 1, ignored: true, hasText };
        }
        if (fence !== null || /^(?: {4}|\t)/.test(line)) {
            return { line: "", number: index + 1, ignored: true, hasText };
        }
        return { line: maskInlineCode(line), number: index + 1, ignored: false, hasText };
    });
};

const declarationIn = (line) => line.match(HEADING_DECLARATION);

const checksUnbracedTags = (name) =>
    UNBRACED_SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())
    || path.basename(name).startsWith(".env");

const collectImportedDeclarations = (importedSpecs) => {
    const importedDeclarations = new Map();
    for (const { name, text } of importedSpecs) {
        for (const { line, number, ignored } of markdownLines(name, text)) {
            if (ignored || !HEADING.test(line)) continue;
            const declaration = declarationIn(line);
            if (declaration === null) continue;
            const tag = declaration[1];
            const locations = importedDeclarations.get(tag) ?? [];
            locations.push({ name, line: number });
            importedDeclarations.set(tag, locations);
        }
    }
    return importedDeclarations;
};

const matchesWitnessSelector = (tag, selectors) =>
    selectors.some((selector) =>
        selector.endsWith("-") ? tag.startsWith(selector) : tag === selector,
    );

const collectSpecTags = (files, importedSpecs = []) => {
    const declarations = new Map();
    const references = [];
    const invalidTagUsages = [];
    const emptyDeclarations = [];

    for (const { name, text } of files) {
        if (path.basename(name) === "CHANGELOG.md") continue;
        const isSpec = path.basename(name) === "SPEC.md";
        const checksUnbraced = checksUnbracedTags(name);
        let openDeclaration = null;
        const closeDeclaration = () => {
            if (openDeclaration !== null && (!openDeclaration.hasTitle || !openDeclaration.hasBody)) {
                const { line, tag } = openDeclaration;
                emptyDeclarations.push({ name, line, tag });
            }
            openDeclaration = null;
        };
        for (const { line, number, ignored, hasText } of markdownLines(name, text)) {
            const heading = !ignored && HEADING.test(line);
            if (heading) closeDeclaration();
            else if (openDeclaration !== null && hasText) openDeclaration.hasBody = true;
            if (ignored || line.trim().length === 0) continue;
            const declaration = isSpec && heading ? declarationIn(line) : null;
            if (declaration !== null) {
                const tag = declaration[1];
                const locations = declarations.get(tag) ?? [];
                locations.push({ name, line: number });
                declarations.set(tag, locations);
                const remainder = line.slice(declaration.index + declaration[0].length);
                openDeclaration = {
                    line: number,
                    tag,
                    hasTitle: remainder.replaceAll("|", "").trim().length > 0,
                    hasBody: false,
                };
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
        }
        closeDeclaration();
    }

    const importedDeclarations = collectImportedDeclarations(importedSpecs);
    const allDeclarations = new Map(declarations);
    for (const [tag, locations] of importedDeclarations) {
        allDeclarations.set(tag, [...(allDeclarations.get(tag) ?? []), ...locations]);
    }

    const duplicateDeclarations = [...allDeclarations.entries()]
        .filter(([, locations]) => locations.length > 1)
        .map(([tag, locations]) => ({
            tag,
            declarations: locations.toSorted(locationOrder),
        }))
        .toSorted((left, right) => left.tag.localeCompare(right.tag));
    const unresolvedReferences = references
        .filter(({ tag }) => !allDeclarations.has(tag))
        .toSorted(locationOrder);
    const ambiguousReferences = references
        .filter(({ tag }) => (allDeclarations.get(tag)?.length ?? 0) > 1)
        .toSorted(locationOrder);

    return {
        declarations,
        importedDeclarations,
        allDeclarations,
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

export const analyzeSpecReferences = (files, options = {}) =>
    collectSpecTags(files, options.importedSpecs ?? []).verdicts;

const isProse = (name) => path.extname(name).toLowerCase() === ".md";
const isTest = (name) =>
    DETERMINISTIC_TEST_FILE.test(name) || /(?:^|\/)test\//.test(name);

export const unwitnessedAnchors = (files, options = {}) => {
    const { declarations, importedDeclarations, references } = collectSpecTags(
        files,
        options.importedSpecs ?? [],
    );
    const witnessSelectors = options.witness ?? [];
    const implWitnessed = new Set(
        references.filter(({ name }) => !isProse(name) && !isTest(name)).map(({ tag }) => tag),
    );
    const testWitnessed = new Set(
        references.filter(({ name }) => isTest(name)).map(({ tag }) => tag),
    );
    const bySpec = new Map();
    const recordIfUnwitnessed = (tag, locations) => {
        if (implWitnessed.has(tag) && testWitnessed.has(tag)) return;
        const { name } = locations[0];
        bySpec.set(name, [...(bySpec.get(name) ?? []), tag]);
    };
    for (const [tag, locations] of declarations) {
        recordIfUnwitnessed(tag, locations);
    }
    if (witnessSelectors.length > 0) {
        for (const [tag, locations] of importedDeclarations) {
            if (!matchesWitnessSelector(tag, witnessSelectors)) continue;
            recordIfUnwitnessed(tag, locations);
        }
    }
    return Object.fromEntries([...bySpec.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, tags]) => [name, tags.toSorted()]));
};

// The allowance only shrinks: an anchor is born with both an implementation/panel witness and a
// test witness, and one that gains its witnesses or is deleted must be struck in the same change.
export const witnessViolations = (files, allowance, options = {}) => {
    const actual = unwitnessedAnchors(files, options);
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

export const untaggedTests = (files) => {
    const violations = [];
    for (const { name, text } of files) {
        if (!DETERMINISTIC_TEST_FILE.test(name) || LIVE_OR_TERM_TEST_PATH.test(name)) continue;
        for (const match of text.matchAll(TEST_CALL)) {
            const literal = match[1] ?? "";
            if ([...literal.matchAll(REFERENCE_TAG)].length > 0) continue;
            const line = text.slice(0, match.index ?? 0).split("\n").length;
            const title = literal.slice(1, -1).replace(/\s+/g, " ").slice(0, 100);
            violations.push({ name, line, title });
        }
    }
    return violations.toSorted((left, right) =>
        left.name.localeCompare(right.name)
        || left.line - right.line
        || left.title.localeCompare(right.title));
};

export const unresolvedSpecReferences = (files, options = {}) =>
    analyzeSpecReferences(files, options).unresolvedReferences;

export const ambiguousIssueShorthands = (files) => files
    .flatMap(({ name, text }) => markdownLines(name, text)
        .filter(({ ignored }) => !ignored)
        .flatMap(({ line, number }) => [...line.matchAll(AMBIGUOUS_ISSUE_SHORTHAND)]
            .map((match) => ({ name, line: number, reference: match[1] }))))
    .toSorted((left, right) =>
        left.name.localeCompare(right.name)
        || left.line - right.line
        || left.reference.localeCompare(right.reference));

export const resolveImportedSpecs = async (root, specifiers = []) => {
    if (specifiers.length === 0) return [];
    const req = createRequire(path.join(root, "package.json"));
    const specs = [];
    const seen = new Set();
    for (const specifier of specifiers) {
        const isPathLike =
            specifier.endsWith(".md")
            || specifier.startsWith("./")
            || specifier.startsWith("../")
            || path.isAbsolute(specifier);
        let filePath;
        let label;
        if (isPathLike) {
            const candidate = path.resolve(root, specifier);
            const stat = await fs.stat(candidate);
            filePath = stat.isDirectory() ? path.join(candidate, "SPEC.md") : candidate;
            label = path.relative(root, filePath).replaceAll(path.sep, "/");
        } else {
            const pkgJsonPath = req.resolve(`${specifier}/package.json`);
            filePath = path.join(path.dirname(pkgJsonPath), "SPEC.md");
            label = `${specifier}/SPEC.md`;
        }
        const real = await fs.realpath(filePath);
        if (seen.has(real)) continue;
        seen.add(real);
        specs.push({ name: label, text: await fs.readFile(filePath, "utf8") });
    }
    return specs;
};

const repositoryFiles = async (root) => {
    const names = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
    ).split("\0").filter(Boolean);
    const files = [];
    for (const name of names) {
        const file = path.join(root, name);
        let bytes;
        try {
            // A link's target is scanned under its own path, or it is not repository content.
            if ((await fs.lstat(file)).isSymbolicLink()) continue;
            bytes = await fs.readFile(file);
        } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw error;
        }
        if (bytes.includes(0)) continue;
        files.push({ name, text: bytes.toString("utf8") });
    }
    return files;
};

const printLocations = (stderr, title, entries, render) => {
    if (entries.length === 0) return;
    stderr(`${title}:`);
    for (const entry of entries) stderr(`  ${render(entry)}`);
};

export const USAGE =
    "Usage: plurnk-spec-check [directory] [--import pkg-or-path] [--witness prefix-or-tag] [--allowance file] [--write]";

export const runSpecCheck = async (
    argv,
    { cwd = process.cwd(), stdout = console.log, stderr = console.error } = {},
) => {
    // {§spec-check-cli} {§spec-check-tags} The consumer owns its source tree and any existing debt.
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            allowance: { type: "string" },
            import: { type: "string", multiple: true },
            witness: { type: "string", multiple: true },
            write: { type: "boolean" },
            help: { type: "boolean" },
        },
    });
    if (values.help) {
        stdout(USAGE);
        return { exitCode: 0 };
    }
    if (positionals.length > 1) throw new Error("Expected at most one source directory");
    if (values.write && values.allowance === undefined) throw new Error("--write requires --allowance");
    const root = path.resolve(cwd, positionals[0] ?? ".");
    const allowancePath = values.allowance === undefined ? null : path.resolve(root, values.allowance);
    const [files, importedSpecs] = await Promise.all([
        repositoryFiles(root),
        resolveImportedSpecs(root, values.import ?? []),
    ]);
    const witnessOptions = { importedSpecs, witness: values.witness ?? [] };
    if (values.write) {
        await fs.writeFile(
            allowancePath,
            `${JSON.stringify(unwitnessedAnchors(files, witnessOptions), null, 4)}\n`,
        );
    }
    const analysis = analyzeSpecReferences(files, { importedSpecs });
    const issueShorthands = ambiguousIssueShorthands(files);
    const untagged = untaggedTests(files);
    const allowance = allowancePath === null ? {} : JSON.parse(await fs.readFile(allowancePath, "utf8"));
    if (allowance === null || Array.isArray(allowance) || typeof allowance !== "object"
        || Object.values(allowance).some((tags) => !Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))) {
        throw new Error("Witness allowance must map specification paths to arrays of tag names");
    }
    const unwitnessed = witnessViolations(files, allowance, witnessOptions);
    const failed = Object.values(analysis).some((entries) => entries.length > 0)
        || issueShorthands.length > 0 || unwitnessed.length > 0 || untagged.length > 0;
    if (!failed) {
        const debt = Object.values(allowance).reduce((sum, tags) => sum + tags.length, 0);
        stdout(`spec references OK${debt === 0 ? "" : ` — ${debt} anchors await a witness or their proper document`}`);
        return { exitCode: 0 };
    }
    printLocations(stderr, "Anchors without a witness", unwitnessed, (violation) => violation);
    printLocations(
        stderr,
        "Duplicate specification-tag declarations",
        analysis.duplicateDeclarations,
        ({ tag, declarations }) => `${tag}: ${declarations.map(({ name, line }) => `${name}:${line}`).join(", ")}`,
    );
    printLocations(
        stderr,
        "Unresolved specification-tag citations",
        analysis.unresolvedReferences,
        ({ name, line, tag }) => `${name}:${line} {§${tag}}`,
    );
    printLocations(
        stderr,
        "Ambiguous specification-tag citations",
        analysis.ambiguousReferences,
        ({ name, line, tag }) => `${name}:${line} {§${tag}}`,
    );
    printLocations(
        stderr,
        "Invalid specification-tag usages (named tags must be lowercase kebab declarations or braced citations)",
        analysis.invalidTagUsages,
        ({ name, line, tag }) => `${name}:${line} §${tag}`,
    );
    printLocations(
        stderr,
        "Specification-tag declarations without an owning contract",
        analysis.emptyDeclarations,
        ({ name, line, tag }) => `${name}:${line} §${tag}`,
    );
    printLocations(
        stderr,
        "Deterministic test blocks without a specification-tag citation",
        untagged,
        ({ name, line, title }) => `${name}:${line} ${title}`,
    );
    printLocations(
        stderr,
        "Ambiguous issue shorthands (use a current local #N, a specification tag, or a full URL)",
        issueShorthands,
        ({ name, line, reference }) => `${name}:${line} ${reference}`,
    );
    return { exitCode: 1 };
};

/* c8 ignore next 4 */
if (import.meta.main) {
    const { exitCode } = await runSpecCheck(process.argv.slice(2));
    if (exitCode !== 0) process.exitCode = exitCode;
}
