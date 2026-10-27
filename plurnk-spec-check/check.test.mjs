import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { packRecords } from "../scripts/lib/npm-json.mjs";
import {
    ambiguousIssueShorthands,
    analyzeSpecReferences,
    unwitnessedAnchors,
    witnessViolations,
} from "./check.mjs";

const run = promisify(execFile);
const cite = (tag) => `{§${tag}}`;
const declare = (tag) => `§${tag}`;
const issueShorthand = (repository, number) => `${repository}#${number}`;

test("{§spec-check-tags} a repository issue shorthand is distinct from the valid citation forms", () => {
    const serviceReference = issueShorthand("plurnk-service", 240);
    const packageReference = issueShorthand("plurnk-mimetypes", 41);
    const files = [
        {
            name: "alpha/SPEC.md",
            text: [
                `${declare("current-law")} **Current law.**`,
                `The shorthand ${serviceReference} is ambiguous.`,
                `Inline code \`${packageReference}\` is an inert example.`,
                "```md",
                packageReference,
                "```",
                "Current local work #52 and https://github.com/plurnk/plurnk-service/issues/240 are explicit.",
            ].join("\n"),
        },
        {
            name: "src/code.ts",
            text: `// ${packageReference}; response#2 is an ordinary local label.`,
        },
    ];

    assert.deepEqual(ambiguousIssueShorthands(files), [
        { name: "alpha/SPEC.md", line: 2, reference: serviceReference },
        { name: "src/code.ts", line: 1, reference: packageReference },
    ]);
});

test("{§spec-check-tags} a qualified cross-repo citation is the correct form, not an ambiguous shorthand", () => {
    const bare = issueShorthand("plurnk-bench", 38);
    const files = [
        { name: "CHANGELOG.md", text: `- http: an operator host policy (plurnk/${bare})` },
        { name: "docs/a.md", text: `bare ${bare} has no owner` },
    ];
    assert.deepEqual(ambiguousIssueShorthands(files), [
        { name: "docs/a.md", line: 1, reference: bare },
    ], "owner/repo#N resolves; the bare shorthand does not");
});

test("{§spec-check-tags} the first semantic token of a SPEC heading, paragraph, list item, or table row declares a tag", () => {
    const files = [
        {
            name: "alpha/SPEC.md",
            text: [
                `### ${declare("one-owner")} First invariant`,
                "",
                `${declare("paragraph-owner")} **Second invariant.** Its continuation may cite`,
                `${cite("list-owner")} without declaring it again.`,
                "",
                `- ${declare("list-owner")} **Third invariant.**`,
                "",
                "| Contract | Meaning |",
                "|---|---|",
                `| ${declare("row-owner")} one | The row owns its invariant. |`,
            ].join("\n"),
        },
        {
            name: "beta/SPEC.md",
            text: `${declare("cross-package-owner")} **Cross-package invariant.** It cites ${cite("one-owner")}.`,
        },
        { name: "alpha/code.ts", text: `// ${cite("one-owner")} ${cite("paragraph-owner")} ${cite("row-owner")}` },
    ];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [],
        emptyDeclarations: [],
    });
});

test("{§spec-check-tags} duplicate declarations and every ambiguous citation report all locations", () => {
    const files = [
        { name: "alpha/SPEC.md", text: `### ${declare("one-owner")} First` },
        { name: "beta/SPEC.md", text: `## ${declare("one-owner")} Second` },
        { name: "src/code.ts", text: `// ${cite("one-owner")}` },
    ];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [{
            tag: "one-owner",
            declarations: [
                { name: "alpha/SPEC.md", line: 1 },
                { name: "beta/SPEC.md", line: 1 },
            ],
        }],
        unresolvedReferences: [],
        ambiguousReferences: [{ name: "src/code.ts", line: 1, tag: "one-owner" }],
        invalidTagUsages: [],
        emptyDeclarations: [],
    });
});

test("{§spec-check-tags} unresolved citations are checked inside and outside specifications", () => {
    const files = [
        {
            name: "alpha/SPEC.md",
            text: [
                `### ${declare("known")} Stable`,
                `Missing here: ${cite("missing-in-spec")}.`,
            ].join("\n"),
        },
        {
            name: "src/code.ts",
            text: [
                `// ${cite("known")}`,
                `// ${cite("missing-in-code")}`,
            ].join("\n"),
        },
    ];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [
            { name: "alpha/SPEC.md", line: 2, tag: "missing-in-spec" },
            { name: "src/code.ts", line: 2, tag: "missing-in-code" },
        ],
        ambiguousReferences: [],
        invalidTagUsages: [],
        emptyDeclarations: [],
    });
});

