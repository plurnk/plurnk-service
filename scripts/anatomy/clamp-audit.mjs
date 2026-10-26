#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const SERVICE_ROOT = path.resolve(import.meta.dirname, "../..");
const CLIENT_ROOT = path.resolve(process.env.PLURNK_CLIENT_CHECKOUT ?? path.join(SERVICE_ROOT, "../plurnk"));
const BENCH_ROOT = path.resolve(process.env.PLURNK_BENCH_ROOT ?? path.join(SERVICE_ROOT, "../plurnk-bench"));
const LEDGER_PATH = path.join(import.meta.dirname, "clamp-ledger.json");

const SEC = "\u00a7";
const NAMED_TAG = `${SEC}([a-z][a-z0-9-]*)(?![a-z0-9_-])(?=[ \\t]|$)`;
const HEADING_DECL = new RegExp(`^ {0,3}#{1,6}[ \\t]+${NAMED_TAG}`);
const LIST_DECL = new RegExp(`^ {0,3}(?:[-+*]|\\d{1,9}[.)])[ \\t]+${NAMED_TAG}`);
const TABLE_DECL = new RegExp(`^ {0,3}\\|[ \\t]*${NAMED_TAG}`);
const PARA_DECL = new RegExp(`^ {0,3}${NAMED_TAG}`);
const REF_TAG = new RegExp(`\\{${SEC}([a-z][a-z0-9-]*)\\}(?![a-z0-9_-])`, "g");
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_RE = /(`+)([^`]*?)\1/g;

const VALID_TAG_DISPOSITIONS = new Set([
    "keep-heading",
    "fold-into",
    "move-to-doc",
    "purge:tombstone",
    "purge:pinned-wording",
    "purge:problem-table",
    "purge:internal-diary",
    "purge:duplicate",
    "purge:retired-shim",
]);

const VALID_TEST_DISPOSITIONS = new Set([
    "keep-suite",
    "merge-into",
    "demote-to-unit",
    "purge:tombstone",
    "purge:pinned-wording",
    "purge:duplicate",
    "purge:retired-shim",
    "purge:ceremony",
]);