test("{§spec-check-tags} an unbraced named tag outside a declaration position is invalid", () => {
    const files = [
        {
            name: "alpha/SPEC.md",
            text: [
                `### ${declare("declared")} Stable`,
                `Ordinary ${declare("declared")} is not a citation.`,
                `### Heading ${declare("late-tag")}`,
                "",
                "A paragraph begins here",
                `${declare("late-paragraph")} is not its first semantic token.`,
                "",
                `- A list item with ${declare("late-list")} later in it.`,
                "",
                `| a cell | Later ${declare("late-table")} is not a declaration. |`,
                "```md",
                `### ${declare("example-in-fence")} Not a declaration`,
                "```",
                "Numbered section references such as §3 and §3.bis remain presentation.",
            ].join("\n"),
        },
        { name: "README.md", text: `### ${declare("outside-spec")} Not a declaration` },
    ];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [
            { name: "alpha/SPEC.md", line: 2, tag: "declared" },
            { name: "alpha/SPEC.md", line: 3, tag: "late-tag" },
            { name: "alpha/SPEC.md", line: 6, tag: "late-paragraph" },
            { name: "alpha/SPEC.md", line: 8, tag: "late-list" },
            { name: "alpha/SPEC.md", line: 10, tag: "late-table" },
            { name: "README.md", line: 1, tag: "outside-spec" },
        ],
        emptyDeclarations: [],
    });
});

test("{§spec-check-tags} malformed named tags report the complete token instead of a valid prefix", () => {
    const files = [{
        name: "alpha/SPEC.md",
        text: [
            `${declare("real-owner")} **Real invariant.**`,
            `A camel-case typo ${declare("isProposal")} must not be truncated to its lowercase prefix.`,
            `An underscore typo {${declare("old_anchor")}} is not a citation.`,
            `An uppercase typo ${declare("Imperatives")} is not a named contract tag.`,
            "Numeric presentation §3 and §3.bis remains outside the named-tag syntax.",
        ].join("\n"),
    }];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [
            { name: "alpha/SPEC.md", line: 2, tag: "isProposal" },
            { name: "alpha/SPEC.md", line: 3, tag: "old_anchor" },
            { name: "alpha/SPEC.md", line: 4, tag: "Imperatives" },
        ],
        emptyDeclarations: [],
    });
});

test("{§spec-check-tags} a heading-looking line in a fenced block does not declare a tag", () => {
    const files = [{
        name: "alpha/SPEC.md",
        text: [
            "```md",
            `### ${declare("not-real")} Example`,
            "```",
            cite("not-real"),
        ].join("\n"),
    }];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [{ name: "alpha/SPEC.md", line: 4, tag: "not-real" }],
        ambiguousReferences: [],
        invalidTagUsages: [],
        emptyDeclarations: [],
    });
});

test("{§spec-check-tags} a backtick code span at column zero does not hide subsequent declarations", () => {
    const files = [{ name: "alpha/SPEC.md", text: [
        "```READ (notes.md)```",
        "",
        `${declare("after-span")} The following contract remains visible.`,
        "",
        cite("after-span"),
    ].join("\n") }];
    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [], unresolvedReferences: [], ambiguousReferences: [],
        invalidTagUsages: [], emptyDeclarations: [],
    });
});

test("{§spec-check-tags} inline and indented code neither declare nor cite tags", () => {
    const files = [{
        name: "alpha/SPEC.md",
        text: [
            `${declare("real-owner")} **Real invariant.**`,
            `Inline \`${cite("missing-inline")} ${declare("not-a-declaration")}\` is inert.`,
            `\`code\` ${declare("late-after-code")} is not a paragraph declaration.`,
            `### \`code\` ${declare("late-heading-code")} is not a heading declaration.`,
            `- \`code\` ${declare("late-list-code")} is not a list declaration.`,
            `| \`code\` ${declare("late-table-code")} | is not a table declaration. |`,
            "",
            `    ${cite("missing-indented")} ${declare("also-not-a-declaration")}`,
            `Outside code ${cite("real-owner")} resolves.`,
        ].join("\n"),
    }];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [
            { name: "alpha/SPEC.md", line: 3, tag: "late-after-code" },
            { name: "alpha/SPEC.md", line: 4, tag: "late-heading-code" },
            { name: "alpha/SPEC.md", line: 5, tag: "late-list-code" },
            { name: "alpha/SPEC.md", line: 6, tag: "late-table-code" },
        ],
        emptyDeclarations: [],
    });
});

test("{§spec-check-tags} a declaration owns contract text in the same Markdown block", () => {
    const files = [{
        name: "alpha/SPEC.md",
        text: [
            declare("empty-heading"),
            "",
            `### ${declare("empty-heading-two")}`,
            "",
            `- ${declare("continued-list")}`,
            "  The list item's contract continues here.",
            "",
            declare("continued-paragraph"),
            "The paragraph's contract continues here.",
        ].join("\n"),
    }];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [],
        emptyDeclarations: [
            { name: "alpha/SPEC.md", line: 1, tag: "empty-heading" },
            { name: "alpha/SPEC.md", line: 3, tag: "empty-heading-two" },
        ],
    });
});

test("{§spec-check-tags} an anchor is witnessed by the implementation, a panel or a test — prose citing prose is not a witness", () => {
    const files = [
        { name: "alpha/SPEC.md", text: [
            `${declare("held")} **A contract a test holds.**`,
            "",
            `${declare("configured")} **A contract a panel states.**`,
            "",
            `${declare("lectured")} **A principle only other prose mentions.** See ${cite("held")}.`,
            "",
            `${declare("forgotten")} **Nothing mentions this at all.**`,
        ].join("\n") },
        { name: "alpha/src/thing.test.ts", text: `// ${cite("held")} it holds` },
        { name: "alpha/.env.defaults", text: `# ${cite("configured")}\nPLURNK_X=1\n` },
        { name: "ARCHITECTURE.md", text: `The lecture cites ${cite("lectured")}.` },
    ];
    assert.deepEqual(unwitnessedAnchors(files), { "alpha/SPEC.md": ["forgotten", "lectured"] });
});

test("{§spec-check-tags} the witness allowance only shrinks", () => {
    const files = [
        { name: "alpha/SPEC.md", text: `${declare("old-debt")} **Known debt.**\n\n${declare("new-debt")} **Born unwitnessed.**\n\n${declare("paid")} **Now held.**` },
        { name: "alpha/src/paid.test.ts", text: `// ${cite("paid")}` },
    ];
    assert.deepEqual(witnessViolations(files, { "alpha/SPEC.md": ["new-debt", "old-debt"] }), []);
    assert.deepEqual(
        witnessViolations(files, { "alpha/SPEC.md": ["old-debt"] }),
        [`alpha/SPEC.md ${declare("new-debt")} is cited by no implementation, panel or test`],
    );
    assert.deepEqual(
        witnessViolations(files, { "alpha/SPEC.md": ["new-debt", "old-debt", "paid"], "gone/SPEC.md": ["moved"] }),
        [`alpha/SPEC.md ${declare("paid")} is witnessed or gone; strike it from the allowance`, `gone/SPEC.md ${declare("moved")} is witnessed or gone; strike it from the allowance`],
    );
});