const WORK_UNITS = [
    {
        id: "scripts-tooling",
        repo: "plurnk-service",
        title: "Repo Tooling & Spec Checker (scripts/ & plurnk-spec-check/)",
        specs: [{ file: "scripts/SPEC.md" }, { file: "plurnk-spec-check/SPEC.md" }],
        testPrefixes: ["scripts/", "plurnk-spec-check/"],
        budgets: { minHeadingTags: 6, maxHeadingTags: 12, maxSpecLines: 160, maxUnitFiles: 8, maxIntgFiles: 0 },
    },
    {
        id: "contracts-and-parser",
        repo: "plurnk-service",
        title: "Language Contract, Schemas & ANTLR Parser (plurnk-contracts & plurnk-parser)",
        specs: [{ file: "plurnk-contracts/SPEC.md" }, { file: "plurnk-parser/SPEC.md" }],
        testPrefixes: ["plurnk-contracts/", "plurnk-parser/"],
        extraTests: [
            "plurnk-core/test/intg/matcher-refusal.test.ts",
            "plurnk-core/test/intg/mcp-json-body.test.ts",
            "plurnk-core/test/intg/nested-program-bodies.test.ts",
            "plurnk-core/test/intg/path-decode.test.ts",
        ],
        budgets: { minHeadingTags: 12, maxHeadingTags: 28, maxSpecLines: 760, maxUnitFiles: 14, maxIntgFiles: 6 },
    },
    {
        id: "providers-and-models",
        repo: "plurnk-service",
        title: "Providers (pi-ai native de-shimming), Models & Aliases",
        specs: [
            { file: "plurnk-providers/SPEC.md" },
            { file: "plurnk-models/SPEC.md" },
            { file: "plurnk-aliases/SPEC.md" },
        ],
        testPrefixes: ["plurnk-providers/", "plurnk-models/", "plurnk-aliases/"],
        extraTests: ["plurnk-core/test/intg/inference-admission.test.ts"],
        budgets: { minHeadingTags: 10, maxHeadingTags: 22, maxSpecLines: 500, maxUnitFiles: 14, maxIntgFiles: 0 },
    },
    {
        id: "schemes-and-http",
        repo: "plurnk-service",
        title: "Scheme SDK & HTTP/WS Schemes (plurnk-schemes & plurnk-schemes-http)",
        specs: [{ file: "plurnk-schemes/SPEC.md" }, { file: "plurnk-schemes-http/SPEC.md" }],
        testPrefixes: ["plurnk-schemes/", "plurnk-schemes-http/"],
        extraTests: [
            "plurnk-core/test/intg/KILL.scheme.test.ts",
            "plurnk-core/test/intg/ambient-http-proxy.test.ts",
            "plurnk-core/test/intg/http-native-media.test.ts",
            "plurnk-core/test/intg/range-recovery.test.ts",
            "plurnk-core/test/intg/resource-tree.test.ts",
        ],
        budgets: { minHeadingTags: 10, maxHeadingTags: 22, maxSpecLines: 520, maxUnitFiles: 12, maxIntgFiles: 2 },
    },
    {
        id: "execs-and-mcp",
        repo: "plurnk-service",
        title: "Execution Runtimes & MCP Subsystem (plurnk-execs, plurnk-execs-common, plurnk-mcp)",
        specs: [{ file: "plurnk-execs/SPEC.md" }, { file: "plurnk-mcp/SPEC.md" }],
        testPrefixes: ["plurnk-execs/", "plurnk-execs-common/", "plurnk-mcp/"],
        extraTests: [
            "plurnk-core/test/intg/Daemon.executor-spelling.test.ts",
            "plurnk-core/test/intg/executor-defaults.test.ts",
            "plurnk-core/test/intg/mcp-interaction-composition.test.ts",
            "plurnk-core/test/intg/mcp-plugin-composition.test.ts",
        ],
        budgets: { minHeadingTags: 14, maxHeadingTags: 28, maxSpecLines: 620, maxUnitFiles: 14, maxIntgFiles: 3 },
    },
    {
        id: "mimetypes-and-leafs",
        repo: "plurnk-service",
        title: "Mimetypes Framework & Leaf Mimetype Extensions (plurnk-mimetypes*)",
        specs: [
            { file: "plurnk-mimetypes/SPEC.md" },
            { file: "plurnk-mimetypes-application-ipynb/SPEC.md" },
            { file: "plurnk-mimetypes-application-json/SPEC.md" },
            { file: "plurnk-mimetypes-application-jsonl/SPEC.md" },
            { file: "plurnk-mimetypes-application-pdf/SPEC.md" },
            { file: "plurnk-mimetypes-application-xml/SPEC.md" },
            { file: "plurnk-mimetypes-text-csv/SPEC.md" },
            { file: "plurnk-mimetypes-text-diff/SPEC.md" },
            { file: "plurnk-mimetypes-text-dotenv/SPEC.md" },
            { file: "plurnk-mimetypes-text-html/SPEC.md" },
            { file: "plurnk-mimetypes-text-ini/SPEC.md" },
            { file: "plurnk-mimetypes-text-markdown/SPEC.md" },
            { file: "plurnk-mimetypes-text-plain/SPEC.md" },
        ],
        testPrefixes: ["plurnk-mimetypes/", "plurnk-mimetypes-"],
        budgets: { minHeadingTags: 20, maxHeadingTags: 40, maxSpecLines: 720, maxUnitFiles: 32, maxIntgFiles: 4 },
    },
    {
        id: "acp-and-auth",
        repo: "plurnk-service",
        title: "ACP v2 Server Module & OAuth 2.1 Authority (plurnk-acp & plurnk-auth)",
        specs: [{ file: "plurnk-acp/SPEC.md" }, { file: "plurnk-auth/SPEC.md" }],
        testPrefixes: ["plurnk-acp/", "plurnk-auth/"],
        budgets: { minHeadingTags: 10, maxHeadingTags: 22, maxSpecLines: 380, maxUnitFiles: 3, maxIntgFiles: 2 },
    },
    {
        id: "modules-and-extensions",
        repo: "plurnk-service",
        title: "Modules, Meta, Digest, Schedule, Skills, Plugins, Hooks & OTel",
        specs: [
            { file: "plurnk-modules/SPEC.md" },
            { file: "plurnk-meta/SPEC.md" },
            { file: "plurnk-digest/SPEC.md" },
            { file: "plurnk-schedule/SPEC.md" },
            { file: "plurnk-skills/SPEC.md" },
            { file: "plurnk-agent-skills/SPEC.md" },
            { file: "plurnk-agent-plugins/SPEC.md" },
            { file: "plurnk-hooks/SPEC.md" },
            { file: "plurnk-otel/SPEC.md" },
        ],
        testPrefixes: [
            "plurnk-modules/",
            "plurnk-meta/",
            "plurnk-digest/",
            "plurnk-schedule/",
            "plurnk-skills/",
            "plurnk-agent-skills/",
            "plurnk-agent-plugins/",
            "plurnk-hooks/",
            "plurnk-otel/",
        ],
        extraTests: [
            "plurnk-core/test/intg/Digest.boundary.test.ts",
            "plurnk-core/test/intg/Digest.cache-ledger.test.ts",
            "plurnk-core/test/intg/Digest.cardinality.test.ts",
            "plurnk-core/test/intg/Digest.executor-evidence.test.ts",
            "plurnk-core/test/intg/Digest.failed-request.test.ts",
            "plurnk-core/test/intg/Digest.memory.test.ts",
            "plurnk-core/test/intg/Digest.output.test.ts",
            "plurnk-core/test/intg/Digest.request-states.test.ts",
            "plurnk-core/test/intg/Digest.requiem-evidence-budget.test.ts",
            "plurnk-core/test/intg/Digest.requiem-identity.test.ts",
            "plurnk-core/test/intg/Digest.resources.test.ts",
            "plurnk-core/test/intg/Digest.room-line.test.ts",
            "plurnk-core/test/intg/Digest.usageless-requests.test.ts",
            "plurnk-core/test/intg/Digest.workspace-names.test.ts",
            "plurnk-core/test/intg/WorkspaceStorage.test.ts",
            "plurnk-core/test/intg/backup-restore.test.ts",
            "plurnk-core/test/intg/caps-assembly.test.ts",
            "plurnk-core/test/intg/caps-channels-tags.test.ts",
            "plurnk-core/test/intg/functionality-environment.test.ts",
            "plurnk-core/test/intg/schedule-discovery.test.ts",
            "plurnk-core/test/intg/skills-exec.test.ts",
            "plurnk-core/test/intg/teaching-corpus.test.ts",
        ],
        budgets: { minHeadingTags: 22, maxHeadingTags: 42, maxSpecLines: 850, maxUnitFiles: 22, maxIntgFiles: 6 },
    },
    {
        id: "core-01-arch-actors",
        repo: "plurnk-service",
        title: "Core: Glossary, Architecture, Sessions & Workspace Boundaries",
        specs: [
            {
                file: "plurnk-core/SPEC.md",
                chapters: [
                    "(preamble)",
                    "Contents",
                    "Glossary",
                    "Architecture",
                    "Sessions and workspace boundaries",
                ],
            },
        ],
        budgets: { minHeadingTags: 6, maxHeadingTags: 14, maxSpecLines: 280, maxUnitFiles: 12, maxIntgFiles: 4 },
    },
    {
        id: "core-02-membership-loops",
        repo: "plurnk-service",
        title: "Core: File Membership & Loop Scheduling/Lifecycle",
        specs: [
            {
                file: "plurnk-core/SPEC.md",
                chapters: [
                    "File membership and project roots",
                    "Loop scheduling and lifecycle",
                ],
            },
        ],
        budgets: { minHeadingTags: 6, maxHeadingTags: 14, maxSpecLines: 300, maxUnitFiles: 10, maxIntgFiles: 4 },
    },
    {
        id: "core-03-contracts-search-channels",
        repo: "plurnk-service",
        title: "Core: Provider/Scheme/Mimetype Contracts, Search Indexing & Channels",
        specs: [
            {
                file: "plurnk-core/SPEC.md",
                chapters: [
                    "Provider Contract",
                    "Scheme Contract",
                    "Mimetype Contract",
                    "Search indexing",
                    "Channel Topology",
                ],
            },
        ],
        budgets: { minHeadingTags: 8, maxHeadingTags: 18, maxSpecLines: 340, maxUnitFiles: 14, maxIntgFiles: 5 },
    },
    {
        id: "core-04-ops-read-edit-log",
        repo: "plurnk-service",
        title: "Core: Op Surface, Line Anchors, EDIT, READ, The Log, COPY, MOVE, FIND",
        specs: [
            {
                file: "plurnk-core/SPEC.md",
                chapters: [
                    "Op Surface",
                    "Text line anchors",
                    "EDIT",
                    "READ",
                    "The Log",
                    "COPY",
                    "MOVE",
                    "FIND",
                ],
            },
        ],
        budgets: { minHeadingTags: 8, maxHeadingTags: 18, maxSpecLines: 380, maxUnitFiles: 16, maxIntgFiles: 6 },
    },
    {
        id: "core-05-send-exec",
        repo: "plurnk-service",
        title: "Core: Messaging (SEND) & Executions",
        specs: [
            {
                file: "plurnk-core/SPEC.md",
                chapters: [
                    "Messaging and turn disposition",
                    "Executions",
                ],
            },
        ],
        budgets: { minHeadingTags: 6, maxHeadingTags: 12, maxSpecLines: 260, maxUnitFiles: 10, maxIntgFiles: 4 },
    },
    {
        id: "core-06-proposals-streams-storage",
        repo: "plurnk-service",
        title: "Core: Proposals, Stream Model, Storage Model & Extension Composition",
        specs: [
            {
                file: "plurnk-core/SPEC.md",
                chapters: [
                    "Proposals and client interactions",
                    "Stream Model",
                    "Storage Model",
                    "Extension composition",
                    "Bundled Set",
                    "Grammar Dependency",
                ],
            },
        ],
        budgets: { minHeadingTags: 6, maxHeadingTags: 14, maxSpecLines: 240, maxUnitFiles: 10, maxIntgFiles: 4 },
    },
    {
        id: "core-07-config-rpc-functionality",
        repo: "plurnk-service",
        title: "Core: Operator Config, Module Seam & Workspace Functionality",
        specs: [
            {
                file: "plurnk-core/SPEC.md",
                chapters: [
                    "Operator Configuration",
                    "Module seam",
                    "Workspace Functionality",
                ],
            },
        ],
        budgets: { minHeadingTags: 6, maxHeadingTags: 14, maxSpecLines: 300, maxUnitFiles: 10, maxIntgFiles: 4 },
    },
    {
        id: "core-08-methods",
        repo: "plurnk-service",
        title: "Core: Application Interface (methods)",
        specs: [
            {
                file: "plurnk-core/SPEC.md",
                chapters: ["Application interface"],
            },
        ],
        budgets: { minHeadingTags: 4, maxHeadingTags: 12, maxSpecLines: 220, maxUnitFiles: 8, maxIntgFiles: 4 },
    },
    {
        id: "core-09-packet-matchers-problems",
        repo: "plurnk-service",
        title: "Core: Packet Assembly, Packet Shape, Matchers, Testing & Problem Tables",
        specs: [
            {
                file: "plurnk-core/SPEC.md",
                chapters: [
                    "Packet assembly",
                    "Packet shape",
                    "Matcher selection and text regions",
                    "Testing and evidence",
                    "Problem codes and pinned wording",
                ],
            },
        ],
        budgets: { minHeadingTags: 8, maxHeadingTags: 18, maxSpecLines: 420, maxUnitFiles: 16, maxIntgFiles: 6 },
    },
    {
        id: "client-plurnk",
        repo: "plurnk",
        title: "Terminal Client (../plurnk)",
        specs: [{ file: "SPEC.md" }],
        testPrefixes: [""],
        budgets: { minHeadingTags: 12, maxHeadingTags: 28, maxSpecLines: 550, maxUnitFiles: 8, maxIntgFiles: 3 },
    },
    {
        id: "bench-plurnk",
        repo: "plurnk-bench",
        title: "Benchmark Harness & Live/Demo Tiers (../plurnk-bench)",
        specs: [{ file: "SPEC.md" }],
        testPrefixes: [""],
        budgets: { minHeadingTags: 10, maxHeadingTags: 24, maxSpecLines: 380, maxUnitFiles: 18, maxIntgFiles: 2 },
    },
];