test("{§spec-check-cli} packed CLI checks only the selected consumer tree", { timeout: 60_000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "plurnk-spec-check-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const consumer = path.join(directory, "consumer");
    const source = path.join(directory, "source");
    await mkdir(consumer);
    await mkdir(source);
    const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: import.meta.dirname });
    const [archive] = packRecords(stdout);
    assert.ok(archive.files.some(({ path: name }) => name === "check.mjs"));
    assert.ok(!archive.files.some(({ path: name }) => name.endsWith(".test.mjs")));
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "spec-check-consumer", private: true }));
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(directory, archive.filename)], { cwd: consumer });
    const installed = JSON.parse(await readFile(path.join(consumer, "node_modules/@plurnk/plurnk-spec-check/package.json"), "utf8"));
    assert.equal(installed.dependencies, undefined, "the CLI has no runtime dependencies");
    const bin = path.join(consumer, "node_modules/.bin/plurnk-spec-check");
    const check = (args = [source], cwd = consumer) => run(bin, args, { cwd });
    const fails = async (args, expected) => assert.rejects(check(args), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, expected);
        return true;
    });
    await run("git", ["init", "--quiet"], { cwd: source });
    const spec = `# ${declare("fixture-contract")} One real contract\n`;
    const specPath = path.join(source, "SPEC.md");
    const witnessPath = path.join(source, "witness.js");
    await writeFile(specPath, spec);
    await writeFile(witnessPath, `// ${cite("fixture-contract")}\n`);
    await writeFile(path.join(source, "removed.md"), "tracked but deleted\n");
    await run("git", ["add", "SPEC.md", "witness.js", "removed.md"], { cwd: source });
    await rm(path.join(source, "removed.md"));
    await writeFile(path.join(source, ".gitignore"), "generated/\n");
    await mkdir(path.join(source, "generated"));
    await writeFile(path.join(source, "generated/ignored.md"), cite("not-real"));
    await writeFile(path.join(source, "binary.js"), `\0${cite("not-real")}`);
    await writeFile(path.join(directory, "outside.md"), cite("not-real"));
    await symlink(path.join(directory, "outside.md"), path.join(source, "linked.md"));

    await t.test("{§spec-check-cli} explicit directory, current directory and help", async () => {
        assert.match((await check()).stdout, /spec references OK/u);
        assert.match((await check([], source)).stdout, /spec references OK/u);
        assert.match((await check(["--help"])).stdout, /^Usage: plurnk-spec-check/u);
        await fails(["--unknown"], /Unknown option/u);
        await fails([source, consumer], /Expected at most one source directory/u);
        await fails([source, "--write"], /--write requires --allowance/u);
    });

    await t.test("{§spec-check-tags} malformed, missing and duplicate tags fail with locations", async () => {
        const cases = [
            [spec, `// ${cite("missing")}\n`, new RegExp(`witness\\.js:1 \\{${declare("missing")}\\}`, "u")],
            [`${spec}\n${spec}`, `// ${cite("fixture-contract")}\n`, /fixture-contract: SPEC\.md:1, SPEC\.md:3/u],
            [spec, `// ${declare("bad_tag")}\n`, new RegExp(`witness\\.js:1 ${declare("bad_tag")}`, "u")],
        ];
        for (const [text, witness, diagnostic] of cases) {
            await writeFile(specPath, text);
            await writeFile(witnessPath, witness);
            await fails([source], diagnostic);
        }
        await writeFile(specPath, spec);
        await writeFile(witnessPath, `// ${cite("fixture-contract")}\n`);
    });

    await t.test("{§spec-check-cli} untracked source participates", async () => {
        const extra = path.join(source, "untracked.js");
        await writeFile(extra, `// ${cite("untracked-missing")}\n`);
        await fails([source], /untracked\.js:1/u);
        await rm(extra);
    });

    await t.test("{§spec-check-tags} allowances are explicit, validated and never silently rewritten", async () => {
        await writeFile(witnessPath, "// No citation.\n");
        await fails([source], /fixture-contract is cited by no implementation/u);
        const allowance = path.join(source, "allowance.json");
        const text = JSON.stringify({ "SPEC.md": ["fixture-contract"] });
        await writeFile(allowance, text);
        await fails([source], /fixture-contract is cited by no implementation/u);
        assert.match((await check([source, "--allowance", "allowance.json"])).stdout, /1 anchors await/u);
        assert.equal(await readFile(allowance, "utf8"), text);
        await writeFile(witnessPath, `// ${cite("fixture-contract")}\n`);
        await fails([source, "--allowance", "allowance.json"], /is witnessed or gone; strike it from the allowance/u);
        assert.equal(await readFile(allowance, "utf8"), text);
        assert.match((await check([source, "--allowance", "allowance.json", "--write"])).stdout, /spec references OK/u);
        assert.deepEqual(JSON.parse(await readFile(allowance, "utf8")), {});
        for (const value of [null, [], { "SPEC.md": "fixture-contract" }, { "SPEC.md": [1] }]) {
            await writeFile(allowance, JSON.stringify(value));
            await fails([source, "--allowance", "allowance.json"], /Witness allowance must map/u);
        }
        await fails([source, "--allowance", "missing.json"], /ENOENT/u);
    });

    assert.equal(await readFile(specPath, "utf8"), spec, "checking never modifies the contract");
});