const repoRootFor = (repo) => {
    if (repo === "plurnk-service") return SERVICE_ROOT;
    if (repo === "plurnk") return CLIENT_ROOT;
    if (repo === "plurnk-bench") return BENCH_ROOT;
    throw new Error(`Unknown repository: ${repo}`);
};

const gitTrackedFiles = (repoRoot) => {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: repoRoot,
        encoding: "utf8",
    });
    return out.split("\0").filter(Boolean).toSorted();
};

const maskInlineCode = (line) => line.replace(INLINE_CODE_RE, (m) => "x".repeat(m.length));

const normalizeChapterTitle = (title) => title
    .replace(new RegExp(`^${SEC}[a-z0-9-]+\\s+`, "i"), "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase();

const extractChapterTag = (title) => {
    const m = new RegExp(`^${SEC}([a-z][a-z0-9-]*)\\b`).exec(title.trim());
    return m ? m[1] : null;
};

const matchChapter = (parsedChapters, specChapterName) => {
    if (parsedChapters.has(specChapterName)) return parsedChapters.get(specChapterName);
    const wantedTag = extractChapterTag(specChapterName);
    const wantedNorm = normalizeChapterTitle(specChapterName);
    for (const ch of parsedChapters.values()) {
        const chTag = extractChapterTag(ch.title);
        if (wantedTag !== null && chTag === wantedTag) return ch;
        if (normalizeChapterTitle(ch.title) === wantedNorm) return ch;
    }
    return undefined;
};

const parseSpecFile = (specRelPath, text) => {
    const rawLines = text.split("\n");
    let fence = null;
    let currentChapter = "(preamble)";
    let chapterStart = 1;
    const chapters = new Map();
    chapters.set(currentChapter, { title: currentChapter, startLine: 1, endLine: rawLines.length, mapBlocks: 0, tags: [] });

    let paragraphOpen = false;
    for (let i = 0; i < rawLines.length; i += 1) {
        const raw = rawLines[i] ?? "";
        const lineNum = i + 1;
        if (raw.trim() === "<!-- map -->" && fence === null) {
            const ch = chapters.get(currentChapter);
            if (ch !== undefined) ch.mapBlocks += 1;
        }
        const marker = raw.match(FENCE_RE)?.[1];
        if (
            marker !== undefined
            && (fence !== null || marker[0] !== "`" || !raw.slice(raw.indexOf(marker) + marker.length).includes("`"))
        ) {
            if (fence === null) {
                fence = { char: marker[0], len: marker.length };
            } else if (
                marker[0] === fence.char
                && marker.length >= fence.len
                && raw.slice(raw.indexOf(marker) + marker.length).trim().length === 0
            ) {
                fence = null;
            }
            paragraphOpen = false;
            continue;
        }
        if (fence !== null || /^(?: {4}|\t)/.test(raw)) {
            paragraphOpen = false;
            continue;
        }
        if (raw.startsWith("## ")) {
            const prev = chapters.get(currentChapter);
            if (prev !== undefined) prev.endLine = lineNum - 1;
            currentChapter = raw.slice(3).trim();
            chapterStart = lineNum;
            if (!chapters.has(currentChapter)) {
                chapters.set(currentChapter, {
                    title: currentChapter,
                    startLine: chapterStart,
                    endLine: rawLines.length,
                    mapBlocks: 0,
                    tags: [],
                });
            }
        }
        const line = maskInlineCode(raw);
        if (line.trim().length === 0) {
            paragraphOpen = false;
            continue;
        }
        const isHeading = /^ {0,3}#{1,6}[ \t]+/.test(line);
        const isList = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(line);
        const isOtherBlock = /^ {0,3}(?:>|\||<)/.test(line);
        const paragraphStart = !paragraphOpen && !isHeading && !isList && !isOtherBlock;

        const headingMatch = line.match(HEADING_DECL);
        const listMatch = headingMatch === null ? line.match(LIST_DECL) : null;
        const tableMatch = headingMatch === null && listMatch === null ? line.match(TABLE_DECL) : null;
        const paraMatch = headingMatch === null && listMatch === null && tableMatch === null && paragraphStart
            ? line.match(PARA_DECL)
            : null;
        const match = headingMatch ?? listMatch ?? tableMatch ?? paraMatch;
        const shape = headingMatch !== null
            ? "heading"
            : listMatch !== null
                ? "list"
                : tableMatch !== null
                    ? "table"
                    : paraMatch !== null
                        ? "paragraph"
                        : null;

        if (match !== null && shape !== null) {
            const tag = match[1];
            const entry = {
                tag,
                spec: specRelPath,
                chapter: currentChapter,
                line: lineNum,
                shape,
                preview: raw.trim().slice(0, 120),
            };
            chapters.get(currentChapter)?.tags.push(entry);
        }
        paragraphOpen = !isHeading && !isOtherBlock;
    }
    return { totalLines: rawLines.length, chapters };
};

const classifyTestTier = (relPath) => {
    if (relPath.startsWith("scripts/")) return "root";
    if (/(?:^|\/)tiers\/(?:live|demo)\//.test(relPath) || /(?:^|\/)test\/(?:live|demo|tui)\//.test(relPath)) return "live";
    if (/(?:^|\/)test\/(?:intg|integration|conformance)\//.test(relPath) || /\.integration\.test\./.test(relPath)) return "intg";
    return "unit";
};

const analyzeTestFile = (relPath, text) => {
    const lines = text.split("\n");
    const citedTags = [...new Set([...text.matchAll(REF_TAG)].map((m) => m[1]))].toSorted();
    const testBlocks = [];
    const testCallRe = /\b(?:test|it)\s*\(\s*(`(?:\\[\s\S]|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
    for (const match of text.matchAll(testCallRe)) {
        const literal = match[1] ?? "";
        const before = text.slice(0, match.index ?? 0);
        const line = before.split("\n").length;
        const tagsInTitle = [...new Set([...literal.matchAll(REF_TAG)].map((m) => m[1]))];
        testBlocks.push({
            line,
            title: literal.slice(1, -1).replace(/\s+/g, " ").slice(0, 110),
            citedTags: tagsInTitle,
        });
    }
    return {
        file: relPath,
        tier: classifyTestTier(relPath),
        lines: lines.length,
        testCount: testBlocks.length,
        untaggedTestLines: testBlocks.filter((b) => b.citedTags.length === 0).map((b) => b.line),
        usesOpenMigrated: /\bopenMigrated\s*\(/.test(text),
        usesLaunch: /\blaunch\s*\(/.test(text),
        citedTags,
    };
};

const scanRepo = (repoName) => {
    const root = repoRootFor(repoName);
    const tracked = gitTrackedFiles(root);
    const specs = new Map();
    const tests = new Map();
    const citations = new Map();

    const bumpCitation = (tag, bucket, file) => {
        let rec = citations.get(tag);
        if (rec === undefined) {
            rec = { codeFiles: new Set(), testFiles: new Set(), docFiles: new Set() };
            citations.set(tag, rec);
        }
        rec[bucket].add(file);
    };

    for (const rel of tracked) {
        const full = path.join(root, rel);
        let stat;
        try {
            stat = fs.lstatSync(full);
        } catch {
            continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) continue;
        const text = buf.toString("utf8");

        if (path.basename(rel) === "SPEC.md") {
            specs.set(rel, parseSpecFile(rel, text));
        }

        const isTest = /\.test\.(?:ts|mjs|js)$/.test(rel);
        const isMarkdown = rel.endsWith(".md");
        if (isTest) {
            tests.set(rel, analyzeTestFile(rel, text));
        }

        for (const m of text.matchAll(REF_TAG)) {
            const tag = m[1];
            if (isTest || /(?:^|\/)test\//.test(rel)) bumpCitation(tag, "testFiles", rel);
            else if (isMarkdown) bumpCitation(tag, "docFiles", rel);
            else bumpCitation(tag, "codeFiles", rel);
        }
    }

    return { repoName, root, specs, tests, citations };
};

const assignAll = (scans) => {
    const unitMap = new Map(
        WORK_UNITS.map((u) => [
            u.id,
            {
                ...u,
                tags: [],
                testFiles: [],
                liveSpecLines: 0,
                liveMapBlocks: 0,
            },
        ]),
    );

    const tagToCoreUnit = new Map();
    const claimedChapters = new Set();

    for (const u of WORK_UNITS) {
        const scan = scans.get(u.repo);
        if (scan === undefined) continue;
        const unitOut = unitMap.get(u.id);
        for (const specSel of u.specs) {
            const parsed = scan.specs.get(specSel.file);
            if (parsed === undefined) continue;
            const selectedChapters = specSel.chapters === undefined
                ? [...parsed.chapters.values()]
                : specSel.chapters.map((chTitle) => matchChapter(parsed.chapters, chTitle)).filter(Boolean);
            for (const ch of selectedChapters) {
                const chKey = `${u.repo}:${specSel.file}:${ch.title}`;
                if (claimedChapters.has(chKey)) continue;
                claimedChapters.add(chKey);
                unitOut.liveSpecLines += ch.endLine - ch.startLine + 1;
                unitOut.liveMapBlocks += ch.mapBlocks;
                for (const t of ch.tags) {
                    const cite = scan.citations.get(t.tag);
                    unitOut.tags.push({
                        ...t,
                        codeCitations: cite ? cite.codeFiles.size : 0,
                        testCitations: cite ? cite.testFiles.size : 0,
                    });
                    if (specSel.file === "plurnk-core/SPEC.md") {
                        tagToCoreUnit.set(t.tag, u.id);
                    }
                }
            }
        }
    }

    const assignedTests = new Set();
    for (const u of WORK_UNITS) {
        const scan = scans.get(u.repo);
        if (scan === undefined) continue;
        const unitOut = unitMap.get(u.id);
        for (const extra of u.extraTests ?? []) {
            const t = scan.tests.get(extra);
            if (t !== undefined && !assignedTests.has(`${u.repo}:${extra}`)) {
                unitOut.testFiles.push(t);
                assignedTests.add(`${u.repo}:${extra}`);
            }
        }
        if (u.testPrefixes !== undefined) {
            for (const [rel, t] of scan.tests.entries()) {
                if (assignedTests.has(`${u.repo}:${rel}`)) continue;
                if (u.testPrefixes.some((p) => p === "" || rel.startsWith(p))) {
                    unitOut.testFiles.push(t);
                    assignedTests.add(`${u.repo}:${rel}`);
                }
            }
        }
    }

    const serviceScan = scans.get("plurnk-service");
    if (serviceScan !== undefined) {
        for (const [rel, t] of serviceScan.tests.entries()) {
            if (assignedTests.has(`plurnk-service:${rel}`)) continue;
            if (!rel.startsWith("plurnk-core/")) continue;
            const unitVotes = new Map();
            for (const tag of t.citedTags) {
                const targetUnit = tagToCoreUnit.get(tag);
                if (targetUnit !== undefined) {
                    unitVotes.set(targetUnit, (unitVotes.get(targetUnit) ?? 0) + 1);
                }
            }
            let chosen = null;
            if (unitVotes.size > 0) {
                chosen = [...unitVotes.entries()].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
            } else if (rel.includes("/content/")) {
                chosen = "core-04-ops-read-edit-log";
            } else if (rel.includes("/server/") || rel.includes("/methods")) {
                chosen = "core-08-methods";
            } else if (rel.includes("/packet")) {
                chosen = "core-09-packet-matchers-problems";
            } else {
                chosen = "core-01-arch-actors";
            }
            unitMap.get(chosen)?.testFiles.push(t);
            assignedTests.add(`plurnk-service:${rel}`);
        }
    }

    return unitMap;
};

const loadAllScans = () => new Map([
    ["plurnk-service", scanRepo("plurnk-service")],
    ["plurnk", scanRepo("plurnk")],
    ["plurnk-bench", scanRepo("plurnk-bench")],
]);

const cmdInit = (force, quiet = false) => {
    const existing = fs.existsSync(LEDGER_PATH)
        ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"))
        : null;
    if (existing !== null && !force && !quiet) {
        console.log("Syncing existing clamp-ledger.json with live filesystem state (preserving recorded dispositions)...");
    }

    const scans = loadAllScans();
    const unitMap = assignAll(scans);
    const ledgerUnits = {};

    for (const [id, u] of unitMap.entries()) {
        const prevUnit = existing?.units?.[id];
        const tagDecisions = {};
        for (const t of u.tags) {
            const prev = prevUnit?.tags?.[t.tag];
            tagDecisions[t.tag] = {
                spec: t.spec,
                chapter: t.chapter,
                baselineLine: prev?.baselineLine ?? t.line,
                baselineShape: prev?.baselineShape ?? t.shape,
                liveShape: t.shape,
                codeCitations: t.codeCitations,
                testCitations: t.testCitations,
                disposition: force ? "pending" : (prev?.disposition ?? "pending"),
                target: force ? null : (prev?.target ?? null),
                reason: force ? null : (prev?.reason ?? null),
            };
        }
        if (!force && prevUnit?.tags !== undefined) {
            for (const [oldTag, oldEntry] of Object.entries(prevUnit.tags)) {
                if (!(oldTag in tagDecisions)) {
                    tagDecisions[oldTag] = { ...oldEntry, liveShape: "removed" };
                }
            }
        }

        const testDecisions = {};
        for (const tf of u.testFiles) {
            const prev = prevUnit?.tests?.[tf.file];
            testDecisions[tf.file] = {
                tier: tf.tier,
                baselineLines: prev?.baselineLines ?? tf.lines,
                liveLines: tf.lines,
                testCount: tf.testCount,
                untaggedCount: tf.untaggedTestLines.length,
                usesOpenMigrated: tf.usesOpenMigrated,
                usesLaunch: tf.usesLaunch,
                citedTags: tf.citedTags,
                disposition: force ? "pending" : (prev?.disposition ?? "pending"),
                target: force ? null : (prev?.target ?? null),
                reason: force ? null : (prev?.reason ?? null),
            };
        }
        if (!force && prevUnit?.tests !== undefined) {
            for (const [oldFile, oldEntry] of Object.entries(prevUnit.tests)) {
                if (!(oldFile in testDecisions)) {
                    testDecisions[oldFile] = { ...oldEntry, liveLines: 0 };
                }
            }
        }

        ledgerUnits[id] = {
            id,
            repo: u.repo,
            title: u.title,
            specs: u.specs,
            budgets: u.budgets,
            baseline: prevUnit?.baseline ?? {
                totalTags: u.tags.length,
                headingTags: u.tags.filter((t) => t.shape === "heading").length,
                nonHeadingTags: u.tags.filter((t) => t.shape !== "heading").length,
                specLines: u.liveSpecLines,
                mapBlocks: u.liveMapBlocks,
                unitFiles: u.testFiles.filter((f) => f.tier === "unit" || f.tier === "root").length,
                intgFiles: u.testFiles.filter((f) => f.tier === "intg").length,
                liveFiles: u.testFiles.filter((f) => f.tier === "live").length,
            },
            tags: tagDecisions,
            tests: testDecisions,
        };
    }

    const payload = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        rules: {
            headingOnlyDeclarations: true,
            forbidMapBlocks: true,
            forbidPinnedWordingAndProblemTables: true,
            requireDualWitness: true,
            requireTaggedTests: true,
            minReasonLength: 15,
            maxDuplicateReasonPerUnit: 3,
        },
        units: ledgerUnits,
    };
    fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    if (!quiet) {
        console.log(`Wrote ${LEDGER_PATH} across ${Object.keys(ledgerUnits).length} work units.`);
    }
};

const evaluateUnit = (unitId, ledger, scans, assignedMap) => {
    const unitLedger = ledger.units[unitId];
    const liveUnit = assignedMap.get(unitId);
    if (unitLedger === undefined || liveUnit === undefined) {
        throw new Error(`Unknown work unit: ${unitId}`);
    }
    const scan = scans.get(unitLedger.repo);
    const errors = [];

    const tagEntries = Object.entries(unitLedger.tags);
    const testEntries = Object.entries(unitLedger.tests);

    const pendingTags = tagEntries.filter(([, v]) => v.disposition === "pending").map(([k]) => k);
    const pendingTests = testEntries.filter(([, v]) => v.disposition === "pending").map(([k]) => k);
    if (pendingTags.length > 0) {
        errors.push(`${pendingTags.length} pending tag disposition(s): ${pendingTags.slice(0, 8).join(", ")}${pendingTags.length > 8 ? "..." : ""}`);
    }
    if (pendingTests.length > 0) {
        errors.push(`${pendingTests.length} pending test file disposition(s): ${pendingTests.slice(0, 5).join(", ")}${pendingTests.length > 5 ? "..." : ""}`);
    }

    const reasonCounts = new Map();
    for (const [k, v] of [...tagEntries, ...testEntries]) {
        if (v.disposition === "pending") continue;
        const r = (v.reason ?? "").trim();
        if (r.length < 15) {
            errors.push(`${k}: disposition '${v.disposition}' requires a specific --reason of at least 15 characters`);
        } else {
            reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
        }
    }
    for (const [reason, count] of reasonCounts.entries()) {
        if (count > 3) {
            errors.push(`Rubber-stamp detected: reason "${reason.slice(0, 50)}" was repeated ${count} times in ${unitId} (max 3)`);
        }
    }

    const liveTagsByName = new Map(liveUnit.tags.map((t) => [t.tag, t]));
    const nonHeadingLive = liveUnit.tags.filter((t) => t.shape !== "heading");
    if (nonHeadingLive.length > 0) {
        errors.push(
            `${nonHeadingLive.length} non-heading tag declaration(s) remain in SPEC.md (must be ## or ### heading): ${nonHeadingLive.slice(0, 6).map((t) => `${SEC}${t.tag} (${t.shape} L${t.line})`).join(", ")}${nonHeadingLive.length > 6 ? "..." : ""}`,
        );
    }

    if (liveUnit.liveMapBlocks > 0) {
        errors.push(`${liveUnit.liveMapBlocks} <!-- map --> block(s) remain in this unit's SPEC.md chapters`);
    }

    for (const t of liveUnit.tags) {
        if (t.tag.startsWith("pinned-wording") || t.tag.startsWith("problems-")) {
            errors.push(`Forbidden ceremonial tag ${SEC}${t.tag} (L${t.line}) remains in ${t.spec}`);
        }
        const cite = scan.citations.get(t.tag);
        const codeCount = cite ? cite.codeFiles.size : 0;
        const testCount = cite ? cite.testFiles.size : 0;
        if (codeCount === 0) {
            errors.push(`Surviving heading tag ${SEC}${t.tag} has 0 implementation/panel citations in src/ or .env.defaults`);
        }
        if (testCount === 0) {
            errors.push(`Surviving heading tag ${SEC}${t.tag} has 0 test citations in *.test.*`);
        }
    }

    for (const [tag, entry] of tagEntries) {
        if (entry.disposition === "pending") continue;
        const stillDeclared = liveTagsByName.has(tag);
        const stillCited = (scan.citations.get(tag)?.codeFiles.size ?? 0) + (scan.citations.get(tag)?.testFiles.size ?? 0) > 0;
        if (entry.disposition === "keep-heading") {
            const live = liveTagsByName.get(tag);
            if (live === undefined) {
                errors.push(`Tag ${SEC}${tag} is marked keep-heading but is missing from ${entry.spec}`);
            } else if (live.shape !== "heading") {
                errors.push(`Tag ${SEC}${tag} is marked keep-heading but is still a ${live.shape} on L${live.line} of ${entry.spec}`);
            }
        } else {
            if (stillDeclared) {
                errors.push(`Tag ${SEC}${tag} is marked ${entry.disposition} but is still declared in ${entry.spec}`);
            }
            if (stillCited) {
                errors.push(`Tag ${SEC}${tag} is marked ${entry.disposition} but is still cited as {${SEC}${tag}} in code or tests`);
            }
            if (entry.disposition === "fold-into" && (entry.target === null || !liveTagsByName.has(entry.target))) {
                errors.push(`Tag ${SEC}${tag} folds into '${entry.target}', which is not a surviving heading tag in ${unitId}`);
            }
        }
    }

    for (const [file, entry] of testEntries) {
        if (entry.disposition === "pending") continue;
        const existsNow = fs.existsSync(path.join(scan.root, file));
        if (entry.disposition === "keep-suite") {
            if (!existsNow) errors.push(`Test suite ${file} is marked keep-suite but does not exist on disk`);
        } else {
            if (existsNow) {
                errors.push(`Test file ${file} is marked ${entry.disposition} but still exists on disk (git rm it after merging/purging)`);
            }
            if (entry.disposition === "merge-into" || entry.disposition === "demote-to-unit") {
                if (!entry.target || !fs.existsSync(path.join(scan.root, entry.target))) {
                    errors.push(`Test file ${file} (${entry.disposition}) names missing target suite '${entry.target}'`);
                } else if (entry.disposition === "demote-to-unit" && classifyTestTier(entry.target) !== "unit") {
                    errors.push(`Test file ${file} (demote-to-unit) target '${entry.target}' must be a unit test outside test/intg/`);
                }
            }
        }
    }

    for (const tf of liveUnit.testFiles) {
        if (tf.tier === "live") continue;
        if (tf.untaggedTestLines.length > 0) {
            errors.push(
                `${tf.file} has ${tf.untaggedTestLines.length} untagged test() block(s) without a braced spec tag citation (lines: ${tf.untaggedTestLines.slice(0, 6).join(", ")})`,
            );
        }
    }

    const headingCount = liveUnit.tags.filter((t) => t.shape === "heading").length;
    const totalLiveTags = liveUnit.tags.length;
    const unitFilesCount = liveUnit.testFiles.filter((f) => f.tier === "unit" || f.tier === "root").length;
    const intgFilesCount = liveUnit.testFiles.filter((f) => f.tier === "intg").length;
    const b = unitLedger.budgets;

    if (totalLiveTags < b.minHeadingTags) {
        errors.push(`Tag count (${totalLiveTags}) is below minHeadingTags (${b.minHeadingTags}) — do not over-purge core contracts`);
    }
    if (totalLiveTags > b.maxHeadingTags) {
        errors.push(`Tag count (${totalLiveTags}) exceeds maxHeadingTags budget (${b.maxHeadingTags})`);
    }
    if (liveUnit.liveSpecLines > b.maxSpecLines) {
        errors.push(`SPEC line count (${liveUnit.liveSpecLines}) exceeds maxSpecLines budget (${b.maxSpecLines})`);
    }
    if (unitFilesCount > b.maxUnitFiles) {
        errors.push(`Unit test file count (${unitFilesCount}) exceeds maxUnitFiles budget (${b.maxUnitFiles})`);
    }
    if (intgFilesCount > b.maxIntgFiles) {
        errors.push(`Integration test file count (${intgFilesCount}) exceeds maxIntgFiles budget (${b.maxIntgFiles})`);
    }

    return {
        unitId,
        ok: errors.length === 0,
        errors,
        metrics: {
            pendingTags: pendingTags.length,
            pendingTests: pendingTests.length,
            totalLiveTags,
            headingCount,
            nonHeadingCount: nonHeadingLive.length,
            liveSpecLines: liveUnit.liveSpecLines,
            unitFilesCount,
            intgFilesCount,
        },
    };
};

const cmdStatus = (filterUnit) => {
    cmdInit(false, true);
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    const scans = loadAllScans();
    const assignedMap = assignAll(scans);

    console.log(
        [
            "UNIT".padEnd(34),
            "REPO".padEnd(15),
            "TAGS(now/max)".padEnd(15),
            "NON-H".padEnd(7),
            "SPEC-LOC(now/max)".padEnd(19),
            "UNIT-F".padEnd(9),
            "INTG-F".padEnd(9),
            "PEND(T/F)".padEnd(11),
            "STATUS",
        ].join(" "),
    );
    console.log("-".repeat(130));

    let totalTagsNow = 0;
    let totalMaxTags = 0;
    let totalNonH = 0;
    let totalSpecLoc = 0;
    let totalMaxSpecLoc = 0;
    let totalUnitF = 0;
    let totalMaxUnitF = 0;
    let totalIntgF = 0;
    let totalMaxIntgF = 0;

    for (const u of WORK_UNITS) {
        if (filterUnit !== undefined && u.id !== filterUnit) continue;
        const res = evaluateUnit(u.id, ledger, scans, assignedMap);
        const m = res.metrics;
        const b = ledger.units[u.id].budgets;
        totalTagsNow += m.totalLiveTags;
        totalMaxTags += b.maxHeadingTags;
        totalNonH += m.nonHeadingCount;
        totalSpecLoc += m.liveSpecLines;
        totalMaxSpecLoc += b.maxSpecLines;
        totalUnitF += m.unitFilesCount;
        totalMaxUnitF += b.maxUnitFiles;
        totalIntgF += m.intgFilesCount;
        totalMaxIntgF += b.maxIntgFiles;

        const statusLabel = res.ok
            ? "PASS"
            : (m.pendingTags + m.pendingTests > 0 ? "PENDING" : "FAIL");
        console.log(
            [
                u.id.padEnd(34),
                u.repo.padEnd(15),
                `${m.totalLiveTags}/${b.maxHeadingTags}`.padEnd(15),
                String(m.nonHeadingCount).padEnd(7),
                `${m.liveSpecLines}/${b.maxSpecLines}`.padEnd(19),
                `${m.unitFilesCount}/${b.maxUnitFiles}`.padEnd(9),
                `${m.intgFilesCount}/${b.maxIntgFiles}`.padEnd(9),
                `${m.pendingTags}/${m.pendingTests}`.padEnd(11),
                statusLabel,
            ].join(" "),
        );
    }
    if (filterUnit === undefined) {
        console.log("-".repeat(130));
        console.log(
            [
                "TOTAL".padEnd(34),
                "all-3-repos".padEnd(15),
                `${totalTagsNow}/${totalMaxTags}`.padEnd(15),
                String(totalNonH).padEnd(7),
                `${totalSpecLoc}/${totalMaxSpecLoc}`.padEnd(19),
                `${totalUnitF}/${totalMaxUnitF}`.padEnd(9),
                `${totalIntgF}/${totalMaxIntgF}`.padEnd(9),
            ].join(" "),
        );
    }
};

const cmdShow = (unitId, pendingOnly) => {
    cmdInit(false, true);
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    const scans = loadAllScans();
    const assignedMap = assignAll(scans);
    const res = evaluateUnit(unitId, ledger, scans, assignedMap);
    const u = ledger.units[unitId];

    console.log(`# Work Unit: ${u.id} (${u.repo})`);
    console.log(`Title: ${u.title}`);
    console.log(`Budgets: headingTags=${u.budgets.minHeadingTags}..${u.budgets.maxHeadingTags}, maxSpecLines=${u.budgets.maxSpecLines}, maxUnitFiles=${u.budgets.maxUnitFiles}, maxIntgFiles=${u.budgets.maxIntgFiles}`);
    console.log(`Live:    totalTags=${res.metrics.totalLiveTags} (nonHeading=${res.metrics.nonHeadingCount}), specLines=${res.metrics.liveSpecLines}, unitFiles=${res.metrics.unitFilesCount}, intgFiles=${res.metrics.intgFilesCount}`);
    console.log(`\n## Tags (${Object.keys(u.tags).length} total, ${res.metrics.pendingTags} pending)`);
    for (const [tag, info] of Object.entries(u.tags)) {
        if (pendingOnly && info.disposition !== "pending") continue;
        console.log(
            `  - ${SEC}${tag.padEnd(38)} [${info.liveShape.padEnd(9)}] (${info.spec} L${info.baselineLine}) cites(code=${info.codeCitations}, test=${info.testCitations}) -> ${info.disposition}${info.target ? ` (${info.target})` : ""}`,
        );
    }
    console.log(`\n## Test Files (${Object.keys(u.tests).length} total, ${res.metrics.pendingTests} pending)`);
    for (const [file, info] of Object.entries(u.tests)) {
        if (pendingOnly && info.disposition !== "pending") continue;
        const flags = [
            info.tier,
            `${info.liveLines}L`,
            `${info.testCount}t`,
            info.untaggedCount > 0 ? `${info.untaggedCount}untagged` : null,
            info.usesOpenMigrated ? "db" : null,
            info.usesLaunch ? "launch" : null,
        ].filter(Boolean).join(",");
        console.log(
            `  - ${file.padEnd(58)} [${flags}] -> ${info.disposition}${info.target ? ` (${info.target})` : ""}`,
        );
    }
    if (res.errors.length > 0) {
        console.log(`\n## Verification Blockers (${res.errors.length})`);
        for (const err of res.errors) console.log(`  ! ${err}`);
    } else {
        console.log("\n## Verification: PASS");
    }
};

const cmdDecideTag = (unitId, rawTag, disposition, target, reason) => {
    cmdInit(false, true);
    const tag = rawTag.replace(new RegExp(`^${SEC}`), "");
    if (!VALID_TAG_DISPOSITIONS.has(disposition)) {
        throw new Error(`Invalid tag disposition '${disposition}'. Allowed: ${[...VALID_TAG_DISPOSITIONS].join(", ")}`);
    }
    if ((disposition === "fold-into" || disposition === "move-to-doc") && !target) {
        throw new Error(`Disposition '${disposition}' requires --target <heading-tag-or-doc>`);
    }
    if (!reason || reason.trim().length < 15) {
        throw new Error("--reason must be at least 15 characters explaining the decision");
    }
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    const u = ledger.units[unitId];
    if (!u) throw new Error(`Unknown unit: ${unitId}`);
    if (!u.tags[tag]) throw new Error(`Tag ${SEC}${tag} is not registered in unit ${unitId}`);
    u.tags[tag].disposition = disposition;
    u.tags[tag].target = target ? target.replace(new RegExp(`^${SEC}`), "") : null;
    u.tags[tag].reason = reason.trim();
    ledger.updatedAt = new Date().toISOString();
    fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`Recorded ${unitId} ${SEC}${tag} -> ${disposition}${target ? ` (${target})` : ""}`);
};

const cmdDecideTest = (unitId, file, disposition, target, reason) => {
    cmdInit(false, true);
    if (!VALID_TEST_DISPOSITIONS.has(disposition)) {
        throw new Error(`Invalid test disposition '${disposition}'. Allowed: ${[...VALID_TEST_DISPOSITIONS].join(", ")}`);
    }
    if ((disposition === "merge-into" || disposition === "demote-to-unit") && !target) {
        throw new Error(`Disposition '${disposition}' requires --target <suite-path>`);
    }
    if (!reason || reason.trim().length < 15) {
        throw new Error("--reason must be at least 15 characters explaining the decision");
    }
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    const u = ledger.units[unitId];
    if (!u) throw new Error(`Unknown unit: ${unitId}`);
    if (!u.tests[file]) throw new Error(`Test file ${file} is not registered in unit ${unitId}`);
    u.tests[file].disposition = disposition;
    u.tests[file].target = target ?? null;
    u.tests[file].reason = reason.trim();
    ledger.updatedAt = new Date().toISOString();
    fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`Recorded ${unitId} ${file} -> ${disposition}${target ? ` (${target})` : ""}`);
};

const cmdVerify = (unitId, all) => {
    cmdInit(false, true);
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    const scans = loadAllScans();
    const assignedMap = assignAll(scans);
    const targets = all ? WORK_UNITS.map((u) => u.id) : [unitId];
    let failed = 0;
    for (const id of targets) {
        const res = evaluateUnit(id, ledger, scans, assignedMap);
        if (!res.ok) {
            failed += 1;
            console.error(`FAIL [${id}]:`);
            for (const e of res.errors) console.error(`  - ${e}`);
        } else {
            console.log(`PASS [${id}]`);
        }
    }
    if (failed > 0) process.exitCode = 1;
};

const main = () => {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            force: { type: "boolean", default: false },
            pending: { type: "boolean", default: false },
            all: { type: "boolean", default: false },
            unit: { type: "string" },
            target: { type: "string" },
            reason: { type: "string" },
            help: { type: "boolean", default: false },
        },
    });
    const [cmd, arg1, arg2, arg3] = positionals;
    if (values.help || cmd === undefined) {
        console.log(`Usage:
  node scripts/anatomy/clamp-audit.mjs init [--force]
  node scripts/anatomy/clamp-audit.mjs status [--unit <id>]
  node scripts/anatomy/clamp-audit.mjs show <unit-id> [--pending]
  node scripts/anatomy/clamp-audit.mjs decide-tag <unit-id> <tag> <disposition> [--target <tag-or-doc>] --reason "<text>"
  node scripts/anatomy/clamp-audit.mjs decide-test <unit-id> <file> <disposition> [--target <suite-path>] --reason "<text>"
  node scripts/anatomy/clamp-audit.mjs verify [<unit-id> | --all]`);
        return;
    }
    if (cmd === "init") cmdInit(values.force);
    else if (cmd === "status") cmdStatus(values.unit);
    else if (cmd === "show") cmdShow(arg1, values.pending);
    else if (cmd === "decide-tag") cmdDecideTag(arg1, arg2, arg3, values.target, values.reason);
    else if (cmd === "decide-test") cmdDecideTest(arg1, arg2, arg3, values.target, values.reason);
    else if (cmd === "verify") cmdVerify(arg1, values.all);
    else throw new Error(`Unknown subcommand: ${cmd}`);
};

main();
