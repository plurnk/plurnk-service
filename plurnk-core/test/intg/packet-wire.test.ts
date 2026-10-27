import test, { describe } from "node:test";
import assert from "node:assert/strict";
import PacketWire, { type LogEntryView } from "../../src/core/packet-wire.ts";
import GitState from "../../src/core/git-state.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket, { type StoredPacketSection, type DurablePacket } from "../../src/core/StoredPacket.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import Paths from "../../src/Paths.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import Daemon from "../../src/server/Daemon.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { mkdtemp, readFile, rm, access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AiSdkProvider, Mock, type MockResponse, chatMessageText, type ChatMessage } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import { Digest, Share } from "@plurnk/plurnk-digest";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, insertTurn, insertPacketTurn } from "./_db.ts";
import { digestStems, packetSection, logEntries } from "./_packet.ts";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { type KillStatement, InvalidCapabilityPolicyError, Validator } from "@plurnk/plurnk-contracts";
import { urlPath, readStmt, completeStmt, copyStmt, editStmt, findStmt, regex, noteStmt } from "./_dsl.ts";
import { missingDigestDirs, recoverDigest } from "../../bin/digest-missing.ts";
import { clientRead } from "./_client-read.ts";
import { parseEnv } from "node:util";
import { Lexer } from "marked";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { fixtureExecutors, makeMockResponse } from "./_mock.ts";
import { type PacketSectionDraft } from "@plurnk/plurnk-schemes";
import { createHash } from "node:crypto";
import { rpcCall, rpcProblem, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { namedModelSession } from "./_sessions.ts";

describe("packet-wire", () => {
const METADATA_WEIGHT = 308;
const tok = (s: string): number => Math.ceil(s.length / 4);
// The exact names a parsed log record carries: its heading's identity and charge, then its facts.
const facts = (record: Record<string, unknown>): string[] => Object.keys(record).toSorted();

test("{§session-wait-timing}: WAIT receipts expose their effective maximum, not elapsed time or a re-read default", () => {
    for (const seconds of [300, 600, 0.25]) {
        const out = PacketWire.renderLog([{
            coordinate: "1/2/3", op: "WAIT", status: 202, tx: { body: "" }, attrs: { waiting: seconds },
        }], tok);
        assert.deepEqual(JSON.parse(out.split("\n")[1]), { status: 202, waitSeconds: seconds });
    }
    const idle = PacketWire.renderLog([{
        coordinate: "1/2/3", op: "WAIT", status: 102, tx: { body: "" }, rx: { detail: "Nothing is in flight. Continuing." },
    }], tok);
    assert.equal(parseLogRecords(idle)[0].waitSeconds, undefined, "an idle WAIT has no wait duration");
    const zero = PacketWire.renderLog([{
        coordinate: "1/2/3", op: "WAIT", status: 102, tx: { body: "" }, attrs: { waiting: 0 },
    }], tok);
    assert.equal(parseLogRecords(zero)[0].waitSeconds, 0, "zero explicitly declines parking");
    const receipt = { coordinate: "1/2/3", op: "WAIT", status: 202, tx: { body: "" } };
    for (const waiting of [-2, "600", null, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => PacketWire.renderLog([{ ...receipt, attrs: { waiting } }], tok),
            /A WAIT receipt carries a malformed waiting bound\./u);
    }
});

test("{§read}: READ preserves precise match locations beside whole lines", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/3", op: "READ", status: 200,
        target: { scheme: null, pathname: "/example.js" },
        tx: { matcher: { raw: "/foo/" } },
        rx: {
            content: "return foo(input);", startLine: 12, lineOrdinals: [12], matched: 1,
            range: { unit: "line", total: 20, requested: [12, 12], returned: [12, 12] },
            matches: [{ region: { startLine: 12, startColumn: 8, endLine: 12, endColumn: 11 }, matched: "foo" }],
        },
    }], tok);
    assert.deepEqual(JSON.parse(out.split("\n")[1]), {
        matched: 1, matches: [{ region: "<12,8,12,11>" }], range: "<12> of 20 lines",
    });
    assert.match(out, /12:return foo\(input\);/);
});

test("{§read}: match metadata rides whole with its source locations", () => {
    const matches = Array.from({ length: 30 }, (_, index) => ({
        region: { startLine: 1, startColumn: index * 4 + 1, endLine: 1, endColumn: index * 4 + 4 }, matched: "foo",
    }));
    const row = {
        coordinate: "1/2/3", op: "READ", status: 200,
        target: { scheme: null, pathname: "/example.js" }, tx: { matcher: { raw: "/foo/" } },
        rx: { content: Array(30).fill("foo").join(" "), startLine: 1, matched: 1, matches },
    };
    const meta = parseLogRecords(PacketWire.renderLog([row], tok))[0];
    assert.deepEqual(meta.matches, matches.map(({ region }) => ({ region: `<1,${region.startColumn},1,${region.endColumn}>` })), "every match location is evidence ({§tokenomics})");
    assert.equal(meta.matchLocationCount, undefined, "every location is shown, so no count summarises what is not");
    assert.deepEqual(row.rx.matches, matches, "the durable evidence stays complete");
});

test("{§read}: curating sparse READ lines also curates their match metadata", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/3", op: "READ", status: 200, folded: [[1, 1]],
        target: { scheme: null, pathname: "/example.js" }, tx: { matcher: { raw: "/foo/" } },
        rx: {
            content: "foo();\nfoo();", startLine: 3, lineOrdinals: [3, 7], matched: 2,
            matches: [3, 7].map((line) => ({
                region: { startLine: line, startColumn: 1, endLine: line, endColumn: 4 }, matched: "foo",
            })),
        },
    }], tok);
    assert.deepEqual(parseLogRecords(out)[0].matches, [{ region: "<7,1,7,4>" }]);
    assert.doesNotMatch(out, /3:foo/);
    assert.match(out, /7:foo/);
});

test("{§log-wire-format}: receipt headings carry only identity, resources, patterns and charge", () => {
    const matcher = String.raw`/\bexample\b/i`;
    const out = PacketWire.renderLog([{
        coordinate: "1/2/3", op: "READ", status: 200,
        target: { scheme: null, pathname: "/example.md" },
        tx: { lineMarker: { marks: [1, 16] }, matcher: { raw: matcher }, aside: "inspect example" },
        rx: { content: "example", matched: 1, range: { unit: "line", total: 24, requested: [1, 16], returned: [1, 16] } },
    }], tok);
    const [heading, factsLine, body] = out.split("\n");
    assert.equal(heading, `### log:///1/2/3/READ (example.md) ${matcher} · ${tok(out)}`);
    assert.deepEqual(JSON.parse(factsLine), { aside: "inspect example", matched: 1, range: "<1,16> of 24 lines" });
    assert.equal(body, "1:example");
    assert.doesNotMatch(out, /^READ\b/m, "an observation does not repeat an operation as an instruction");
});

test("{§log-wire-format}: operands and patterns stay on the heading while scope and opaque modifiers stay in JSON", () => {
    const matcher = String.raw`/(alpha|beta) → gamma/`;
    const metadata = JSON.stringify({ label: "(example.md) → result" });
    const out = PacketWire.renderLog([{
        coordinate: "1/2/4", op: "READ", status: 200,
        target: { scheme: null, pathname: "/docs/space (x).md" },
        tx: { lineMarker: { marks: [2, 4] }, metadata: [metadata], matcher: { raw: matcher }, aside: "keep (this) → unchanged" },
    }], tok);
    const [heading, factsLine] = out.split("\n");
    assert.equal(heading, `### log:///1/2/4/READ (docs/space %28x%29.md) ${matcher} · ${tok(out)}`);
    assert.deepEqual(JSON.parse(factsLine), { aside: "keep (this) → unchanged", metadata: [metadata], scope: "<2,4>" });

    const pathless = PacketWire.renderLog([{
        coordinate: "1/2/5", op: "FIND", status: 200,
        tx: { matcher: { raw: matcher }, aside: "no addressed operand" },
    }], tok);
    assert.equal(pathless, `### log:///1/2/5/FIND ${matcher} · ${tok(pathless)}\n{"aside":"no addressed operand"}`);
});

test("{§log-wire-format}: COPY selections retain their separate patterns, scopes and metadata", () => {
    const entry = {
        coordinate: "1/2/6", op: "COPY", status: 200,
        tx: {
            source: { target: { scheme: "workspace", pathname: "/notes" }, lineMarker: { marks: [2, 4] }, matcher: { raw: "/keep/" }, metadata: ['{"channel":"text"}'] },
            destination: { target: { scheme: "workspace", pathname: "/summary" }, lineMarker: { marks: [0] }, metadata: ['{"append":true}'] },
            aside: "publish\nfindings",
        },
    };
    const before = structuredClone(entry);
    const out = PacketWire.renderLog([entry], tok);
    const [heading, factsLine] = out.split("\n");
    assert.equal(heading, `### log:///1/2/6/COPY (workspace:///notes) /keep/ (workspace:///summary) · ${tok(out)}`);
    assert.deepEqual(JSON.parse(factsLine), {
        aside: "publish\nfindings",
        metadata: { from: ['{"channel":"text"}'], to: ['{"append":true}'] },
        scope: { from: "<2,4>", to: "<0>" },
    });
    assert.equal(out.split("\n").length, 2, "multiline asides cannot create a new record boundary");
    assert.deepEqual(entry, before, "packet rendering leaves the submitted operation intact");
});

test("{§log-wire-format}: rejected inputs stay in JSON and multiline patterns cannot split the heading", () => {
    const pattern = "alpha\nbeta";
    const out = PacketWire.renderLog([{
        coordinate: "1/2/7", op: "READ", status: 400,
        target: { scheme: "workspace", pathname: "/notes" },
        tx: { lineMarker: { marks: [1, 2, 3, 4, 5] }, metadata: ["not JSON"], matcher: { raw: pattern } },
        rx: { problem: { type: "about:blank", status: 400, title: "Invalid scope", detail: "Unsupported scope arity." } },
    }], tok);
    const [heading, factsLine] = out.split("\n");
    assert.equal(heading, `### log:///1/2/7/READ (workspace:///notes) ${JSON.stringify(pattern)} · ${tok(out)}`);
    const meta = JSON.parse(factsLine);
    assert.equal(meta.scope, "<1,2,3,4,5>");
    assert.deepEqual(meta.metadata, ["not JSON"]);
    assert.equal(meta.problem.detail, "Unsupported scope arity.");
    assert.equal(out.split("\n").length, 2);
});

test("{§log-wire-format}: addressed operands and record identities remain distinct across operation families", async (t) => {
    for (const op of ["READ", "FIND", "EDIT", "KILL", "SEND", "WORK", "FORK", "BARE", "WAIT", "gitea"]) {
        await t.test(op, () => {
            const address = op === "gitea" ? "list_issues" : "session://reviewer/notes.md";
            const out = PacketWire.renderLog([{
                coordinate: "1/2/3", op, status: 200,
                target: op === "gitea" ? { scheme: null, pathname: address }
                    : { scheme: "session", hostname: "reviewer", pathname: "/notes.md" },
                tx: { aside: "addressed operand", runtime: op, body: null },
            }], tok);
            const [heading] = out.split("\n");
            const row = parseLogRecords(out)[0];
            assert.equal(heading, `### log:///1/2/3/${op} (${address}) · ${tok(out)}`);
            assert.doesNotMatch(out, /→/u, "rendered records carry the operable parenthesized form and no arrow");
            assert.equal(row.aside, "addressed operand");
            assert.doesNotMatch(out, new RegExp(`^${op}\\b`, "m"), "the operation is named only by the record identity");
            assert.equal(row.path, address);
            assert.equal(row.target, undefined);
            assert.equal(row.log, undefined);
        });
    }
    const note = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/2/4", op: "NOTE", status: 200, target: null, tx: { body: "Retain this." },
    }], tok))[0];
    assert.equal(note.modifiers, undefined, "a pathless operation has no invented heading modifiers");
    assert.equal(note.path, undefined, "a pathless operation does not acquire its own log address as an operand");
});

test("{§log-wire-format}: COPY and MOVE operands do not overwrite the observed actor", () => {
    for (const op of ["COPY", "MOVE"]) {
        const metadata = parseLogRecords(PacketWire.renderLog([{
            coordinate: "1/2/3", op, status: 200, origin: "_plurnk", source: "session://child",
            tx: {
                source: { target: { scheme: "session", hostname: "child", pathname: "/notes.md" }, lineMarker: { marks: [2, 3] } },
                destination: { target: { scheme: "workspace", pathname: "/summary.md" }, lineMarker: { marks: [0] } },
                aside: "publish findings",
            },
        }], tok))[0];
        assert.equal(metadata.modifiers, "(session://child/notes.md) (workspace:///summary.md)");
        assert.equal(metadata.from, "session://child/notes.md");
        assert.equal(metadata.to, "workspace:///summary.md");
        assert.deepEqual(metadata.scope, { from: "<2,3>", to: "<0>" });
        assert.equal(metadata.aside, "publish findings");
        assert.equal(metadata.source, "session://child");
        assert.equal(metadata.path, undefined, "two operands are not collapsed into one path");
        assert.equal(metadata.destination, undefined);
    }
});

test("{§log-wire-format}: returned resource addresses remain distinct from authored targets without duplicate stream links", () => {
    const target = { scheme: "session", hostname: "peer", pathname: "" };
    const resource = "message://peer/1";
    const row = {
        coordinate: "1/2/3", op: "SEND", status: 200,
        target, tx: { body: "Please inspect this." }, rx: { resource },
    };
    const projected = parseLogRecords(PacketWire.renderLog([row], tok))[0];
    assert.equal(projected.resource, resource);
    assert.equal(projected.path, "session://peer");
    assert.equal(typeof projected.body, "string");
    assert.match(String(projected.body), /Please inspect this\./u);
    for (const absent of [undefined, "", "session://peer"]) {
        assert.equal(parseLogRecords(PacketWire.renderLog([{ ...row, rx: { resource: absent } }], tok))[0].resource, undefined);
    }
    const stream = "sh:///abcdef12";
    const execution = { ...row, op: "sh", target: null, attrs: { stream }, rx: { resource: stream } };
    const command = parseLogRecords(PacketWire.renderLog([execution], tok))[0];
    assert.equal(command.stream, stream);
    assert.equal(command.resource, undefined);
});

test("{§log-wire-format}: explicit and automatic READs share one resource-address shape", () => {
    const read = {
        coordinate: "1/2/3", op: "READ", status: 200,
        target: { scheme: "gitea", pathname: "/abcd1234" },
        rx: { content: "result", terminal: true, range: { unit: "line", total: 1, requested: [1, 16], returned: [1, 1] } },
    };
    const explicit = parseLogRecords(PacketWire.renderLog([read], tok))[0];
    const automatic = parseLogRecords(PacketWire.renderLog([{ ...read, origin: "_plurnk", attrs: { streamEnd: 6 } }], tok))[0];
    const { origin, tokens: automaticTokens, ...automaticFacts } = automatic;
    const { tokens: explicitTokens, ...explicitFacts } = explicit;
    assert.deepEqual(automaticFacts, explicitFacts);
    assert.equal(automatic.path, "gitea:///abcd1234");
    assert.equal(automatic.source, undefined);
    assert.equal(automatic.stream, undefined);
    assert.equal(origin, "_plurnk");
    assert.ok(automaticTokens > explicitTokens, "the extra producer fact is included in the row charge");
});

test("{§log-wire-format}: delivered attachments keep their resource paths without rewriting delivery evidence", () => {
    const attachments = [{ name: "report.pdf", mediaType: "application/pdf", target: "session://peer/artifacts/report.pdf" }];
    const before = structuredClone(attachments);
    const output = PacketWire.renderLog([{
        coordinate: "1/2/3", op: "SEND", status: 200,
        target: { scheme: "session", hostname: "peer", pathname: "" },
        tx: { body: "Here is the report." }, rx: { attachments },
    }], tok);
    const metadata = parseLogRecords(output)[0];
    assert.equal(metadata.path, "session://peer");
    assert.deepEqual(metadata.attachments, [{ name: "report.pdf", mediaType: "application/pdf", path: attachments[0].target }]);
    assert.deepEqual(attachments, before, "the durable/exterior attachment descriptor keeps its owning contract");
});

test("{§log-kill-scope}: sparse READ rendering keeps source numbers and matching anchors after further trimming", () => {
    const read = {
        coordinate: "1/1/1", op: "READ", origin: "model", status: 200,
        rx: { content: "two\nfour", mimetype: "text/plain", startLine: 2, lineOrdinals: [2, 4] },
        lineAnchors: ["@abcde", "@fghij"], lineNumberWidth: 1,
    };
    const complete = PacketWire.renderLog([read], tok);
    assert.match(complete, /2<@abcde>two\n4<@fghij>four/);
    const trimmed = PacketWire.renderLog([{ ...read, folded: [[1, 1]] }], tok);
    assert.match(trimmed, /4<@fghij>four/);
    assert.doesNotMatch(trimmed, /2:two|3:four/);
    assert.doesNotMatch(complete, /"lineOrdinals"/, "internal coordinate maps do not become packet trivia");
});

test("{§log-kill-scope}: suppressed rows charge only their materialized metadata", () => {
    const entry = {
        coordinate: "1/1/1", op: "READ", origin: "model", status: 200,
        initial_folded: [[1, -1]], rx: { content: "one\ntwo\nthree", mimetype: "text/plain", startLine: 1 },
    };
    const whole = parseLogRecords(PacketWire.renderLog([entry], tok))[0];
    const partial = parseLogRecords(PacketWire.renderLog([{ ...entry, folded: [[1, 2]] }], tok))[0];
    const gone = parseLogRecords(PacketWire.renderLog([{ ...entry, folded: [[1, -1]] }], tok))[0];
    for (const row of [whole, partial, gone]) {
        assert.deepEqual(facts(row), ["logPath", "tokens"], "hidden content carries its address and one charge");
        assert.ok(row.tokens > 0);
    }
    assert.equal(whole.tokens, tok(PacketWire.renderLog([entry], tok)), "metadata charge is exact");
    assert.equal(whole.body, undefined);
    assert.equal(partial.body, undefined);
    assert.equal(gone.body, undefined);
});
const revision = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const receipt = (context: string, requested = "<2>") => ({
    revision,
    unit: "lines",
    before: 4,
    after: 5,
    effect: {
        requested,
        source: "<2>",
        result: "<2,3>",
        removed: 1,
        inserted: 2,
        context,
    },
});
const creationReceipt = (context: string) => {
    const base = receipt(context, "<1,-1>");
    return {
        ...base,
        before: 0,
        after: 2,
        effect: {
            ...base.effect,
            source: "<1,1,1,1>",
            result: "<1,2>",
            removed: 0,
            inserted: 2,
        },
    };
};

test("{§packet-inject}: Git packet state names each class once, bounded, and untracked by its membership truth", () => {
    const out = PacketWire.renderGit({
        branch: "main", ahead: 1, behind: 0, staged: 1, unstaged: 1, untracked: 3,
        files: [
            { path: "staged.txt", status: "A " },
            { path: "tracked.md", status: " M" },
            { path: "docs/guide.md", status: "??", member: "docs/**" },
            { path: "notes.md", status: "??", member: null },
            { path: "out/report.md", status: "??", member: "created" },
        ],
    });
    assert.equal(
        out,
        "> [!NOTE]\n> branch `main` (↑1 ↓0) — 1 staged, 1 unstaged, 3 untracked\n"
        + "> staged: `staged.txt`\n"
        + "> unstaged: `tracked.md`\n"
        + "> untracked members: `docs/guide.md` (docs/**) · `out/report.md` (created)\n"
        + "> untracked (not members): `notes.md`",
    );
    const many = PacketWire.renderGit({
        branch: "main", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 10,
        files: Array.from({ length: 10 }, (_, i) => ({ path: `loose-${i}.txt`, status: "??" })),
    });
    assert.equal(many.split("\n").length, 3, "one note marker and one line per class, never one per path");
    assert.match(many, / \(\+2 more\)$/, "the class line is bounded by the panel");
    // {§packet-inject} — one knob is read by the renderer and by the marker that decides which
    // untracked paths the catalog names, so the two can never disagree.
    const prior = process.env.PLURNK_SERVICE_GIT_STATUS_PATHS;
    try {
        process.env.PLURNK_SERVICE_GIT_STATUS_PATHS = "3";
        const few = PacketWire.renderGit({
            branch: "main", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 10,
            files: Array.from({ length: 10 }, (_, i) => ({ path: `loose-${i}.txt`, status: "??" })),
        });
        assert.match(few, /`loose-2\.txt` \(\+7 more\)$/);
        assert.equal(GitState.renderedPaths(), 3);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_GIT_STATUS_PATHS; else process.env.PLURNK_SERVICE_GIT_STATUS_PATHS = prior;
    }
});

// Default-channel convention: when a channel's name matches its scheme's
// defaultChannel, its rendered target is path-only (no `#channel` suffix).
// The absence of a suffix IS the addressing of the default channel.

test("{§tokenomics} log entry: a no-body row omits body, display, model origin, and routine status — heading is log URI, path is action operand (#338)", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/1",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: null, pathname: "/out.txt" },
            rx: "{\"status\":200}",
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    const [row] = parseLogRecords(out);
    assert.equal(row?.logPath, "log:///1/1/1/EDIT");
    assert.equal(row?.path, "out.txt");
    assert.equal(typeof row?.tokens, "number");
    assert.equal(row?.body, undefined, "a none-state row has no coordinate lines");
    assert.equal(row?.origin, undefined, "model is the default origin");
    assert.equal(row?.status, undefined, "200 is the default status");
    assert.deepEqual(facts(row), ["logPath", "modifiers", "path", "tokens"], "the canonical path does not duplicate its operation in metadata");
});

test("{§log-wire-format}: all operations omit routine status 200 and preserve other outcomes", async (t) => {
    for (const op of ["NOTE", "READ", "FIND", "EDIT", "COPY", "MOVE", "KILL", "SEND", "WORK", "FORK", "WAIT", "BARE", "sh", "gitea"]) {
        for (const status of [102, 200, 201, 202, 204, 206, 304, 400, 409, 499, 500]) {
            await t.test(`{§log-wire-format} ${op} ${status}`, () => {
                const target = { scheme: "workspace", pathname: "/subject.md" };
                const entry = {
                    coordinate: "1/2/3", origin: "model", op, status, target,
                    tx: op === "COPY" || op === "MOVE" ? {
                        source: { target }, destination: { target: { scheme: "workspace", pathname: "/destination.md" } },
                    } : { body: "" },
                    rx: { status, ...(status < 400 ? {} : {
                        problem: { type: "about:blank", status, title: "Operation failed", detail: "The operation was refused." },
                    }) },
                };
                const before = structuredClone(entry);
                const out = PacketWire.renderLog([entry], tok);
                const row = parseLogRecords(out)[0];
                assert.equal(row.logPath, `log:///1/2/3/${op}`);
                assert.equal(Object.hasOwn(row, "status"), status !== 200);
                assert.equal(row.status, status === 200 ? undefined : status);
                assert.equal(row.tokens, tok(out), "the charge reflects the projected facts");
                if (status >= 400) assert.equal((row.problem as { detail: string }).detail, entry.rx.problem!.detail);
                assert.deepEqual(entry, before, "the stored result remains unchanged");
            });
        }
    }
});

test("{§log-wire-format}: a present operation aside materializes and absence costs no metadata", () => {
    const withAside = PacketWire.renderLog([{
        coordinate: "1/1/1",
        origin: "model",
        op: "sh", status: 200,
        tx: { runtime: "gitea", aside: "Lists issues", body: null },
    }], tok);
    assert.match(withAside, /^### log:\/\/\/1\/1\/1\/sh · \d+\n\{"aside":"Lists issues"\}$/, "the aside is a JSON fact, not heading syntax");

    const absent = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "sh", status: 200,
        tx: { runtime: "gitea", aside: null, body: null },
    }], tok);
    assert.doesNotMatch(absent, /"aside":/);
});

test("{§log-wire-format}: heading addresses precede the facts, and the facts keep one stable order", async (t) => {
    const read = {
        coordinate: "1/5/1", op: "READ", origin: "model", status: 200,
        target: { scheme: null, pathname: "/notes.md" },
        rx: {
            content: "prior thought",
            range: { unit: "line", total: 1, requested: [1, -1], returned: [1, 1] },
        },
    };
    const cases = [
        { name: "ordinary READ", entry: read, target: "notes.md" },
        { name: "FIND", entry: { ...read, op: "FIND" }, target: "notes.md" },
        {
            name: "FIND with an aside",
            entry: { ...read, op: "FIND", tx: { aside: "project root member files" } },
            target: "notes.md",
        },
        {
            name: "EDIT with an aside",
            entry: { ...read, op: "EDIT", tx: { aside: "update notes" } },
            target: "notes.md",
        },
        {
            name: "harness reasoning READ with an aside",
            entry: {
                ...read, origin: "_plurnk", source: "session://child",
                target: { scheme: "reasoning", hostname: "alice", pathname: "/1/4" },
                tx: { aside: "Prior reasoning", body: null },
            },
            target: "reasoning://alice/1/4",
        },
        { name: "suppressed READ", entry: { ...read, initial_folded: [[1, -1]] }, target: "notes.md" },
        {
            name: "failed READ",
            entry: {
                ...read, status: 404,
                rx: { problem: { type: "about:blank", title: "Not Found", status: 404, detail: "No entry at notes.md." } },
            },
            target: "notes.md",
        },
    ];
    for (const { name, entry, target } of cases) {
        await t.test(name, () => {
            const out = PacketWire.renderLog([entry], tok);
            const [heading, factsLine] = out.split("\n");
            const row = parseLogRecords(out)[0];
            const aside = "tx" in entry ? entry.tx.aside : undefined;
            assert.equal(heading, `### log:///1/5/1/${entry.op} (${target}) · ${tok(out)}`);
            assert.equal(row.path, target);
            assert.equal(row.aside, aside);
            if (factsLine !== undefined && factsLine.startsWith("{")) {
                const keys = Object.keys(JSON.parse(factsLine) as object);
                assert.deepEqual(keys, [...keys].toSorted(), "result facts keep stable alphabetical order");
            }
            assert.equal(row.tokens, tok(out), "the heading's charge prices the complete row");
            assert.equal(PacketWire.renderLog([entry], tok), out, "unchanged facts keep stable packet bytes");
        });
    }

    for (const tx of [{ runtime: "sh" }, { runtime: "sh", aside: "no resource target" }]) {
        const entry = { ...read, op: "sh", target: null, tx };
        const out = PacketWire.renderLog([entry], tok);
        const [heading] = out.split("\n");
        assert.equal(heading, `### log:///1/5/1/sh · ${tok(out)}`);
        const row = parseLogRecords(out)[0];
        assert.equal(Object.hasOwn(row, "path"), false, "the row never invents a target");
    }
});

test("{§packet}: section headings are separated from content without separating receipt identity from metadata", () => {
    const log = PacketWire.renderLog([{
        coordinate: "1/2/1", op: "READ", origin: "model", status: 200,
        target: { scheme: null, pathname: "/notes.md" }, rx: { content: "notes" },
    }], tok);
    const packet = PacketWire.renderSlot([
        { slot: "user", header: "Log", content: log },
        { slot: "user", header: "Context", content: "tokens: 100\n" },
        { slot: "user", header: "Empty", content: "" },
        { slot: "user", header: null, content: "bare\n" },
    ], "user");
    assert.equal(packet, `## Log\n\n${log}\n\n## Context\n\ntokens: 100\n\nbare`);
    assert.match(packet, /### log:\/\/\/1\/2\/1\/READ \(notes\.md\) · \d+\n1:notes/u);
});

test("{§tokenomics} environment-delta provenance renders as source", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "_plurnk",
        source: "file",
        op: "EDIT",
        status: 200,
        target: { scheme: null, pathname: "/out.txt" },
        rx: "changed",
        attrs: { git: " M" },
    }], tok);
    assert.match(out, /"source":"file"/);
    assert.match(out, /"git":" M"/, "the causal row carries the exact staged/worktree coordinates");
    assert.deepEqual(facts(parseLogRecords(out)[0]), ["git", "logPath", "modifiers", "origin", "path", "source", "tokens"]);
});

test("{§fs-namespace} an execution receipt names its working directory project-relative, and never at the root", () => {
    const row = (cwd: string) => ({
        coordinate: "1/1/3", origin: "model", op: "sh", status: 200, target: null,
        tx: { runtime: "sh" },
        rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", cwd, stream: "sh:///1/1/3/sh" },
    });
    const atRoot = PacketWire.renderLog([row("/host/proj")], tok, { projectRoot: "/host/proj" });
    assert.doesNotMatch(atRoot, /"cwd":/, "the default project directory is not repeated");
    assert.doesNotMatch(atRoot, /\/host\/proj/, "the receipt does not expose a redundant absolute directory");
    const below = PacketWire.renderLog([row("/host/proj/pkg/inner")], tok, { projectRoot: "/host/proj" });
    assert.match(below, /"cwd":"pkg\/inner"/, "a subdirectory is spelled the way the model would write it");
    assert.doesNotMatch(below, /\/host\/proj/);
    const outside = PacketWire.renderLog([row("/host/other")], tok, { projectRoot: "/host/proj" });
    assert.match(outside, /"cwd":"\.\.\/other"/, "outside the root is parent traversal, as in the (path) slot");
    const rootless = PacketWire.renderLog([row("/daemon/cwd")], tok, { projectRoot: null });
    assert.doesNotMatch(rootless, /"cwd":|\/daemon/, "a workspace without a root has nothing to name");
});

test("{§exec-stream}: a terminal stream observation states completion truth without inventing narration", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/4",
        origin: "_plurnk",
        op: "READ",
        status: 200,
        target: { scheme: "sh", pathname: "/1/1/3/sh", fragment: "stdout" },
        rx: {
            status: 200,
            terminal: true,
            exitCode: 0,
            content: "",
            mimetype: "text/stream",
            range: { unit: "line", total: 0, requested: [1, 16] },
        },
        attrs: { streamEnd: 0 },
    }], tok);
    assert.match(out, /"exitCode":0/, "the executor's exact terminal fact survives packet projection");
    assert.doesNotMatch(out, /"source":/, "invocation correlation is not another content source");
    assert.match(out, /"terminal":true/, "an empty successful stream remains visibly conclusive");
    assert.doesNotMatch(out, /"page"/, "no page fact is invented for a result that carries none");
    // {§executor-results} — a producer's full-page fact survives projection as written.
    const paged = PacketWire.renderLog([{
        coordinate: "1/2/5", origin: "_plurnk", op: "READ", status: 200,
        target: { scheme: "gitea", pathname: "/1/1/4/gitea", fragment: "result" },
        rx: { status: 200, terminal: true, page: { size: 30, returned: 30 }, content: "", mimetype: "application/json" },
        attrs: { streamEnd: 0 },
    }], tok);
    assert.deepEqual(parseLogRecords(paged)[0].page, { size: 30, returned: 30 }, "a full page is visible as possibly partial");
    for (const page of [null, 30, { size: 30 }, { size: "30", returned: 30 }]) {
        assert.throws(() => PacketWire.renderLog([{ coordinate: "1/2/5", op: "READ", status: 200, target: { scheme: "gitea", pathname: "/1/1/4/gitea" }, rx: { terminal: true, page } }], tok),
            /stream READ result carries a malformed page/);
    }
    assert.match(out, /^### log:\/\/\/\S+\/READ \(sh:\/\/\/1\/1\/3\/sh#stdout\) · \d+$/m, "automatic and explicit READs identify the read resource identically");
    assert.deepEqual(parseLogRecords(out).map(facts), [["exitCode", "logPath", "modifiers", "origin", "path", "range", "terminal", "tokens"]], "a READ has one resource-address dialect");
    assert.doesNotMatch(out, /completed|success/i, "the receipt exposes facts without adding presumptuous narration");
});

test("{§exec-stream}: malformed liveness facts fail at packet projection", () => {
    const row = { coordinate: "1/2/1", op: "READ", status: 200, target: { scheme: "sh", pathname: "/abcdef12" } };
    for (const terminal of [null, "false", 0, 1]) {
        assert.throws(() => PacketWire.renderLog([{ ...row, rx: { terminal } }], tok),
            /stream READ result carries a malformed terminal flag/);
    }
    for (const exitCode of [null, "0", 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => PacketWire.renderLog([{ ...row, rx: { terminal: true, exitCode } }], tok),
            /stream READ result carries a malformed exitCode/);
    }
});

test("{§exec-stream}: a harness-authored READ is not implicitly a subscription publication", () => {
    const [row] = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "_plurnk", op: "READ", status: 200,
        target: { scheme: "sh", pathname: "/abcdef12" },
        rx: { status: 200, terminal: true, exitCode: 0, content: "" },
        attrs: {},
    }], tok));
    assert.equal(row?.path, "sh:///abcdef12");
    assert.equal(row?.stream, undefined);
    assert.equal(row?.terminal, true);
    assert.equal(row?.exitCode, 0);
});

test("{§scheme-address}: a body-suppressed web identity renders https://host, never https:///host", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/9", origin: "model", op: "EDIT", status: 200,
        target: { scheme: "https", hostname: "en.wikipedia.org", pathname: "/wiki/Paris" },
        rx: { status: 200 },
    }], tok);
    assert.match(out, /^### log:\/\/\/1\/1\/9\/EDIT \(https:\/\/en\.wikipedia\.org\/wiki\/Paris\) · \d+$/m, "the authority form, one spelling");
});

test("{§tokenomics} model-facing targets escape literal URI delimiters without rewriting percent-encoded identity", () => {
    const target = {
        kind: "url",
        scheme: "https",
        hostname: "example.test",
        pathname: "/x",
        query: "literal=)&encoded=%29",
        fragment: "preview(",
    };
    const out = PacketWire.renderLog([{
        coordinate: "1/1/10",
        origin: "model",
        op: "COPY",
        status: 304,
        target,
        tx: {
            source: { target, metadata: null, lineMarker: null },
            destination: { target, metadata: null, lineMarker: null },
        },
        rx: { status: 304 },
    }], tok);
    const spelling = String.raw`https://example.test/x?literal=\)&encoded=%29#preview\(`;
    assert.equal(out.split(`(${spelling})`).length, 3, "both operands are written with the same escaped spelling");
});

test("{§tokenomics} COPY/MOVE render operand selections and scoped textual materialization receipts", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/5",
        origin: "model",
        op: "COPY",
        status: 200,
        target: { scheme: "workspace", pathname: "/source" },
        tx: {
            source: {
                target: { scheme: "workspace", pathname: "/source" },
                metadata: null,
                lineMarker: { marks: [2, 3] },
            },
            destination: {
                target: { scheme: "workspace", pathname: "/draft" },
                metadata: null,
                lineMarker: { marks: [0] },
            },
        },
        rx: {
            status: 200,
            effects: [{
                target: "workspace:///draft",
                action: "update",
                receipt: {
                    ...receipt("1:before\n2:copied content"),
                    parseIssues: { before: 0, after: 3 },
                },
            }],
        },
    }], tok);
    assert.match(out, /^### log:\/\/\/1\/2\/5\/COPY \(workspace:\/\/\/source\) \(workspace:\/\/\/draft\) · \d+$/m);
    assert.deepEqual(parseLogRecords(out)[0].scope, { from: "<2,3>", to: "<0>" });
    assert.doesNotMatch(out, /"path":"workspace:\/\/\/source"/);
    assert.match(
        out,
        /"effects":\[\{"path":"workspace:\/\/\/draft","action":"update","extent":"lines 4->5","parseIssues":"0->3","change":"lines -1 \+2","effect":"<2> -> <2,3>"\}\]/,
    );
    assert.match(
        out,
        /\n1:before\n2:copied content$/,
        "the regional effect exposes its bounded resulting context",
    );

    const whole = PacketWire.renderLog([{
        coordinate: "1/2/6",
        origin: "model",
        op: "MOVE",
        status: 200,
        target: { scheme: "workspace", pathname: "/source" },
        tx: {
            source: {
                target: { scheme: "workspace", pathname: "/source" },
                metadata: null,
                lineMarker: { marks: [1, -1] },
            },
            destination: {
                target: { scheme: "workspace", pathname: "/destination" },
                metadata: null,
                lineMarker: null,
            },
        },
        rx: {
            status: 200,
            effects: [
                { target: "workspace:///destination", action: "create" },
                { target: "workspace:///source", action: "delete" },
            ],
        },
    }], tok);
    assert.match(
        whole,
        /"effects":\[\{"path":"workspace:\/\/\/destination","action":"create"\},\{"path":"workspace:\/\/\/source","action":"delete"\}\]/,
    );
    assert.match(whole, /^### log:\/\/\/\S+\/MOVE \(workspace:\/\/\/source\) \(workspace:\/\/\/destination\) · \d+$/m, "both operands are written without scope syntax");
    assert.deepEqual(parseLogRecords(whole)[0].scope, { from: "<1,-1>" });
    assert.doesNotMatch(whole, /"body":/, "whole-channel effects invent no text receipt — none-state is body absence (#338)");

    const created = PacketWire.renderLog([{
        coordinate: "1/2/7",
        origin: "model",
        op: "COPY",
        status: 201,
        target: { scheme: "workspace", pathname: "/source" },
        tx: {
            source: {
                target: { scheme: "workspace", pathname: "/source" },
                metadata: null,
                lineMarker: { marks: [2, 3] },
            },
            destination: {
                target: { scheme: "workspace", pathname: "/created" },
                metadata: null,
                lineMarker: null,
            },
        },
        rx: {
            status: 201,
            effects: [{
                target: "workspace:///created",
                action: "create",
                receipt: creationReceipt("1:two\n2:three"),
            }],
        },
    }], tok);
    assert.match(created, /\(workspace:\/\/\/source\) \(workspace:\/\/\/created\) ·/);
    assert.deepEqual(parseLogRecords(created)[0].scope, { from: "<2,3>" });
    assert.match(created, /"action":"create"[^}]*"effect":"<1,1,1,1> -> <1,2>"/);
    assert.match(created, /1:two\n2:three/);

    const unchanged = PacketWire.renderLog([{
        coordinate: "1/2/8",
        origin: "model",
        op: "COPY",
        status: 304,
        target: { scheme: "workspace", pathname: "/source" },
        tx: {
            source: {
                target: { scheme: "workspace", pathname: "/source" },
                metadata: null,
                lineMarker: { marks: [2, 3] },
            },
            destination: {
                target: { scheme: "workspace", pathname: "/created" },
                metadata: null,
                lineMarker: null,
            },
        },
        rx: { status: 304 },
    }], tok);
    assert.match(unchanged, /\(workspace:\/\/\/source\) \(workspace:\/\/\/created\) ·/);
    assert.deepEqual(parseLogRecords(unchanged)[0].scope, { from: "<2,3>" });
    assert.doesNotMatch(unchanged, /"effects"/);
    assert.doesNotMatch(unchanged, /"body":/, "none-state is body absence (#338)");
});

test("{§tokenomics} COPY/MOVE retain authored line anchors in durable operand selections", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/10",
        origin: "model",
        op: "COPY",
        status: 200,
        target: { scheme: "workspace", pathname: "/source" },
        tx: {
            source: {
                target: { scheme: "workspace", pathname: "/source" },
                metadata: null,
                lineMarker: { marks: ["@aZ09b", "@0Aa9Z"] },
            },
            destination: {
                target: { scheme: "workspace", pathname: "/destination" },
                metadata: null,
                lineMarker: { marks: ["@10Zyx", 4, "@zY01A", 4] },
            },
        },
        rx: {
            status: 200,
            effects: [{
                target: "workspace:///destination",
                action: "update",
                receipt: receipt("1:copied content"),
            }],
        },
    }], tok);

    assert.match(out, /\(workspace:\/\/\/source\) \(workspace:\/\/\/destination\) ·/);
    assert.deepEqual(parseLogRecords(out)[0].scope, { from: "<@aZ09b,@0Aa9Z>", to: "<@10Zyx,4,@zY01A,4>" });
});

test("{§tokenomics} a reviewer-rewritten same-resource MOVE renders one replacement effect and both operands (#172)", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/9",
        origin: "model",
        op: "MOVE",
        status: 200,
        target: { scheme: "workspace", pathname: "/document" },
        tx: {
            source: {
                target: { scheme: "workspace", pathname: "/document" },
                metadata: null,
                lineMarker: { marks: [1, 2, 1, 4] },
            },
            destination: {
                target: { scheme: "workspace", pathname: "/document" },
                metadata: null,
                lineMarker: { marks: [1, 7, 1, 7] },
            },
        },
        rx: {
            status: 200,
            effects: [{
                target: "workspace:///document",
                action: "update",
                receipt: {
                    revision,
                    unit: "lines",
                    before: 1,
                    after: 2,
                    disposition: "superseded",
                    requested: "<1,7,1,7>",
                    replacement: {
                        requested: "<1,-1>",
                        source: "<1>",
                        result: "<1,2>",
                        removed: 1,
                        inserted: 2,
                        context: "1:reviewer\n2:replacement",
                    },
                },
            }],
        },
    }], tok);

    assert.match(out, /\(workspace:\/\/\/document\) \(workspace:\/\/\/document\) ·/);
    assert.deepEqual(parseLogRecords(out)[0].scope, { from: "<1,2,1,4>", to: "<1,7,1,7>" });
    assert.match(
        out,
        /"effects":\[\{"path":"workspace:\/\/\/document","action":"update","extent":"lines 1->2","disposition":"superseded","requested":"<1,7,1,7>","change":"lines -1 \+2","replacement":"<1> -> <1,2>"\}\]/,
    );
    assert.equal(out.match(/1:reviewer/g)?.length, 1);
    assert.equal(out.match(/2:replacement/g)?.length, 1);
});

test("{§tokenomics} log entry: a session:// spawn renders the session NAME in the addressed operand", () => {
    // The spawn-blindness root cause: the session name lives in the URI authority (session://<name>),
    // not the path. Rendering scheme+path alone collapsed every spawn to a bare `session://`, so the
    // model could not tell session_db from session_pool in its own log and re-spawned. The authority
    // must reach the rendered target.
    const out = PacketWire.renderLog([
        { coordinate: "1/1/9", origin: "model", op: "EDIT", status: 200, target: { scheme: "session", hostname: "session_db", pathname: "" } },
        { coordinate: "1/1/10", origin: "model", op: "EDIT", status: 200, target: { scheme: "session", hostname: "session_pool", pathname: "" } },
    ], tok);
    assert.match(out, /^### log:\/\/\/1\/1\/9\/EDIT \(session:\/\/session_db\) · \d+$/m, "the spawned session name reaches the model's log");
    assert.match(out, /^### log:\/\/\/1\/1\/10\/EDIT \(session:\/\/session_pool\) · \d+$/m, "distinct sessions render distinctly — no bare session://");
    assert.doesNotMatch(out, /\(session:\/\/\)/, "no nameless session:// rows (the blindness)");
});

test("{§tokenomics} log entry: a web host survives into the target — http://host/path, not http:///path", () => {
    // Same render path, same bug class: an authority-bearing scheme keeps its host in `hostname`.
    const out = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "READ", status: 200, target: { scheme: "https", hostname: "en.wikipedia.org", pathname: "/wiki/Paris" } },
    ], tok);
    assert.match(out, /^### log:\/\/\/1\/1\/1\/READ \(https:\/\/en\.wikipedia\.org\/wiki\/Paris\) · \d+$/m, "the web host reaches the rendered target");
});

test("{§tokenomics} log entry: network target preserves port, ordered query, and channel fragment", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "READ",
        status: 200,
        target: {
            scheme: "https",
            hostname: "example.org",
            port: 8443,
            pathname: "/a(b)",
            query: "b=2&a=1&a=3",
            fragment: "preview",
        },
    }], tok);
    assert.match(out, /^### log:\/\/\/1\/1\/2\/READ \(https:\/\/example\.org:8443\/a%28b%29\?b=2&a=1&a=3#preview\) · \d+$/m);
});

test("{§tokenomics} log render: READ@200 with text/markdown rx body → line-numbered Markdown content", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "/notes.md" },
            rx: { content: "hello\nworld", mimetype: "text/markdown", startLine: 1 },
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    // Line-navigable mimetype → `N:` prefix per line.
    assert.equal(parseLogRecords(out)[0]?.body, "1:hello\n2:world\n");
});

test("{§log-wire-format}: a READ beginning with a blank source line numbers every physical line", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "https", hostname: "example.test", pathname: "/article" },
        rx: {
            status: 200,
            content: "\nLead paragraph.\n\nFollowing paragraph.",
            mimetype: "text/markdown",
            startLine: 300,
        },
    }], tok);

    assert.equal(
        parseLogRecords(out)[0]?.body,
        "300:\n301:Lead paragraph.\n302:\n303:Following paragraph.\n",
    );
});

test("{§tokenomics} log render: a scoped READ preserves its complete source TextRegion", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "workspace", pathname: "/unicode" },
        rx: {
            status: 200,
            content: "😀",
            mimetype: "text/markdown",
            startLine: 1,
            region: {
                startLine: 1,
                startColumn: 2,
                endLine: 1,
                endColumn: 3,
            },
        },
    }], tok);
    assert.match(
        out,
        /"range":"<1,2,1,3>"/,
    );
    assert.equal(parseLogRecords(out)[0]?.body, "1:😀\n");
});

test("{§diagnostic-observation} a failed content-bearing READ renders a compact Problem and diagnostic body", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "_plurnk",
        op: "READ",
        status: 500,
        target: { scheme: "sh", pathname: "/1/1/2/sh", fragment: "stderr" },
        rx: {
            status: 500,
            problem: {
                type: "https://problems.plurnk.xyz/executor/subprocess/terminated-by-signal",
                title: "Terminated by signal",
                status: 500,
                detail: "'sh' was terminated by SIGKILL.",
                instance: "ops://session/2",
                stage: "execution",
                recovery: "Inspect the stdout and stderr channels.",
                retryable: false,
                exitCode: -1,
                target: "sh:///1/1/2/sh#stderr",
            },
            content: "main.go:17: undefined: os",
            mimetype: "text/stream",
            startLine: 1,
        },
        folded: [],
    }], tok);

    const [meta] = parseLogRecords(out);
    assert.notEqual(meta, undefined);
    assert.deepEqual(meta.problem, {
        type: "https://problems.plurnk.xyz/executor/subprocess/terminated-by-signal",
        detail: "'sh' was terminated by SIGKILL.",
        stage: "execution",
        recovery: "Inspect the stdout and stderr channels.",
        retryable: false,
        exitCode: -1,
    });
    assert.equal(meta.status, 500, "the enclosing row owns status");
    assert.equal(meta.logPath, "log:///1/2/1/READ", "the enclosing row owns occurrence identity");
    assert.equal(meta.path, "sh:///1/1/2/sh#stderr", "the enclosing row owns an identical target fact");
    assert.deepEqual(facts(meta), ["body", "logPath", "modifiers", "origin", "path", "problem", "status", "tokens"], "the Problem Details ride whole beside the row's own facts");
    assert.equal(typeof meta.body, "string", "an open row carries coordinate lines — presence IS the state (#338)");
    assert.match(out, /1:main\.go:17: undefined: os/, "failure status never erases diagnostic content");
});

// {§channel-selection} — a READ row names the resource's other channels with tokens.
test("{§log-wire-format} log render: a READ row carries its sibling channels", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "workspace", pathname: "/page.html" },
        tx: { target: { scheme: "workspace", pathname: "/page.html" }, lineMarker: null, matcher: null, body: null },
        rx: { content: "<html></html>", mimetype: "text/html", startLine: 1, channels: { "#readable": 812 }, range: { unit: "line", total: 1, requested: [1, 16], returned: [1, 1] } },
    }], tok);
    assert.match(out, /"channels":\{"#readable":812\}/);
});

// {§log-wire-format} {§edit-pattern} — a pattern mutation names its matcher and count.
test("{§tokenomics} log render: a pattern EDIT carries its matcher and matched count beside the receipt", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "EDIT",
        status: 200,
        target: { scheme: "workspace", pathname: "/notes.md" },
        tx: { target: { scheme: "workspace", pathname: "/notes.md" }, matcher: { dialect: "glob", raw: "foo" }, lineMarker: null, body: "baz" },
        rx: { status: 200, matched: 3, receipt: receipt("1:alpha baz\n2:baz bar", "<1,7,1,10>") },
    }], tok);
    assert.match(out, /^### log:\/\/\/\S+\/EDIT \(workspace:\/\/\/notes\.md\) foo · \d+$/m, "a literal pattern is descriptive text, not an OP modifier");
    assert.match(out, /"matched":3/);
    assert.deepEqual(parseLogRecords(out).map(facts), [["body", "change", "effect", "extent", "lines", "logPath", "matched", "matcher", "modifiers", "path", "tokens"]]);
});

test("{§tokenomics} log render: a matcher FIND exposes surgical coordinates", () => {
    const matches = [
        { region: { startLine: 143, startColumn: 1, endLine: 143, endColumn: 8 } },
        { region: { startLine: 617, startColumn: 4, endLine: 617, endColumn: 11 } },
    ];
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "FIND",
        status: 200,
        target: { scheme: null, pathname: "/spec.md" },
        tx: { matcher: { raw: "/overflow/" } },
        rx: {
            content: JSON.stringify(matches),
            mimetype: "application/json",
            startLine: 1,
            matchingPathCount: 1,
            matchLocationCount: 2,
            range: {
                unit: "matchLocation",
                total: 2,
                requested: [1, 16],
                returned: [1, 2],
            },
        },
    }], tok);
    assert.match(out, /^### log:\/\/\/1\/1\/3\/FIND \(spec\.md\) \/overflow\/ · \d+$/m);
    assert.doesNotMatch(out, /"matchingPathCount":/);
    assert.doesNotMatch(out, /"matchLocationCount":/);
    assert.doesNotMatch(out, /"items":|"lines":/);
    assert.match(out, /"range":"2 match locations"/);
    assert.match(String(parseLogRecords(out)[0]?.body), /^1:\[\{"region":\{"startLine":143/);
});

test("{§zero-width-column-one-insert}: FIND ordinals retain page coordinates and complete-result alignment", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "FIND",
        status: 200,
        target: { scheme: "workspace", pathname: "/**" },
        tx: { body: null },
        rx: {
            content: '[{"path":"workspace:///q.md"},\n{"path":"workspace:///r.md"}]',
            mimetype: "application/json",
            range: {
                unit: "resource",
                total: 100,
                requested: [17, 18],
                returned: [17, 18],
            },
        },
    }], tok);

    assert.equal(
        parseLogRecords(out)[0]?.body,
        ' 17:[{"path":"workspace:///q.md"},\n 18:{"path":"workspace:///r.md"}]\n',
    );
    assert.doesNotMatch(out, /\n1:\[\{/,
        "a later page never invents page-local result ordinals");
});

test("{§log-wire-format}: every READ/FIND mode has one concise metadata owner", async () => {
    const region = { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 };
    const lineRegion = { startLine: 17, startColumn: 1, endLine: 18, endColumn: 1 };
    const rows = [
        {
            coordinate: "1/1/1", origin: "model", op: "READ", status: 200, initial_folded: [[1, -1]],
            target: { scheme: null, pathname: "/lines.md" },
            rx: {
                content: "alpha\n\n", mimetype: "text/markdown", startLine: 17, region: lineRegion,
                range: { unit: "line", total: 600, requested: [17, 18], returned: [17, 18] },
            },
        },
        {
            coordinate: "1/1/2", origin: "model", op: "READ", status: 200, initial_folded: [[1, -1]],
            target: { scheme: null, pathname: "/exact.md" },
            rx: { content: "alpha", mimetype: "text/markdown", startLine: 2, region },
        },
        {
            coordinate: "1/1/3", origin: "model", op: "FIND", status: 200, initial_folded: [[1, -1]],
            target: { scheme: "workspace", pathname: "/**" }, tx: { body: null },
            rx: {
                content: '[{"path":"workspace:///a"}]', mimetype: "application/json",
                itemsWeightTotal: 80, returnedItemsWeightTotal: 80,
                matchingPathCount: 1, matchLocationCount: 0,
                range: { unit: "resource", total: 1, requested: [1, 16], returned: [1, 1] },
            },
        },
        {
            coordinate: "1/1/4", origin: "model", op: "FIND", status: 200, initial_folded: [[1, -1]],
            target: { scheme: "workspace", pathname: "/**" }, tx: { matcher: { raw: "/target/" } },
            rx: {
                content: '[{"path":"workspace:///a","matchLocationCount":2}]', mimetype: "application/json",
                itemsWeightTotal: 1_000, returnedItemsWeightTotal: 400,
                matchingPathCount: 20, matchLocationCount: 42,
                range: { unit: "resource", total: 20, requested: [1, 16], returned: [1, 16] },
            },
        },
        {
            coordinate: "1/1/5", origin: "model", op: "FIND", status: 200, initial_folded: [[1, -1]],
            target: { scheme: null, pathname: "/exact.md" }, tx: { matcher: { raw: "/target/" } },
            rx: {
                content: `[${JSON.stringify({ region })}]`, mimetype: "application/json",
                itemsWeightTotal: 80, returnedItemsWeightTotal: 80,
                matchingPathCount: 1, matchLocationCount: 1,
                range: { unit: "matchLocation", total: 1, requested: [1, 16], returned: [1, 1] },
            },
        },
        {
            coordinate: "1/1/6", origin: "_plurnk", op: "FIND", status: 200, initial_folded: [[1, -1]],
            target: { scheme: "workspace", pathname: "/missing/**" }, tx: { body: null },
            rx: {
                content: "[]", mimetype: "application/json",
                itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
                range: { unit: "resource", total: 0, requested: [1, 16] },
            },
        },
        {
            coordinate: "1/1/7", origin: "model", op: "READ", status: 416, initial_folded: [[1, -1]],
            target: { scheme: null, pathname: "/lines.md" },
            rx: {
                content: null,
                mimetype: "text/markdown",
                range: { unit: "line", total: 8, requested: [99, 99] },
                problem: {
                    type: "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable",
                    title: "Range Not Satisfiable",
                    status: 416,
                    detail: "Line 99 is outside the available line range 1..8.",
                    range: { unit: "line", total: 8, requested: [99, 99] },
                    stage: "projection",
                    recovery: "Choose a range within the available extent.",
                    retryable: false,
                },
            },
        },
    ];
    const metadata = rows.map((row) => {
        const rendered = PacketWire.renderLog([row], tok);
        const metaLine = rendered.split("\n").find((line) => line.startsWith("{"));
        if (metaLine === undefined) throw new Error("A body-suppressed retrieval row did not render JSON metadata.");
        return JSON.parse(metaLine) as Record<string, unknown>;
    });
    const [lineRead, exactRead, catalogFind, broadFind, exactFind, emptyFind, failedRead] = metadata;

    assert.equal(lineRead?.range, "<17,18> of 600 lines");
    assert.equal(Object.hasOwn(lineRead ?? {}, "region"), false, "a whole-line region does not compete with its range");
    assert.equal(Object.hasOwn(lineRead ?? {}, "lines"), false, "a terminal blank line cannot create a second visible count");
    assert.equal(exactRead?.range, "<2,1,2,6>");
    assert.equal(Object.hasOwn(exactRead ?? {}, "region"), false);
    assert.equal(Object.hasOwn(exactRead ?? {}, "lines"), false);

    assert.equal(catalogFind?.range, "1 resource");
    assert.equal(catalogFind?.itemsTokenTotal, 80);
    assert.equal(Object.hasOwn(catalogFind ?? {}, "returnedItemsTokenTotal"), false);
    assert.equal(broadFind?.range, "<1,16> of 20 resources");
    assert.equal(broadFind?.matchLocationCount, 42);
    assert.equal(broadFind?.returnedItemsTokenTotal, 400);
    assert.equal(exactFind?.range, "1 match location");
    assert.equal(Object.hasOwn(exactFind ?? {}, "matchLocationCount"), false);
    assert.equal(Object.hasOwn(exactFind ?? {}, "returnedItemsTokenTotal"), false);
    assert.equal(emptyFind?.range, "0 resources");
    for (const find of [catalogFind, broadFind, exactFind, emptyFind]) {
        assert.equal(Object.hasOwn(find ?? {}, "items"), false);
        assert.equal(Object.hasOwn(find ?? {}, "lines"), false);
        assert.equal(Object.hasOwn(find ?? {}, "matchingPathCount"), false);
    }
    for (const field of ["itemsTokenTotal", "returnedItemsTokenTotal", "matchLocationCount"]) {
        assert.equal(Object.hasOwn(emptyFind ?? {}, field), false);
    }
    assert.deepEqual((failedRead?.problem as { range?: unknown } | undefined)?.range, {
        unit: "line", total: 8, requested: [99, 99],
    });
    assert.equal(Object.hasOwn(failedRead ?? {}, "range"), false, "the Problem owns a failed retrieval's extent");
    for (const row of metadata) {
        for (const redundant of ["available", "complete", "next", "all"]) {
            assert.equal(Object.hasOwn(row, redundant), false);
        }
    }

    const metadataWeight = contentWeight(metadata.map((row) => JSON.stringify(row)).join("\n"));
    assert.equal(metadataWeight, METADATA_WEIGHT, "canonical retrieval metadata uses the reviewed scope projection");

    assert.throws(
        () => PacketWire.renderLog([{
            ...rows[0],
            rx: {
                content: "alpha",
                range: { unit: "line", total: 1, requested: [1, 16], returned: [1, 2] },
            },
        }], tok),
        /RangeExtent returned positions must be ordered within total/,
        "a malformed producer extent cannot enter the model packet",
    );
});

test("{§tokenomics} log render: READ@200 with application/json is line-addressable", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "/notes.md" },
            rx: { content: '[\n  {"line":1,"matched":"hello"}\n]', mimetype: "application/json" },
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    assert.equal(
        parseLogRecords(out)[0]?.body,
        '1:[\n2:  {"line":1,"matched":"hello"}\n3:]\n',
    );
});

// EDIT log renders expose bounded resulting context in coordinate lines.
// No udiff in the model's
// packet (that format belongs in client communication, where humans want
// colored before/after rendering).

test("{§tokenomics} log render: EDIT@200 with rx.span → wraps the pre-numbered span verbatim (editedSpan owns the offsets)", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "EDIT",
        status: 200,
        target: { scheme: "workspace", pathname: "/plan.md" },
        rx: { status: 200, span: "3:- [x] ship the fix" },  // editedSpan emits N: with the changed region's REAL offset
    }], tok);
    // The model sees the edited area as it looks NOW at its TRUE line numbers — editedSpan already
    // line-numbered it, so the renderer wraps verbatim. Re-numbering here would double it (1:3:…)
    // and lose the real position. A span-less EDIT — a scheme that returns no span — stands on its
    // metadata line alone; its classifications remain metadata, not body content.
    assert.equal(parseLogRecords(out)[0]?.body, "3:- [x] ship the fix\n", "EDIT preserves the pre-numbered span verbatim");
    assert.doesNotMatch(out, /1:3:/, "must NOT re-number an already-numbered span");
});

test("{§tokenomics} log render: model EDIT receipt renders its extent, change, effect and bounded join context verbatim", () => {
    const exactReceipt = receipt("1:one\n2:TWO\n3:2.5\n4:three");
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "EDIT", status: 200,
        target: { scheme: "workspace", pathname: "/draft" },
        rx: { status: 200, receipt: exactReceipt },
    }], tok);
    assert.deepEqual(parseLogRecords(out).map(facts), [["body", "change", "effect", "extent", "lines", "logPath", "modifiers", "path", "tokens"]]);
    assert.match(out, /"extent":"lines 4->5"/);
    assert.match(out, /"change":"lines -1 \+2"/);
    assert.match(out, /"effect":"<2> -> <2,3>"/);
    assert.match(out, /3:2\.5/);
    assert.doesNotMatch(out, new RegExp(revision));
});

test("{§tokenomics} reviewer-replaced EDIT rows render authored dispositions and one landed replacement", () => {
    const replacement = {
        requested: "<1,-1>",
        source: "<1,4>",
        result: "<1,2>",
        removed: 4,
        inserted: 2,
        context: "1:reviewer\n2:replacement",
    };
    const head = {
        revision,
        unit: "lines",
        before: 4,
        after: 2,
        disposition: "superseded",
    } as const;
    const out = PacketWire.renderLog([
        {
            coordinate: "1/1/3",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "workspace", pathname: "/draft" },
            rx: {
                status: 200,
                receipt: { ...head, requested: "<2>", replacement },
            },
        },
        {
            coordinate: "1/1/4",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "workspace", pathname: "/draft" },
            rx: {
                status: 200,
                receipt: { ...head, requested: "<4>" },
            },
        },
    ], tok);
    assert.equal(out.match(/"disposition":"superseded"/g)?.length, 2);
    assert.match(out, /"requested":"<2>"/);
    assert.match(out, /"requested":"<4>"/);
    assert.match(out, /"replacement":"<1,4> -> <1,2>"/);
    assert.match(out, /"change":"lines -4 \+2"/);
    assert.equal(out.match(/1:reviewer/g)?.length, 1);
    assert.equal(out.match(/2:replacement/g)?.length, 1);
    assert.doesNotMatch(out, new RegExp(revision));
});

test("{§tokenomics} render guard: every content-emitting op applies the N: convention uniformly", () => {
    // The model orients on line numbers, so EVERY op that emits a content body
    // must number textual content regardless of mimetype. Pins the invariant
    // across READ, FIND, EDIT-span,
    // execution-body, the foisted exec-stream delta (incl. its cross-turn startLine), and NOTE/SEND bodies.
    // Log rows mirror the model's work as numbered content; they do not reserialize operation headings.
    // No future content branch can silently diverge.
    const base = { coordinate: "1/1/1", origin: "model", status: 200, target: { scheme: "workspace", pathname: "/a" } };
    const execTx = (body: string) => ({ runtime: "sh", target: { kind: "url", raw: "sh:///1/1/1/sh", scheme: "sh", pathname: "/1/1/1/sh", fragment: null }, body, lineMarker: null });
    const cases: Array<{ label: string; entry: LogEntryView; want: RegExp; anti?: RegExp }> = [
        { label: "READ text → numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "text/markdown", content: "alpha\nbeta" } }, want: /1:alpha\n2:beta/ },
        { label: "READ json -> numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "application/json", content: '{"k":1}' } }, want: /\n1:\{"k":1\}$/ },
        { label: "READ mixed newlines -> every physical line numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "text/plain", content: "a\r\nb\rc" } }, want: /1:a\r\n2:b\r3:c/ },
        { label: "FIND text → numbered", entry: { ...base, op: "FIND", rx: { status: 200, mimetype: "text/markdown", content: "m1\nm2" } }, want: /1:m1\n2:m2/ },
        { label: "EDIT span → pre-numbered span preserved verbatim (editedSpan owns the real offsets)", entry: { ...base, op: "EDIT", rx: { status: 200, span: "5:x\n6:y" } }, want: /5:x\n6:y/, anti: /1:5:/ },
        { label: "execution body → numbered", entry: { ...base, op: "sh", target: { scheme: "sh", pathname: "/1/1/1/sh" }, tx: execTx("ls\npwd") }, want: /1:ls\n2:pwd/ },
        { label: "exec-stream delta → cross-turn startLine continues", entry: { ...base, op: "READ", origin: "_plurnk", target: { scheme: "sh", pathname: "/1/1/1/sh", fragment: "stdout" }, rx: { status: 200, mimetype: "text/stream", content: "out5\nout6", startLine: 5 } }, want: /5:out5\n6:out6/ },
        { label: "NOTE body → numbered literal text, never an operation heading", entry: { ...base, op: "NOTE", tx: { body: "read line 2\nthen answer" } }, want: /1:read line 2\n2:then answer/, anti: /^## NOTE/m },
        { label: "SEND body → numbered content, never a SEND heading", entry: { ...base, op: "SEND", tx: { body: "here is the answer" } }, want: /1:here is the answer/, anti: /^## SEND/m },
    ];
    for (const c of cases) {
        const out = PacketWire.renderLog([c.entry], tok);
        assert.match(out, c.want, c.label);
        if (c.anti !== undefined) assert.doesNotMatch(out, c.anti, `${c.label} — anti-pattern must be absent`);
    }
});

test("{§tokenomics} an oversized automatically visible terminal stream READ renders its complete observation", () => {
    const output = Array.from({ length: 40 }, (_, i) => `stream line ${i + 1}`).join("\n");
    const rendered = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "_plurnk",
        op: "READ",
        status: 200,
        target: { scheme: "sh", pathname: "/1/1/1/sh", fragment: "stdout" },
        rx: { status: 200, mimetype: "text/stream", content: output, startLine: 1 },
        folded: [],
    }], tok);
    assert.match(rendered, /1:stream line 1/, "the terminal output arrives visible");
    assert.match(rendered, /40:stream line 40/, "READ observations are never silently projected again");
    assert.doesNotMatch(rendered, /"preview"/, "READ owns its selected result bound");
});

test("{§tokenomics} READ bodies render copyable Base62 line anchors while other numbered bodies remain numeric", () => {
    const read = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "workspace", pathname: "/notes.md" },
        rx: { status: 200, mimetype: "text/markdown", content: "alpha\nbeta", startLine: 7 },
        folded: [],
        lineAnchors: ["@aZ09b", "@Q1w2E"],
        lineNumberWidth: 1,
    }], tok);
    assert.match(read, /7<@aZ09b>alpha/);
    assert.match(read, /8<@Q1w2E>beta/);

    const find = PacketWire.renderLog([{
        coordinate: "1/2/2",
        origin: "model",
        op: "FIND",
        status: 200,
        target: { scheme: "workspace", pathname: "/notes.md" },
        rx: { status: 200, mimetype: "application/json", content: '["one"]', startLine: 1 },
        folded: [],
    }], tok);
    assert.match(find, /\n1:\["one"\]$/);
    assert.doesNotMatch(find, /1<@[0-9A-Za-z]{5}>/);
});

test("{§tokenomics} partially suppressed log bodies preserve source coordinates and expose only hidden intervals", () => {
    const rendered = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "workspace", pathname: "/notes.md" },
        rx: { status: 200, mimetype: "text/markdown", content: "one\ntwo\nthree\nfour", startLine: 17 },
        folded: [[2, 3]],
        lineAnchors: ["@00001", "@00002", "@00003", "@00004"],
        lineNumberWidth: 2,
    }], tok);
    assert.equal(typeof parseLogRecords(rendered)[0]?.body, "string", "a visible row carries coordinate lines — presence IS the state (#338)");
    assert.match(rendered, /"trimmed":\["<2,3>"\]/);
    assert.match(rendered, /17<@00001>one/);
    assert.match(rendered, /20<@00004>four/);
    assert.doesNotMatch(rendered, /18:two|19:three/);
});

test("{§tokenomics} READ rendering fails hard when persisted anchors do not align with the projected snapshot", () => {
    assert.throws(
        () => PacketWire.renderLog([{
            coordinate: "1/2/1",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: "workspace", pathname: "/notes.md" },
            rx: { status: 200, mimetype: "text/markdown", content: "alpha\nbeta", startLine: 7 },
            folded: [],
            lineAnchors: ["@aZ09b"],
            lineNumberWidth: 1,
        }], tok),
        /line anchors must align one-for-one/,
    );
});

test("{§tokenomics} log render: EDIT@200 with no tx → meta line only (defensive — tx is always written in practice)", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/3",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "workspace", pathname: "/x" },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    assert.doesNotMatch(out, /````EDIT \(/);
});

test("{§operation-results} a notice is one callout: the level picks it, the directive leads, the kind closes", () => {
    const out = PacketWire.renderNotices([
        { source: "engine:slicer", kind: "scope_normalized", level: "warn",
            directive: "YOU SHOULD write the normalized scope.", message: "Scope <0,120> was normalized to <1,120>." },
        { source: "engine:grammar", kind: "invalid_emission", level: "error",
            directive: "YOU MUST ONLY emit fenced operation batches; with the parameters, pattern, and terse aside on the fenced operation line.",
            message: "Response rejected before dispatch;\n no operations were performed.", position: { type: "content-offset", line: 2, column: 4 } },
        { source: "provider:test", kind: "output_unaccounted", level: "warn",
            message: "5000 output tokens billed; 1 visible across content and reasoning.", position: { type: "content-offset", line: 1, column: 0 } },
    ]);
    assert.equal(out, [
        "> [!WARNING]\n> YOU SHOULD write the normalized scope. Scope <0,120> was normalized to <1,120>. [scope_normalized]",
        "> [!CAUTION]\n> YOU MUST ONLY emit fenced operation batches; with the parameters, pattern, and terse aside on the fenced operation line. Response rejected before dispatch; no operations were performed. @ 2:4 [invalid_emission]",
        "> [!WARNING]\n> 5000 output tokens billed; 1 visible across content and reasoning. @ 1:0 [output_unaccounted]",
    ].join("\n\n"), "an environment notice carries no directive; whitespace is normalized; a blank line separates callouts");
    assert.doesNotMatch(out, /\{"/, "no JSON dump");
    assert.equal(PacketWire.renderNotices([{ source: "engine:turn", kind: "loop_status", level: "info" }]), "> [!NOTE]\n> [loop_status]");
});

test("{§tokenomics} a durable failure pointer is one status+path JSON object", () => {
    const out = PacketWire.renderFailurePointers([{ status: 403, coordinate: "1/1/2/EDIT" }]);
    assert.equal(out, '[{"status":403,"path":"log:///1/1/2/EDIT"}]', "the section is a link; the row holds the detail");
});

test("{§tokenomics} heterogeneous failures render as uniform durable pointers, no per-kind shape", () => {
    // A dispatch refusal (400), an action failure (403), a budget overflow (413): three categories, one
    // channel. Each is a LogCoordinate-positioned event rendered as the same {status, path} JSON object —
    // the section never restates the term or carries per-kind shape. The detail lives on each row, READ via the path.
    const errors = [
        { status: 400, coordinate: "1/2/3/error" },
        { status: 403, coordinate: "1/2/5/EDIT" },
        { status: 413, coordinate: "1/3/1/error" },
    ];
    const out = PacketWire.renderFailurePointers(errors);
    assert.equal(out, '[{"status":400,"path":"log:///1/2/3/error"},\n{"status":403,"path":"log:///1/2/5/EDIT"},\n{"status":413,"path":"log:///1/3/1/error"}]');
});

test("{§tokenomics} log render: FIND@200 renders its result catalog, not just the echoed query", () => {
    // The turn-0 foisted FIND catalog map is how a session's opening catalog reaches
    // the packet. If the renderer only re-emits the query statement (the regression),
    // the model is shown its own question and zero entries.
    const catalog = '[\n  {\n    "path": "workspace:///1/1",\n    "channels": {\n      "workspace:///1/1": { "mimetype": "text/markdown", "tokens": 20, "lines": 1 }\n    }\n  }\n]';
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "_plurnk",
        op: "FIND",
        status: 200,
        target: { scheme: "workspace", pathname: "/**" },
        tx: { op: "FIND", target: { kind: "url", raw: "workspace:///**", scheme: "workspace", pathname: "/**", fragment: null }, body: null, lineMarker: null },
        rx: { content: catalog, mimetype: "application/json" },
    }], tok);
    assert.match(out, /"path": "workspace:\/\/\/1\/1"/, "FIND@200 renders its result body - the model sees what the FIND returned");
    assert.match(out, /\n1:\[/);
});

test("{§tokenomics} log render: READ@200 with text/html is line-addressable", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "/page.html" },
            rx: { content: "<h1>Hi</h1>", mimetype: "text/html" },
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    assert.equal(parseLogRecords(out)[0]?.body, "1:<h1>Hi</h1>\n");
});

test("{§tokenomics} a suppressed program READ receipt keeps its address and readable extent", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "model", op: "READ", status: 200, initial_folded: [[1, -1]],
        target: { scheme: "ops", hostname: "alice", pathname: "/1/1" },
        rx: { content: "\n````NOTE\nInitialized\n````", mimetype: "text/vnd.plurnk" },
    }], tok);
    assert.match(out, /^### log:\/\/\/1\/1\/1\/READ \(ops:\/\/alice\/1\/1\) · \d+$/, "the READ receipt identifies the immutable source");
    assert.deepEqual(parseLogRecords(out).map(facts), [["logPath", "modifiers", "path", "tokens"]], "the canonical path carries the source identity");
    assert.equal(parseLogRecords(out)[0]?.tokens, tok(out), "the suppressed receipt charges only its metadata");
    assert.equal(parseLogRecords(out)[0]?.body, undefined, "the suppressed body is withheld");
    assert.doesNotMatch(out, /Initialize/, "the verbatim body stays hidden while suppressed — budget-neutral");
});

test("{§tokenomics} a rejected emission renders as an addressable /attempt leaf without duplicate kind metadata", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/1", origin: "model", op: null, status: 200, initial_folded: [[1, -1]],
        attrs: { kind: "emissionAttempt" },
        rx: { content: "malformed response", mimetype: "text/plain" },
    }], tok);
    assert.match(out, /^### log:\/\/\/1\/2\/1\/attempt · \d+$/m);
    assert.deepEqual(parseLogRecords(out).map(facts), [["lines", "logPath", "tokens"]]);
});

test("{§tokenomics} a program READ presents exact source, line-numbered", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "_plurnk", op: "READ", status: 200, folded: [],
        target: { scheme: "ops", hostname: "alice", pathname: "/1/1" },
        rx: { content: "\n````NOTE\nInitialized\n````", mimetype: "text/vnd.plurnk" },
    }], tok);
    assert.match(out, /^### log:\/\/\/1\/1\/1\/READ \(ops:\/\/alice\/1\/1\) · \d+$/m, "the heading owns the canonical address and its charge");
    assert.deepEqual(parseLogRecords(out).map(facts), [["body", "logPath", "modifiers", "origin", "path", "tokens"]], "the open source uses the same canonical leaf");
    assert.match(out, /"origin":"_plurnk"/, "the item identifies its actual producer");
    assert.match(out, /1:\n2:````NOTE\n3:Initialized\n4:````/, "the entire source, including the initial blank line, remains line-addressable");
});

test("{§packet}: a program READ renders whole; deliberate curation and suppression still apply", () => {
    const source = [
        ...Array.from({ length: 20 }, (_, index) => `\`\`\`\`READ (file-${index}.md) <!-- ${"orientation ".repeat(20)}-->\`\`\`\``),
        "````NOTE\nAddress the message.\n````",
    ].join("\n\n");
    const lines = source.split("\n");
    const numbered = lines.map((line, index) => `${String(index + 1).padStart(String(lines.length).length)}:${line}`);
    for (const origin of ["_plurnk", "model", "client"]) {
        const entry = {
            coordinate: "1/1/1", origin, op: "READ", status: 200,
            target: { scheme: "ops", hostname: "alice", pathname: "/1/1" }, rx: { content: source, mimetype: "text/vnd.plurnk" },
        };
        const complete = parseLogRecords(PacketWire.renderLog([entry], tok))[0];
        assert.equal(complete.body, `${numbered.join("\n")}\n`, `${origin} source renders whole`);
        assert.equal(complete.preview, undefined, "nothing is previewed");
        assert.equal(complete.tokens, tok(PacketWire.renderLog([entry], tok)), "accounting includes the complete rendered program and metadata");

        const trimmed = parseLogRecords(PacketWire.renderLog([{ ...entry, folded: [[3, 4]] }], tok))[0];
        assert.equal(trimmed.body, `${numbered.filter((_, index) => index !== 2 && index !== 3).join("\n")}\n`,
            "deliberate curation still removes source lines without renumbering the survivors");
        const suppressed = parseLogRecords(PacketWire.renderLog([{ ...entry, initial_folded: [[1, -1]] }], tok))[0];
        assert.equal(suppressed.body, undefined);
        assert.equal(suppressed.preview, undefined);
        assert.ok(suppressed.tokens < complete.tokens, "suppression does not charge the absent program body");
    }
});

test("{§tokenomics} initialization renders a program READ alongside its other real operation outcomes", () => {
    const out = PacketWire.renderLog([
        {
            coordinate: "1/1/1", origin: "_plurnk", op: "FIND", status: 200, folded: [],
            rx: { results: [] },
        },
        {
            coordinate: "1/1/2", origin: "_plurnk", op: "NOTE", status: 200, folded: [],
            tx: { body: "Address the message." },
        },
        {
            coordinate: "1/1/3", origin: "_plurnk", op: "READ", status: 200, folded: [],
            target: { scheme: "ops", hostname: "alice", pathname: "/1/1" },
            rx: { content: `\`\`\`\`FIND (*)\`\`\`\`
\`\`\`\`NOTE
Address the message.
\`\`\`\``, mimetype: "text/vnd.plurnk" },
        },
    ], tok);
    assert.match(out, /^### log:\/\/\/1\/1\/1\/FIND · \d+$/m, "the survey has an operation coordinate");
    assert.match(out, /^### log:\/\/\/1\/1\/2\/NOTE · \d+$/m, "the note has an operation coordinate");
    assert.match(out, /"origin":"_plurnk"/, "the operations preserve their kernel authorship");
    assert.match(out, /^### log:\/\/\/1\/1\/3\/READ \(ops:\/\/alice\/1\/1\) · \d+$/m, "Turn 0's exact program arrives as an ordinary READ");
    assert.deepEqual(parseLogRecords(out).map(facts), [
        ["logPath", "origin", "tokens"],
        ["body", "lines", "logPath", "origin", "tokens"],
        ["body", "logPath", "modifiers", "origin", "path", "tokens"],
    ], "Turn 0 uses the same address-owned identity");
});

test("{§log-wire-format}: the Log is standard Markdown framing plus strict one-line JSON metadata", () => {
    const out = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "FIND", status: 200, target: { scheme: "workspace", pathname: "" }, rx: { content: "[]", mimetype: "application/json" } }, // none: empty FIND, no body
        { coordinate: "1/1/2", origin: "model", op: "READ", status: 200, initial_folded: [[1, -1]], target: { scheme: null, pathname: "/a.md" }, rx: { content: "alpha\nbeta", mimetype: "text/markdown", startLine: 1 } }, // suppressed: body hidden
        { coordinate: "1/1/3", origin: "model", op: "READ", status: 200, folded: [], target: { scheme: null, pathname: "/b.md" }, rx: { content: "gamma", mimetype: "text/markdown", startLine: 1 } }, // visible: coordinate lines
    ], tok);
    assert.doesNotMatch(out, /````|"logPath"|"body"/, "the projection needs no fence or duplicate identity/body fields");
    const arr = parseLogRecords(out) as Array<{ body?: string; tokens: number }>;
    assert.deepEqual(arr.map((row) => "body" in row), [false, false, true], "coordinate-line presence determines what is in context");
    assert.deepEqual(arr.map(facts), [
        ["logPath", "modifiers", "path", "tokens"],
        ["logPath", "modifiers", "path", "tokens"],
        ["body", "logPath", "modifiers", "path", "tokens"],
    ]);
    assert.ok(!("body" in arr[0]), "a none row has no body lines");
    assert.ok(!("body" in arr[1]) && arr[1].tokens > 0, "a suppressed row charges its retained metadata");
    assert.equal(arr[2].body, "1:gamma\n", "an open row carries its ordinary addressable projection after metadata");
});

test("{§log-wire-format}: each row exposes one exact current-context charge", () => {
    const entries = [
        { coordinate: "1/1/1", origin: "model", op: "FIND", status: 200, target: { scheme: "workspace", pathname: "" }, rx: { content: "[]", mimetype: "application/json" } },
        { coordinate: "1/1/2", origin: "model", op: "READ", status: 200, initial_folded: [[1, -1]], target: { scheme: null, pathname: "/folded.md" }, rx: { content: "alpha\nbeta", mimetype: "text/markdown", startLine: 1 } },
        { coordinate: "1/1/3", origin: "model", op: "READ", status: 200, folded: [], target: { scheme: null, pathname: "/open.md" }, rx: { content: "gamma", mimetype: "text/markdown", startLine: 1 } },
        { coordinate: "1/1/4", origin: "model", op: "READ", status: 200, folded: [[2, 2]], target: { scheme: null, pathname: "/partial.md" }, rx: { content: "one\ntwo\nthree", mimetype: "text/markdown", startLine: 1 } },
    ];
    const rendered = PacketWire.renderLog(entries, tok);
    const rows = parseLogRecords(rendered) as Array<{ body?: string; tokens: number }>;

    assert.deepEqual(rows.map(facts), [
        ["logPath", "modifiers", "path", "tokens"],
        ["logPath", "modifiers", "path", "tokens"],
        ["body", "logPath", "modifiers", "path", "tokens"],
        ["body", "logPath", "modifiers", "path", "tokens", "trimmed"],
    ], "one charge per row; the metadata share is derivable, never serialized (#338)");
    for (const [index, row] of rows.entries()) {
        assert.ok(row.tokens > 0, "every materialized row reports its active cost");
        assert.equal(row.tokens, tok(PacketWire.renderLog([entries[index]], tok)));
    }
    assert.ok(!("body" in rows[1]) && rows[1].tokens > 0, "suppressed rows charge their metadata");
    for (const row of rows.slice(2)) {
        assert.ok("body" in row, "an open row carries its body");
        assert.ok(
            row.tokens > tok(row.body ?? ""),
            "an open row's active cost covers its rendered body plus its metadata",
        );
    }
});

test("{§tokenomics}: every retained log item is a reclaimable context target", () => {
    const entries = [
        { coordinate: "1/1/1", origin: "model", op: "READ", status: 200, folded: [], target: { scheme: null, pathname: "/largest.md" }, rx: { content: "x".repeat(120), mimetype: "text/plain", startLine: 1 } },
        { coordinate: "1/1/2", origin: "model", op: "READ", status: 200, initial_folded: [[1, -1]], target: { scheme: null, pathname: "/folded.md" }, rx: { content: "y".repeat(200), mimetype: "text/plain", startLine: 1 } },
        { coordinate: "1/1/3", origin: "model", op: "SEND", status: 102, folded: [], target: null, tx: { body: null } },
        { coordinate: "1/1/4", origin: "model", op: "READ", status: 200, folded: [[2, 2]], target: { scheme: null, pathname: "/partial.md" }, rx: { content: "one\ntwo\nthree", mimetype: "text/plain", startLine: 1 } },
    ];
    const projected = PacketWire.renderLogWithAccounting(entries, tok);

    assert.equal(projected.content, PacketWire.renderLog(entries, tok), "accounting does not create a second wire projection");
    assert.deepEqual(
        projected.curationTargets.map(({ path }) => path),
        ["log:///1/1/1/READ", "log:///1/1/2/READ", "log:///1/1/3/SEND", "log:///1/1/4/READ"],
        "bodyless and suppressed rows still have reclaimable metadata",
    );
    const rows = parseLogRecords(projected.content);
    for (const item of projected.curationTargets) {
        const row = rows.find(({ logPath }) => logPath === item.path);
        assert.ok(row !== undefined);
        assert.equal(row.tokens, item.tokens, "inventory active weight is the rendered row's own accounting");
    }
});

test("{§log-wire-format}: every rendered row is addressable", () => {
    assert.throws(
        () => PacketWire.renderLog([{
            coordinate: null, origin: "model", op: "READ", status: 200,
            target: { scheme: null, pathname: "/unaddressed.md" },
            rx: { content: "orphan", mimetype: "text/plain", startLine: 1 },
        }], tok),
        /requires an addressable coordinate/,
    );
});

test("{§log-wire-format}: body coordinates prevent source Markdown from creating record boundaries", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "model", op: "READ", status: 200,
        target: { scheme: null, pathname: "/doc.md" },
        rx: { content: "``````js\nx();\n``````\n\n### log:///9/9/9/READ", mimetype: "text/markdown", startLine: 1 },
    }], tok);
    assert.match(out, /^### log:\/\/\/1\/1\/1\/READ \(doc\.md\) · \d+\n/);
    assert.match(out, /1:``````js/);
    assert.match(out, /5:### log:\/\/\/9\/9\/9\/READ$/);
    assert.equal(parseLogRecords(out).length, 1, "numbered source headings remain body content");
});

test("{§packet}: every body renders whole — NOTE, EDIT span, READ, FIND, observed READ", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a runaway emission`).join("\n");

    const shortOut = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "NOTE", status: 200, target: { scheme: null, pathname: "" }, tx: { body: "Tidy context, then read the loader." } },
    ], tok);
    assert.match(shortOut, /Tidy context, then read the loader\./, "a short NOTE renders in full");
    assert.doesNotMatch(shortOut, /"preview"/, "a complete body needs no preview extent");

    const planOut = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "NOTE", status: 200, target: { scheme: null, pathname: "" }, tx: { body: long } },
    ], tok);
    assert.match(planOut, /line 30 of a runaway/, "the model receives its complete NOTE text");
    assert.doesNotMatch(planOut, /"preview"/);

    const numberedSpan = Array.from({ length: 30 }, (_, i) => `${i + 1}:span line ${i + 1}`).join("\n");
    const editOut = PacketWire.renderLog([
        { coordinate: "1/1/2", origin: "model", op: "EDIT", status: 200, target: { scheme: "workspace", pathname: "/x" }, rx: { span: numberedSpan } },
    ], tok);
    assert.match(editOut, /span line 30/, "an environment-delta EDIT span renders whole");
    assert.equal(parseLogRecords(editOut)[0]?.preview, undefined);

    const readOut = PacketWire.renderLog([
        { coordinate: "1/1/3", origin: "model", op: "READ", status: 200, target: { scheme: null, pathname: "/big.txt" }, rx: { content: long, mimetype: "text/plain", startLine: 1 } },
    ], tok);
    assert.match(readOut, /line 30 of a runaway/, "a long READ delivers full content");
    assert.doesNotMatch(readOut, /"preview"/);

    const findOut = PacketWire.renderLog([
        { coordinate: "1/1/4", origin: "model", op: "FIND", status: 200, target: { scheme: null, pathname: "" }, rx: { content: long, mimetype: "text/plain", startLine: 1 } },
    ], tok);
    assert.match(findOut, /line 30 of a runaway/, "a long FIND renders its full result");
    assert.doesNotMatch(findOut, /"preview"/);

    const pushedRead = PacketWire.renderLog([
        { coordinate: "1/1/5", origin: "_plurnk", op: "READ", status: 200, target: { scheme: "sh", pathname: "/1/1/1/sh" }, rx: { content: long, mimetype: "text/plain", startLine: 1 } },
    ], tok);
    assert.match(pushedRead, /line 30 of a runaway/, "an engine-observed READ receives the same complete projection");
    assert.doesNotMatch(pushedRead, /"preview"/, "provenance does not introduce a hidden READ bound");
});

test("{§packet}: NOTE reaches the next model packet as literal authored text", () => {
    const note = "Verify the baseline schema.";
    const out = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "NOTE", status: 200, target: { scheme: null, pathname: "" }, tx: { body: note } },
    ], tok);

    assert.match(out, /1:Verify the baseline schema\./, "the model sees its authored working memory in the durable log");
    assert.deepEqual(parseLogRecords(out).map(facts), [["body", "lines", "logPath", "tokens"]], "the NOTE carries only its own record facts");
});

test("{§packet}: every body producer renders whole", () => {
    const long = Array.from({ length: 30 }, (_, i) => `producer line ${i + 1}`).join("\n");
    const numbered = Array.from({ length: 30 }, (_, i) => `${i + 1}:producer line ${i + 1}`).join("\n");
    const entries = [
        { op: null, origin: "model", target: null, attrs: { kind: "emissionAttempt" }, rx: { content: long, mimetype: "text/vnd.plurnk" } },
        { op: "SEND", origin: "model", target: null, tx: { body: { raw: long } } },
        { op: "WORK", origin: "model", target: { scheme: "session", pathname: "/reviewer" }, tx: { body: long } },
        { op: "FORK", origin: "model", target: null, tx: { body: long } },
        { op: "sh", origin: "model", target: { scheme: "sh", pathname: "/1/1/1/sh" }, tx: { op: "sh", body: long } },
        { op: "EDIT", origin: "model", target: { scheme: "workspace", pathname: "/a" }, rx: { span: numbered } },
        { op: "extension", origin: "_plurnk", target: { scheme: "custom", pathname: "/result" }, rx: { content: long, mimetype: "text/plain" } },
    ];

    entries.forEach((entry, index) => {
        const coordinate = `1/2/${index + 1}`;
        const rendered = PacketWire.renderLog([{ coordinate, status: 200, ...entry }], tok);
        assert.match(rendered, /producer line 30/, `${entry.op} renders its whole body`);
        assert.doesNotMatch(rendered, /"preview"/, `${entry.op} is not previewed`);
    });
});

test("{§packet}: partial curation keeps canonical coordinates on a whole body", () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const rendered = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "model",
        op: "SEND",
        status: 200,
        target: null,
        tx: { body: { raw: content } },
        folded: [[11, 14]],
    }], tok);
    assert.match(rendered, /10:line 10/);
    assert.doesNotMatch(rendered, /12:line 12/, "the curated lines are gone");
    assert.match(rendered, /15:line 15/, "the survivors keep their source coordinates");
    assert.match(rendered, /30:line 30/, "the whole remainder is shown");
    assert.match(rendered, /"trimmed":\["<11,14>"\]/);
    assert.doesNotMatch(rendered, /"preview"/);
});

test("{§tokenomics} structured mutation receipts bypass a second generic preview", () => {
    const numbered = [
        ...Array.from({ length: 10 }, (_, i) => i + 1),
        ...Array.from({ length: 10 }, (_, i) => i + 21),
    ].map((line) => `${line}:receipt line ${line}`).join("\n");
    const baseReceipt = receipt(numbered, "<6>");
    const editReceipt = {
        ...baseReceipt,
        before: 11,
        after: 30,
        effect: {
            ...baseReceipt.effect,
            source: "<6>",
            result: "<6,25>",
            removed: 1,
            inserted: 20,
        },
    };
    const entries = [
        {
            op: "EDIT",
            origin: "model",
            target: { scheme: "workspace", pathname: "/a" },
            rx: { receipt: editReceipt },
        },
        {
            op: "COPY",
            origin: "model",
            target: { scheme: "workspace", pathname: "/b-source" },
            tx: {
                source: {
                    target: { scheme: "workspace", pathname: "/b-source" },
                    metadata: null,
                    lineMarker: { marks: [2] },
                },
                destination: {
                    target: { scheme: "workspace", pathname: "/b" },
                    metadata: null,
                    lineMarker: { marks: [2] },
                },
            },
            rx: { effects: [{ target: "workspace:///b", action: "update", receipt: editReceipt }] },
        },
        {
            op: "MOVE",
            origin: "model",
            target: { scheme: "workspace", pathname: "/c-source" },
            tx: {
                source: {
                    target: { scheme: "workspace", pathname: "/c-source" },
                    metadata: null,
                    lineMarker: { marks: [2] },
                },
                destination: {
                    target: { scheme: "workspace", pathname: "/c" },
                    metadata: null,
                    lineMarker: { marks: [2] },
                },
            },
            rx: { effects: [{ target: "workspace:///c", action: "update", receipt: editReceipt }] },
        },
    ];

    entries.forEach((entry, index) => {
        const rendered = PacketWire.renderLog([{
            coordinate: `1/3/${index + 1}`,
            status: 200,
            ...entry,
        }], tok);
        assert.match(rendered, /30:receipt line 30/, `${entry.op} preserves its complete pre-bounded receipt context`);
        assert.doesNotMatch(rendered, /11:receipt/, "the source-coordinate jump remains the omission signal");
        assert.doesNotMatch(rendered, /"preview"/, `${entry.op} does not describe receipt coordinates as a partial READ`);
    });
});

test("{§message-arrival} {§tokenomics}: an arrival that landed renders whole; one that did not fit renders as its size", () => {
    const content = Array.from({ length: 80 }, (_, i) => `prompt ${i + 1} ${"x".repeat(32)}`).join("\n");
    const landed = { coordinate: "1/1/1", op: "SEND", origin: "_plurnk", source: "acp://operator/threads/t/messages/m1", attrs: { kind: "message" }, status: 200, tx: { body: { raw: content } }, rx: { status: 200 } };
    const unfit = { ...landed, coordinate: "1/1/2", source: "acp://operator/threads/t/messages/m2", attrs: { kind: "message", unfit: { lines: 80, tokens: 1000 } }, initial_folded: [[1, -1]] };
    const [whole, folded] = parseLogRecords(PacketWire.renderLog([landed, unfit], tok));
    assert.match(String(whole.body), /80:prompt 80/, "the arrival that fit is shown whole");
    assert.equal(whole.preview, undefined);
    assert.equal(whole.size, undefined);
    assert.equal(folded.body, undefined, "the arrival that did not fit shows no part of its body");
    assert.deepEqual(folded.size, { lines: 80, tokens: 1000 }, "its row is its size and its address");
    assert.equal(folded.preview, undefined);
});

test("{§log-wire-format}: Unicode and CRLF bodies render whole with canonical line numbering", () => {
    const emoji = parseLogRecords(PacketWire.renderLog([{ coordinate: "1/1/1", origin: "model", op: "SEND", status: 200, tx: { body: "😀abcdef" } }], tok))[0];
    assert.equal(emoji.body, "1:😀abcdef\n", "no character bound cuts a line, so no surrogate pair can be split");
    assert.equal(emoji.preview, undefined);
    const crlf = PacketWire.renderLog([{ coordinate: "1/1/1", origin: "model", op: "SEND", status: 200, tx: { body: "ab\r\ncdef" } }], tok);
    assert.match(crlf, /1:ab/);
    assert.match(crlf, /2:cdef/);
    assert.doesNotMatch(crlf, /\r2:/, "line numbering cannot split the CRLF pair");
    const sixteenTerminatedLines = `${Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const exact = PacketWire.renderLog([{ coordinate: "1/1/1", origin: "model", op: "SEND", status: 200, tx: { body: sixteenTerminatedLines } }], tok);
    assert.doesNotMatch(exact, /"preview"/);
    assert.doesNotMatch(exact, /17:/, "a trailing newline does not invent a seventeenth line");
});

test("{§log-wire-format}: a suppressed bounded body does not claim to display a chunk", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const rendered = PacketWire.renderLog([{
        coordinate: "1/1/1",
        origin: "model",
        op: "SEND",
        status: 200,
        initial_folded: [[1, -1]],
        tx: { body: long },
    }], tok);

    assert.deepEqual(parseLogRecords(rendered).map(facts), [["lines", "logPath", "tokens"]]);
    const [row] = parseLogRecords(rendered);
    assert.equal(row?.tokens, tok(rendered), "the retained metadata is the only charge");
    assert.equal(row?.body, undefined, "the suppressed body is absent");
    assert.equal(row?.preview, undefined, "preview describes displayed content, not hidden canonical content");
});
});

describe("Digest.wire-evidence", () => {
test("{§emission-history} {§digest-forensic-fidelity}: stored and shared requests preserve interpolated assistant messages byte for byte", async () => {
    const dir = await mkdtemp(join(await testArtifactDirectory("core"), "interpolated-evidence-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const frame = PlurnkParser.frame;
    const provider = new Mock({ contextWindow: 100000, responses: [
        { assistant: { content: frame("EDIT (workspace:///memo.md)", "The complete replacement."), reasoning: null } },
        { assistant: { content: frame("READ (workspace:///memo.md)", null), reasoning: null } },
        { assistant: { content: frame("SEND [200]", "Done."), reasoning: null } },
    ] });
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "interpolated-evidence");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1, "Write and read.");
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 3);
    } finally { await db.close(); }
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const report = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { turns: Array<{ producer: string; artifact: string }> };
    const turns = report.turns.filter(({ producer }) => producer === "model");
    assert.equal(turns.length, 3);
    for (const [index, { artifact }] of turns.entries()) {
        const wire = JSON.parse(await readFile(join(digestDir, `${artifact}.wire.json`), "utf8"));
        assert.deepEqual(wire, provider.received[index], "the stored packet reconstructs what the provider received");
        const request = await readFile(join(digestDir, `${artifact}.request.md`), "utf8");
        let cursor = 0;
        for (const message of wire as Array<{ role: string; content: string }>) {
            const at = request.indexOf(message.content, cursor);
            assert.ok(at >= cursor, `${artifact}: the navigable request retains ${message.role} text in order`);
            cursor = at + message.content.length;
        }
    }
    assert.deepEqual(provider.received[2].map(({ role }) => role), ["system", "user", "assistant", "user", "assistant", "user"], "EDIT and READ each retain their own assistant/result boundary");
});

test("{§provider-failure-normalization}: blank emissions retain their wire channels through persistence and digest", async () => {
    // The surveys are the initialization program; with the preview off there is none and no digest stem for it.
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    try {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "wire-evidence-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        let requests = 0;
        const provider = new AiSdkProvider({
            model: "wire-evidence", url: "https://example.test/v1/chat/completions",
            fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            contextWindow: 100000, outputBudget: 1000,
            effort: { mode: "off", budget: null }, temperature: null, repeatPenalty: null, retryAttempts: 0,
            rawBody: false,
            // {§provider-failure-normalization}: ordinary empty-turn recovery follows the warning.
            fetch: async () => {
                requests += 1;
                if (requests > 1) {
                    return new Response(`data: ${JSON.stringify({
                        id: "text", model: "wire-evidence",
                        choices: [{ index: 0, delta: { content: "````SEND [200]\nInspected.\n````" }, finish_reason: "stop" }],
                        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
                    })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
                }
                return new Response(`data: ${JSON.stringify({
                    id: "blank-tools", model: "wire-evidence",
                    choices: [{ index: 0, delta: {
                        tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "READ", arguments: '{"path":"example.txt"}' } }],
                        refusal: "retained vendor text",
                    }, finish_reason: "tool_calls" }],
                    usage: { prompt_tokens: 10, completion_tokens: 13, total_tokens: 23 },
                })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
            },
        });
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "wire-evidence");
            const sessionId = await insertSession(db, workspaceId, null, "analyst");
            // A workspace entry, so the workspace survey selects something and the initialization program exists.
            await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "a note", mimetype: "text/markdown" });
            const loopId = await insertLoop(db, sessionId, 1, "inspect");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 3, messages: [{ role: "user", content: "Inspect." }] });
            assert.equal(result.result.status, 200);
            assert.equal(result.turnIds.length, 3, "initialization, one empty turn, then the answer");
            const first = result.turnIds[1];
            const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: first });
            assert.deepEqual(attempts.map(({ accepted }) => accepted), [1], "no provider retry or parser rejection");
            const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: first });
            assert.deepEqual(rows.filter(({ op }) => op === "error").map(({ rx }) => JSON.parse(rx).problem.detail), ["The turn performed no operation."]);
        } finally {
            await db.close();
        }
        assert.equal(requests, 2, "the model recovers on the next ordinary turn");
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        const raw = JSON.parse(await readFile(join(digestDir, `${stems[1]}.assistantRaw.json`), "utf8"));
        assert.equal(raw.rawBody, undefined);
        assert.deepEqual(raw.wire.toolCalls, [
            { index: 0, id: "call-1", type: "function", name: "READ", arguments: '{"path":"example.txt"}' },
        ]);
        assert.deepEqual(raw.wire.channels, { refusal: "retained vendor text" });
        assert.equal(await readFile(join(digestDir, `${stems[2]}.assistant.md`), "utf8"), "````SEND [200]\nInspected.\n````");
        const report = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.doesNotMatch(report, /rejected-emissions=/);
        assert.match(await readFile(join(digestDir, `${stems[2]}.user.md`), "utf8"), /native tool calls, but no tools were declared/);
    } finally {
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});
});

describe("Engine.inject", () => {
test("{§message-arrival} concurrent injections keep arrival order across a new Engine", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ordered-messages");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "initial");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await Promise.all([engine.injectIntoLoop(loopId, "first"), engine.injectIntoLoop(loopId, "second")]);
        await new Engine({ db, schemes: new SchemeRegistry() }).injectIntoLoop(loopId, "third");
        const inbox = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; log_entry_id: number | null }>;
        assert.deepEqual(inbox.map(({ body }) => body), ["initial", "first", "second", "third"], "the loop's assignment first, then arrivals in order");
        assert.deepEqual(inbox.map(({ ordinal }) => ordinal), [1, 2, 3, 4], "ordinals are durable across engines");
        assert.ok(inbox.every(({ log_entry_id }) => log_entry_id === null), "nothing is published before a turn boundary");
    } finally { await db.close(); }
});

test("{§message-arrival} engine.inject: persists a message with its ordinal, open paths, and causal source", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "initial prompt");
        // Loop starts at status=102 (insertLoop default). Insert a turn
        // 1 placeholder so engine.inject's next-turn query returns 2 —
        // matches the realistic mid-loop state.
        await insertTurn(db, loopId, 1, 102);

        const result = await engine.injectIntoLoop(
            loopId,
            "follow-up",
            ["src/context.ts", "README.md"],
            "session://researcher",
        );
        assert.ok(result, "engine.inject returned a result");
        assert.equal(result.loopId, loopId);
        assert.equal(result.turnSeq, 2, "the LANDING turn is 2 (turn 1 already exists) — delivery timing, not the key");

        const inbox = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; source: string | null; open_paths: string; log_entry_id: number | null }>;
        assert.equal(inbox.length, 2, "the assignment and the arrival");
        const [, message] = inbox;
        assert.deepEqual(
            { ordinal: message.ordinal, body: message.body, source: message.source, openPaths: JSON.parse(message.open_paths), published: message.log_entry_id },
            { ordinal: 2, body: "follow-up", source: "session://researcher", openPaths: ["src/context.ts", "README.md"], published: null },
            "the message durably owns its selected workspace paths and causal source ({§message-arrival})",
        );
    } finally { await db.close(); }
});

test("{§message-arrival} concurrent injects are contained as distinct ordered messages with their own paths", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-containment");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "initial");
        await insertTurn(db, loopId, 1, 102);

        const [r1, r2] = await Promise.all([
            engine.injectIntoLoop(loopId, "first follow-up", ["first.ts"]),
            engine.injectIntoLoop(loopId, "second follow-up", ["second.ts"]),
        ]);
        assert.ok(r1 && r2, "both injects landed in the ACTIVE loop — no new loop while one is live");

        const rows = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ id: number; ordinal: number; body: string; open_paths: string }>;
        assert.deepEqual(rows.map(({ ordinal, body, open_paths }) => ({ ordinal, body, openPaths: JSON.parse(open_paths) })), [
            { ordinal: 1, body: "initial", openPaths: [] },
            { ordinal: 2, body: "first follow-up", openPaths: ["first.ts"] },
            { ordinal: 3, body: "second follow-up", openPaths: ["second.ts"] },
        ], "the earlier message is CONTAINED, never superseded");
        assert.equal(new Set(rows.map(({ id }) => id)).size, 3, "concurrent messages remain independent rows");

        const restarted = new Engine({ db, schemes: new SchemeRegistry() });
        await restarted.injectIntoLoop(loopId, "after restart", ["third.ts"]);
        const after = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; open_paths: string }>;
        assert.deepEqual(after.at(-1), { ...after.at(-1), ordinal: 4, body: "after restart", open_paths: JSON.stringify(["third.ts"]) }, "a new engine continues after the durable historical ordinals");
    } finally { await db.close(); }
});

test("{§message-arrival} engine.inject: returns null when the addressed Loop is missing or finished", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, "engine-inject-no-active");
        const sessionId = await insertSession(db, workspaceId);
        // No loops at all in this session.
        const result = await engine.injectIntoLoop(999_999, "orphan prompt");
        assert.equal(result, null, "no active loop → null (caller falls back to enqueue path)");

        // Also returns null when a loop exists but it's terminal.
        const closedLoop = await insertLoop(db, sessionId, 1, "done");
        await db.test_set_loop_status.run({
            id: closedLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        const result2 = await engine.injectIntoLoop(closedLoop, "still orphan");
        assert.equal(result2, null, "loop at status=200 doesn't count as active");
    } finally { await db.close(); }
});

test("{§session-wait-timing}: a queued recipient accepts messages without changing its lifecycle", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "queued-recipient");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "queued");
        await db.test_set_loop_status.run({ id: loopId, status: 100, terminal_result: null });
        const recipient = await db.drain_message_recipient.get<{ id: number }>({ session_id: sessionId, loop_id: loopId });
        assert.equal(recipient?.id, loopId);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        assert.equal((await engine.injectIntoLoop(loopId, "before execution"))?.loopId, loopId);
        assert.deepEqual((await db.test_messages_by_loop.all<{ body: string }>({ loop_id: loopId })).map(({ body }) => body), ["queued", "before execution"]);
        assert.equal((await db.drain_message_recipient.get<{ id: number }>({ session_id: sessionId, loop_id: loopId }))?.id, loopId);
    } finally { await db.close(); }
});

test("{§session-wait-timing}: completion between recipient lookup and insertion admits no message", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "injection-completion-race");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "original");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const query = db.drain_next_turn_seq_for_loop;
        const get = query.get.bind(query);
        t.mock.method(query, "get", async (...args: Parameters<typeof get>) => {
            const result = await get(...args);
            await db.test_set_loop_status.run({ id: loopId, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
            return result;
        });
        assert.equal(await engine.injectIntoLoop(loopId, "too late"), null);
        const messages = await db.test_messages_by_loop.all<{ body: string }>({ loop_id: loopId });
        assert.deepEqual(messages.map(({ body }) => body), ["original"]);
    } finally { await db.close(); }
});
});

describe("Share", () => {
test("{§share} {§share}: a scoped share preserves a checkpointed source and holds one workspace", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const kept = await insertWorkspace(db, "kept");
    const other = await insertWorkspace(db, "other");
    await insertLoop(db, await insertSession(db, kept, null, "alice"), 1, "kept task");
    await insertLoop(db, await insertSession(db, other, null, "bob"), 1, "other task");
    // Main-file byte equality requires committed pages outside the WAL first.
    try {
        await db.test_checkpoint.run();
        assert.equal(statSync(`${dbPath}-wal`).size, 0);
    } finally {
        await db.close();
    }
    const before = readFileSync(dbPath);

    const folder = join(root, "shares", "share_this_session_here");
    const shared = await Share.write({ openEvidence: EvidenceReader.open, dbPath, folder, workspaceId: kept });

    assert.deepEqual(shared, { folder });
    assert.ok(existsSync(join(folder, "digest.md")));
    const digest = JSON.parse(readFileSync(join(folder, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> };
    assert.deepEqual(digest.workspaces.map(({ name }) => name), ["kept"]);
    const after = readFileSync(dbPath);
    assert.ok(after.equals(before), `the database itself is only read: bytes ${before.length} -> ${after.length}, first change ${after.findIndex((byte, index) => byte !== before[index])}`);
});

test("{§share}: a folder that already holds files, the database's own included, is refused and never cleared", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-overlap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    await (await openMigrated(dbPath)).close();
    await assert.rejects(Share.write({ openEvidence: EvidenceReader.open, dbPath, folder: root }), { message: `${root} already exists and is not an empty folder; remove it first` });
    assert.ok(existsSync(dbPath));
});

test("{§share-packet-names}: a snapshot of an open WAL database keeps the commits a byte copy drops; an existing copy is refused", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-snapshot-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    t.after(() => db.close());
    await insertWorkspace(db, "committed-in-wal");
    const workspacesOf = (copy: string, digestDir: string): string[] => {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath: copy, digestDir });
        return (JSON.parse(readFileSync(join(digestDir, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> }).workspaces.map(({ name }) => name);
    };

    const bytes = join(root, "bytes.db");
    copyFileSync(dbPath, bytes);
    assert.deepEqual(workspacesOf(bytes, join(root, "bytes")), [], "the byte copy holds the migrated schema, but not the commit still in the -wal file");
    const copy = join(root, "snapshot.db");
    Share.snapshot(dbPath, copy);
    assert.deepEqual(workspacesOf(copy, join(root, "snapshot")), ["committed-in-wal"]);
    assert.throws(() => Share.snapshot(dbPath, copy), { message: `${copy} already exists; remove it first` });
});
});

describe("StoredPacket.digest", () => {
test("{§digest-forensic-fidelity}: unknown actionless rows remain evidence without hiding turn programs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-unknown-source-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    const source = "````SEND\ndone\n````";
    try {
        const workspaceId = await insertWorkspace(db, "unknown-source");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "inspect history");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await Turn.recordSource(db, turn.id, "ops", source);
        for (const [index, kind] of ["reasoning", "unknown", "emissionAttempt"].entries()) {
            await db.engine_insert_log_entry.get({
                session_id: sessionId, loop_id: loopId, turn_id: turn.id, sequence: index + 1,
                origin: "model", source: null, model_call_id: null,
                op: null,
                scheme: null, username: null, password: null, hostname: null, port: null,
                pathname: null, query: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/vnd.plurnk",
                rx: JSON.stringify({ content: kind, mimetype: "text/vnd.plurnk" }),
                mimetype_rx: "application/json", status_rx: 200, weight: 1,
                state: "resolved", outcome: null, attrs: JSON.stringify({ kind: "emissionAttempt" }),
                initial_folded: "[]",
            });
        }
        await Turn.complete(db, turn.id, 200);
        await db.test_make_historical_actionless_rows();
    } finally {
        await db.close();
    }
    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        assert.equal(await readFile(join(digestDir, `${stems[0]}.assistant.md`), "utf8"), source);
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.equal(json.log_entries.length, 3, "no source row is discarded or rewritten");
        const report = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(report, /unrecognized actionless row.*reasoning/);
        assert.match(report, /unrecognized actionless row.*unknown/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§log-history-projection}: digest retains programs after all source READ receipts are KILLed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-killed-turn-artifact-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const sources = [
        "````NOTE\nContinue one.\n````",
        "````NOTE\nContinue two.\n````",
        "````KILL (log:///1/[1-2]/*/READ)````\n````NOTE\nContinue three.\n````",
    ];
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "killed-turn-artifact");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1, "curate history");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const observeProgram = async (turnId: number, source: string): Promise<number> => {
            await Turn.recordSource(db, turnId, "ops", source);
            const turn = (await db.test_get_turn.get<{ sequence: number }>({ id: turnId }))!;
            const result = await engine.dispatch({
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
                statement: {
                    op: "READ", aside: null, metadata: null, matcher: null, body: null,
                    target: { ...urlPath("ops", `/1/${turn.sequence}`), hostname: "analyst", raw: `ops://analyst/1/${turn.sequence}` }, lineMarker: { marks: [1, -1] },
                    position: { line: 1, column: 1 },
                },
            });
            assert.equal(result.status, 200);
            return (await db.test_log_entries_by_turn.all<{ id: number }>({ turn_id: turnId }))[0].id;
        };
        const retiredIds: number[] = [];
        for (const source of sources.slice(0, 2)) {
            const turnId = (await Turn.open(db, {
                loopId,
                producer: "model",
                kind: "inference",
            })).id;
            retiredIds.push(await observeProgram(turnId, source));
            await Turn.complete(db, turnId, 200);
        }

        const curationTurn = (await Turn.open(db, {
            loopId,
            producer: "model",
            kind: "inference",
        })).id;
        await Turn.recordSource(db, curationTurn, "ops", sources[2]);
        const kill: KillStatement = {
            metadata: null,
            op: "KILL", aside: null,
            target: urlPath("log", "/1/[1-2]/*/READ"), lineMarker: null, matcher: null, body: null,
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: kill,
            workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal(result.matched, 2, "the real broad KILL retires both prior source READ receipts");
        await Turn.complete(db, curationTurn, 200);

        const active = await db.engine_render_log.all<{ id: number }>({ session_id: sessionId });
        assert.ok(retiredIds.every((id) => !active.some((row) => row.id === id)), "retired READ receipts leave the current packet projection");
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        for (const [index, source] of sources.entries()) {
            assert.equal(
                await readFile(join(digestDir, `${stems[index]}.assistant.md`), "utf8"),
                source,
                "broad curation cannot erase any admitted turn artifact",
            );
        }
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            turns: Array<{ program: string | null }>;
            log_entries: Array<{ id: number; projection: { active: boolean } }>;
            log_curation_effects: Array<{ active_before: boolean; active_after: boolean }>;
        };
        assert.deepEqual(json.turns.map(({ program }) => program), sources, "structured forensic output retains every exact program too");
        assert.equal(
            json.log_entries.filter(({ projection }) => !projection.active).length,
            2,
            "the artifact records both retired current projections",
        );
        assert.deepEqual(
            json.log_curation_effects.map(({ active_before, active_after }) => [active_before, active_after]),
            [[true, false], [true, false]],
            "the digest retains every exact broad-KILL transition",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§share-packet-names}: digest preserves source channels without fabricating provider participation", async () => {
    // The surveys are the initialization program; with the preview off there is none, so this witness turns it on.
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    try {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-turn-artifacts-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const db = await openMigrated(dbPath);
        const inferenceSource = "````SEND\ndone\n````";
        let initializationSource = "";
        try {
            const workspaceId = await insertWorkspace(db, "turn-artifacts");
            const sessionId = await insertSession(db, workspaceId, null, "analyst");
            // A workspace entry, so the workspace survey selects something and the initialization program exists.
            await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "a note", mimetype: "text/markdown" });
            const loopId = await insertLoop(db, sessionId, 1, "conclude");
            const response = {
                assistant: { content: inferenceSource, reasoning: null },
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            } as MockResponse;
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            await engine.runTurn({
                provider: new Mock({ contextWindow: 100_000, responses: [response] }),
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "user", content: "Conclude." }],
            });

            const previousOutput = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
            const previousReasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
            // {§tokenomics} — an eleven-token window holds no packet: the turn ends
            // before any provider call, packetless.
            process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "2";
            delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
            const constrained = new Mock({ contextWindow: 11, responses: [response] });
            if (previousOutput === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
            else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = previousOutput;
            if (previousReasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
            else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = previousReasoning;
            const overflow = await engine.runTurn({
                provider: constrained,
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "user", content: "Conclude." }],
                turnNumber: 2,
            });
            assert.equal(overflow.producer, "model");
            assert.equal(overflow.kind, "inference");
            assert.equal(overflow.status, 413);
            assert.equal(constrained.remaining, 1, "the rejected candidate performs no provider call");

            const turns = await db.test_list_turns_in_loop.all<{ id: number }>({ loop_id: loopId });
            const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
            initializationSource = programs.find(({ turn_id, kind }) => turn_id === turns[0].id && kind === "ops")!.content;
            assert.ok(!programs.some(({ turn_id, kind }) => turn_id === turns[0].id && kind === "reasoning"), "initialization authors no reasoning ({§session-initialization-entry})");
            assert.ok(!programs.some(({ turn_id }) => turn_id === overflow.turnId), "no recovery program was executed or fabricated");
        } finally {
            await db.close();
        }

        try {
            Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
            const stems = await digestStems(digestDir);
            assert.deepEqual(stems, ["analyst-1-1", "analyst-1-2"], "source-backed initialization and inference retain their log coordinates");
            assert.equal(
                await readFile(join(digestDir, "analyst-1-1.assistant.md"), "utf8"),
                initializationSource,
                "a packetless turn's program remains exact forensic evidence",
            );
            await assert.rejects(() => access(join(digestDir, "analyst-1-1.reasoning.md")), { code: "ENOENT" });
            await assert.rejects(() => access(join(digestDir, `${stems[0]}.system.md`)), { code: "ENOENT" });
            await assert.rejects(() => access(join(digestDir, `${stems[0]}.user.md`)), { code: "ENOENT" });
            await assert.rejects(() => access(join(digestDir, `${stems[0]}.assistantRaw.json`)), { code: "ENOENT" });

            assert.equal(await readFile(join(digestDir, `${stems[1]}.assistant.md`), "utf8"), inferenceSource);
            await access(join(digestDir, `${stems[1]}.system.md`));
            await access(join(digestDir, `${stems[1]}.user.md`));
            await access(join(digestDir, `${stems[1]}.assistantRaw.json`));

            assert.equal(stems.length, 2, "only the two durable turns wrote artifacts");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    } finally {
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});

test("{§share-packet-names} Digest: operation and request-only turns remain visibly distinct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-packet-algebra-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "packet-algebra");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "packet states");
        for (const producer of ["client", "_plurnk"] as const) {
            const operation = await Turn.open(db, { loopId, producer, kind: "operation" });
            await Turn.complete(db, operation.id, 200);
        }
        await db.test_turns_insert.run({
            loop_id: loopId,
            sequence: 3,
            status: 502,
            packet: StoredPacket.stringify({ weight: 0, sections: [], attributions: [] }),
        });
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        await assert.rejects(() => access(join(digestDir, `${stems[0]}.packet.md`)));
        assert.match(
            await readFile(join(digestDir, `${stems[0]}.response.md`), "utf8"),
            /No provider response was admitted/,
        );
        await assert.rejects(
            () => access(join(digestDir, `${stems[1]}.response.md`)),
            { code: "ENOENT" },
            "source-less programmatic turns create no artifact ordinals",
        );
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /Tokens:\s+no provider requests/);
        assert.match(markdown, /Cost:\s+n\/a/);
        assert.match(markdown, /T1: producer=client kind=operation status=200/);
        assert.doesNotMatch(markdown, /T1:.*(?:model=|input=|cost=)/);
        assert.match(markdown, /T2: producer=_plurnk kind=operation status=200/);
        assert.match(markdown, /T3 \(model turn 1 · [A-Za-z0-9_.-]+-\d+-\d+\):.*\n  ↳ request: input sections not retained \([^\n]+\.request\.md\)\n  ↳ emission: \(none admitted\)/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§digest-forensic-fidelity}: native attachment selection remains distinct from an empty or absent request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-attachment-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const attachment = {
        contentHash: "a".repeat(64),
        coordinate: "log:///1/2/2/READ", path: "board.png", scheme: "file", pathname: "board.png",
        mimetype: "image/png", kind: "image" as const, weight: 547, width: 640, height: 640,
    };
    const packet = { weight: 0, sections: [], attributions: [] };
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "attachment-digest");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "inspect delivery");
        for (const [index, stored] of [
            StoredPacket.stringify({ ...packet, attachments: [attachment] }),
            StoredPacket.stringify(packet),
            null,
        ].entries()) {
            await db.test_turns_insert.run({ loop_id: loopId, sequence: index + 1, status: 200, packet: stored });
        }
    } finally { await db.close(); }
    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.deepEqual(json.turns.map((turn: { attachments: unknown }) => turn.attachments), [[attachment], [], null]);
        const page = await readFile(join(digestDir, `${json.turns[0].artifact}.request.md`), "utf8");
        assert.match(page, /## Native attachments/u);
        assert.match(page, /selection alone does not prove transport or provider acceptance/u);
        assert.ok(page.includes(JSON.stringify(attachment, null, 2).split("\n")[1].trim()));
        assert.match(page, /board\.png/u);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§digest-forensic-fidelity}: one malformed historical packet remains exact evidence without aborting later turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-malformed-packet-digest-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    // {§packet} — the bag's CHECK admits this (attributions is an array); the packet shape does
    // not (an attribution is a non-empty string). Historical evidence, stored straight into the bag.
    const malformedPacket = JSON.stringify({ weight: 0, attributions: [""] });
    const db = await openMigrated(dbPath);
    let malformedTurnId: number | undefined;
    try {
        const workspaceId = await insertWorkspace(db, "malformed-packet");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "retain the complete history");
        malformedTurnId = (await db.test_insert_turn.get<{ id: number }>({ loop_id: loopId, sequence: 1, status: 500, packet: malformedPacket }))!.id;
        await insertPacketTurn(db, loopId, 2, {
            weight: 0,
            sections: [{ name: "prompt", slot: "user", header: null, content: "later", weight: 0 }],
            attributions: [],
        }, 502);
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const stems = await digestStems(digestDir);
        assert.equal(
            await readFile(join(digestDir, `${stems[0]}.packet.raw.txt`), "utf8"),
            malformedPacket,
            "the diagnostic artifact preserves the stored text exactly",
        );
        const diagnostic = JSON.parse(await readFile(join(digestDir, `${stems[0]}.packet.invalid.json`), "utf8"));
        assert.equal(diagnostic.turnId, malformedTurnId);
        assert.match(diagnostic.error.message, new RegExp(`digest turn ${malformedTurnId} has an invalid packet shape`));
        assert.match(diagnostic.error.cause.message, /attributions\[0\] must be a non-empty string/);
        const page = await readFile(join(digestDir, `${stems[0]}.request.md`), "utf8");
        assert.match(page, /Stored packet is invalid; no input messages were reconstructed/u);
        assert.match(page, /attributions\[0\] must be a non-empty string/u);
        assert.ok(page.includes(`[Next](${stems[1]}.request.md)`));

        await access(join(digestDir, `${stems[1]}.system.md`));
        assert.equal(await readFile(join(digestDir, `${stems[1]}.user.md`), "utf8"), "later");
        await access(join(digestDir, `${stems[1]}.response.md`));

        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /Stored packet failures: 1/);
        assert.match(markdown, /T1 \(model turn 1 · [A-Za-z0-9_.-]+-\d+-\d+\):.*packet=invalid/);
        assert.match(markdown, /T2 \(model turn 2 · [A-Za-z0-9_.-]+-\d+-\d+\):.*status=502/);

        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.equal(json.turns.length, 2);
        assert.equal(json.turns[0].packet_failure.raw, malformedPacket);
        assert.match(json.turns[0].packet_failure.error.cause.message, /attributions\[0\] must be a non-empty string/);
        assert.equal(json.turns[1].packet_failure, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
});

describe("digest-missing", () => {
test("{§test-artifact-retention} digest:missing selects only interrupted benchmark specimens", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-missing-"));
    try {
        const interrupted = join(root, "demo-interrupted-a1");
        const complete = join(root, "demo-complete-b2");
        const partial = join(root, "demo-partial-c3");
        const unrelated = join(root, "notes");
        await Promise.all([
            mkdir(interrupted),
            mkdir(join(complete, "digest"), { recursive: true }),
            mkdir(join(partial, "digest"), { recursive: true }),
            mkdir(unrelated),
        ]);
        await Promise.all([
            writeFile(join(interrupted, "plurnk.db"), ""),
            writeFile(join(complete, "plurnk.db"), ""),
            writeFile(join(complete, "digest", "digest.json"), "{}"),
            writeFile(join(partial, "plurnk.db"), ""),
            writeFile(join(partial, "digest", "digest.md"), "partial waterfall"),
            writeFile(join(partial, "digest", "digest.json.partial"), "{"),
            writeFile(join(unrelated, "readme.txt"), ""),
        ]);

        assert.deepEqual(missingDigestDirs(root), [interrupted, partial]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§test-artifact-retention} digest:missing replaces an interrupted partial digest with a complete one", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-recover-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const db = await openMigrated(join(root, "plurnk.db"));
    await db.close();
    await mkdir(join(root, "digest"));
    await writeFile(join(root, "digest", "digest.json.partial"), "{");

    recoverDigest(root);

    assert.deepEqual(JSON.parse(await readFile(join(root, "digest", "digest.json"), "utf8")).workspaces, []);
    assert.equal((await readdir(join(root, "digest"))).includes("digest.json.partial"), false);
});
});

describe("emission-history", () => {
const op = PlurnkParser.frame;
const note = (body: string) => op("NOTE", body);
const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning } });
const previousProgram = (messages: readonly ChatMessage[]): string => messages.filter(({ role }) => role === "assistant").map(chatMessageText).join("\n\n");
const observations = (messages: readonly ChatMessage[]): string => messages.filter(({ role }) => role === "user").map(chatMessageText).join("\n\n");
const announcementOf = (turn: number): RegExp => new RegExp(
    `^### log:///1/${turn}/\\d+/emission \\(ops://writer/1/${turn}\\) · \\d+$`, "u",
);
const withHistory = async (mode: string, fn: () => Promise<void>): Promise<void> => {
    const name = "PLURNK_SERVICE_EMISSION_HISTORY";
    const previous = process.env[name];
    process.env[name] = mode;
    try { await fn(); } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
};

test("{§emission-history} {§packet-assembly}: each turn's operations precede their results and settled history stays a prefix", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "interpolated-history");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Write, inspect, and reply.");
    const edit = op("EDIT (workspace:///memo.md)", "Persist this exact body.");
    const read = op("READ (workspace:///memo.md)", null);
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(`${note("Memory before writing.")}\n\n${edit}`, note("Reasoning memory.")),
        say(`${read}\n\n${note("Checking what landed.")}`),
        say(op("SEND [200]", "Done.")),
    ] });
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
    const [opening, afterEdit, afterRead] = provider.received;
    assert.ok(opening && afterEdit && afterRead);
    assert.deepEqual(afterRead.map(({ role }) => role), ["system", "user", ...Array.from({ length: 2 }, () => ["assistant", "user"]).flat()]);
    assert.deepEqual(afterRead.filter(({ role }) => role === "assistant").map(chatMessageText), [`${note("Memory before writing.")}\n\n${edit}`, `${read}\n\n${note("Checking what landed.")}`]);
    for (const [index, operations] of [[2, ["NOTE", "EDIT"]], [4, ["READ", "NOTE"]]] as const) {
        assert.match(chatMessageText(afterRead[index + 1]), new RegExp(`^${operations.map((operation) => `### log:///1/\\d+/\\d+/${operation}${operation === "NOTE" ? "" : " \\(workspace:///memo\\.md\\)"} · \\d+`).join("[\\s\\S]*")}`, "u"), "the turn's receipts follow it, in order, each naming its operand");
    }
    const log = observations(afterRead);
    assert.match(log, /Reasoning memory\./u, "a reasoning NOTE is not in the program and keeps its ordinary row");
    assert.doesNotMatch(log, /Memory before writing\.|Checking what landed\./u, "authored memory appears only in assistant operations");
    assert.doesNotMatch(previousProgram(afterRead), /Reasoning memory\./u, "reasoning operations never enter content replay");
    assert.deepEqual(afterRead.slice(0, 3), afterEdit.slice(0, 3), "the earlier roles and bytes stay identical");
    // The retained results end where the status clump begins ({§packet-assembly}).
    const oldResults = chatMessageText(afterEdit[3]).split(/\n\n## (?:Git Status|Context|Session)\n/u)[0];
    assert.ok(chatMessageText(afterRead[3]).startsWith(oldResults), "new observations append after retained results");
});

for (const mode of ["none", "latest", "all"]) {
    test(`{§emission-history}: ${mode} replays operations without changing execution or source evidence`, async () => withHistory(mode, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `history-${mode}`);
            const sessionId = await insertSession(db, workspaceId, null, "writer");
            const loopId = await insertLoop(db, sessionId, 1, "Edit, inspect, and reply.");
            const firstNote = note("First memory.");
            const first = `${firstNote}\n\n${op("EDIT (workspace:///memo.md)", "Actual replacement.\nLast line.")}`;
            const secondNote = note("Second memory.");
            const second = `${op("READ (workspace:///memo.md)", null)}\n\n${secondNote}`;
            const final = op("SEND [200]", "Done.");
            const provider = new Mock({ contextWindow: 100000, responses: [
                say(first, note("Reasoning memory.")), say(second), say(final),
            ] });
            const schemes = new SchemeRegistry();
            const result = await new Engine({ db, schemes }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
            assert.equal(result.result.status, 200);
            assert.equal(provider.received.length, 3, "replay neither executes programs again nor changes the loop");
            assert.equal(previousProgram(provider.received[0]), "");
            assert.equal(previousProgram(provider.received[1]), mode === "none" ? "" : first);
            assert.equal(previousProgram(provider.received[2]), mode === "none" ? "" : mode === "latest" ? second : `${first}\n\n${second}`);
            const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
            assert.equal(source?.content, first, "replay never changes addressable evidence");
            const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
            const packet = await builder.buildRequestPacket({ workspaceId, sessionId, loopId, currentTurnSeq: 5, provider, initialMessages: [], gitStatus: null });
            assert.equal(previousProgram(PacketWire.packetToWireMessages(packet)), mode === "all" ? `${first}\n\n${second}\n\n${final}` : mode === "latest" ? final : "", "a concluding SEND remains a whole operation");
            assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0));
            const nextLoop = await insertLoop(db, sessionId, 2, "New request.");
            const next = await builder.buildRequestPacket({ workspaceId, sessionId, loopId: nextLoop, currentTurnSeq: 1, provider, initialMessages: [], gitStatus: null });
            assert.equal(previousProgram(PacketWire.packetToWireMessages(next)), "", "replay is scoped to the current loop");
            if (mode !== "none") assert.match(observations(PacketWire.packetToWireMessages(next)), /First memory\./u, "a NOTE of a turn that is not replayed renders as an ordinary row");
        } finally { await db.close(); }
    }));
}

test("{§emission-history}: all replays older eligible turns across a reasoning-only turn and a syntax failure", async () => withHistory("all", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "history-eligibility");
        const sessionId = await insertSession(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, sessionId, 1, "Work.");
        const kept = note("Kept finding.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            say(`${kept}\n\n${op("SEND", "Progress update.")}`), say("", note("Reasoning memory.")),
            say(`${note("Partial program.")}\n\n\`\`\`READ (unclosed`),
            say(op("SEND [200]", "Done.")),
        ] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 5 });
        assert.equal(provider.received.length, 4);
        for (const request of provider.received.slice(1)) assert.equal(previousProgram(request), `${kept}\n\n${op("SEND", "Progress update.")}`, "a syntactically partial program is not eligible, NOTE or no NOTE");
    } finally { await db.close(); }
}));

test("{§emission-history}: retiring an emission removes only that turn's replay, and its NOTEs return to the log as rows", async () => withHistory("all", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "history-curation");
        const sessionId = await insertSession(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, sessionId, 1, "Work.");
        const firstNote = note("First finding.");
        const secondNote = note("Second finding.");
        const curate = op("KILL (log:///1/2/*/emission)", null);
        const provider = new Mock({ contextWindow: 100000, responses: [
            say(`${firstNote}\n\n${op("SEND", "First progress update.")}`), say(`${secondNote}\n\n${op("SEND", "Second progress update.")}`), say(curate), say(op("SEND [200]", "Done.")),
        ] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 5 });
        assert.equal(provider.received.length, 4);
        assert.equal(previousProgram(provider.received[2]), `${firstNote}\n\n${op("SEND", "First progress update.")}\n\n${secondNote}\n\n${op("SEND", "Second progress update.")}`);
        assert.equal(previousProgram(provider.received[3]), `${secondNote}\n\n${op("SEND", "Second progress update.")}`, "curation removes the retired turn's replay without replaying the successful curation KILL itself");
        const request = provider.received[3];
        const index = request.findIndex(({ role }) => role === "assistant");
        assert.match(chatMessageText(request[index - 1]).split("\n\n").at(-1)!, announcementOf(3), "the surviving turn keeps its source announcement");
        const log = observations(request);
        assert.doesNotMatch(log, /### log:\/\/\/1\/2\/\d+\/emission/u, "only the retired emission row is gone");
        assert.match(log, /### log:\/\/\/1\/2\/\d+\/NOTE · \d+\n[^\n]*\n1:First finding\./u, "the retired turn's NOTE is an ordinary row again, body and all");
        const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
        assert.equal(source?.content, `${firstNote}\n\n${op("SEND", "First progress update.")}`, "the immutable source is untouched");
    } finally { await db.close(); }
}));

test("{§emission-history}: mixed KILL targets execute normally; a retired NOTE leaves the replay, the distillation stays in the log, and sources stay readable", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "history-mixed-curation");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Draft and curate.");
    const edit = op("EDIT (workspace:///memo.md)", "Draft.");
    const first = `${edit}\n\n${note("Superseded memory.")}`;
    const mixed = op("KILL (log:///1/2/*/NOTE) (workspace:///memo.md)", null);
    const distilled = op("KILL (log:///1/2/*/EDIT)", "The draft was removed.");
    const second = `${mixed}\n\n${distilled}`;
    const provider = new Mock({ contextWindow: 100000, responses: [say(first), say(second), say(op("SEND [200]", "Done."))] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const ids = { workspaceId, sessionId, loopId };
    const result = await engine.runLoop({ ...ids, provider, messages: [], maxTurns: 4 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.equal(previousProgram(provider.received[1]), first, "before curation the turn replays EDIT and NOTE");
    assert.equal(previousProgram(provider.received[2]), op("KILL (workspace:///memo.md)", null), "the file deletion remains; successful curation and retired operations do not replay");
    const log = observations(provider.received[2]);
    assert.doesNotMatch(log, /Superseded memory\./u, "the curated NOTE is gone from row and replay alike");
    assert.match(log, /The draft was removed\./u, "the KILL body still distills into an ordinary NOTE row");
    const missing = await clientRead(engine, db, { workspaceId, sessionId, statement: readStmt(urlPath("workspace", "/memo.md")) });
    assert.equal(missing.status, 404, "the file KILL in the mixed target executed");
    for (const [turn, original] of [[2, first], [3, second]] as const) {
        const parsed = PlurnkParser.parse(op(`READ (ops://writer/1/${turn}) <1,-1>`, null)).items[0];
        assert.ok(parsed?.kind === "statement");
        const source = await clientRead(engine, db, { workspaceId, sessionId, statement: parsed.statement });
        assert.equal(source.status, 200);
        assert.equal(source.content, original, "an explicit source READ keeps NOTE, curation, grouped targets and every body");
    }
});

test("{§emission-history} {§operator-config-precedence}: complete operations replay without parsing nested examples or replaying reasoning", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-whole");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Edit, inspect, and reply.");
    const body = "Actual replacement.\n```NOTE\nA literal nested example, not an operation.\n```\nLast line.";
    const contentNote = note("Content memory.");
    const first = [op("EDIT (workspace:///memo.md)", body), contentNote, op("WAIT [0]", null)].join("\n\n");
    const readNote = note("Read it back.");
    const second = `${op("READ (workspace:///memo.md)", null)}\n\n${readNote}`;
    const reasoning = `Unretained deliberation.\n\n${note("Reasoning memory.")}`;
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(first, reasoning),
        say(second), say(op("SEND [200]", "Finished.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const result = await engine.runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.deepEqual(provider.received[0].map(({ role }) => role), ["system", "user"]);
    for (const [index, request] of provider.received.slice(1).entries()) {
        assert.deepEqual(request.map(({ role }) => role), ["system", "user", ...Array.from({ length: index + 1 }, () => ["assistant", "user"]).flat()], "each replayed turn is one assistant message before its receipts");
        assert.match(chatMessageText(request[1]), /^## Log\n/u);
        assert.match(chatMessageText(request.at(-1)!), /\n\n## Session\n/u);
    }
    const [opening, afterEdit, afterRead] = provider.received.map(observations);
    assert.doesNotMatch(opening, /## Previous Emission/u);
    assert.equal(previousProgram(provider.received[1]), first, "the EDIT body and its nested example remain whole");
    assert.equal(previousProgram(provider.received[2]), `${first}\n\n${second}`, "replays accumulate in turn order");
    assert.doesNotMatch(previousProgram(provider.received[1]), /Reasoning memory/u, "reasoning operations stay in their channel");
    assert.match(afterEdit, /Reasoning memory\./u, "a reasoning NOTE persists as an ordinary row");
    assert.doesNotMatch(afterEdit, /Content memory\./u, "a paired receipt does not duplicate its authored body");
    assert.doesNotMatch(afterEdit, /Unretained deliberation\.|\/reasoning \(reasoning:\/\//u, "automatic reasoning return is off");
    const record = afterEdit.split("\n\n").find((text) => /^### log:\/\/\/1\/2\/\d+\/emission/u.test(text))!;
    assert.ok(record);
    assert.match(record, announcementOf(2));
    assert.ok(afterRead.includes(record), "aging the replay never changes the old record's bytes or weight");
    assert.equal(Number(/ · (\d+)/u.exec(record)![1]), contentWeight(record), "the announcement charges only its own record");
    const reads = await db.test_log_entries_by_session_op_full.all<{ rx: string }>({ session_id: sessionId, op: "READ" });
    assert.ok(reads.some(({ rx }) => (JSON.parse(rx) as { content?: string }).content === body), "the actual EDIT wrote the full replacement");
    const source = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "ops", sequence: 0 });
    assert.equal(source?.content, first, "the immutable source is untouched");
    const reasoningSource = await db.turn_source_read.get<{ content: string }>({ workspace_id: workspaceId, session_name: "writer", loop_seq: 1, turn_seq: 2, kind: "reasoning", sequence: 0 });
    assert.equal(reasoningSource?.content, reasoning, "reasoning remains addressable without automatic return");
    const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
    const packet = await builder.buildRequestPacket({ workspaceId, sessionId, loopId, currentTurnSeq: 5, provider, initialMessages: [], gitStatus: null });
    assert.equal(PacketWire.sectionContent(packet, "emission-history"), `${first}\n\n${second}\n\n${op("SEND [200]", "Finished.")}`, "the concluding reply remains complete");
    assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0), "each message is charged exactly once");
    const nextLoop = await insertLoop(db, sessionId, 2, "A new request.");
    const next = await builder.buildRequestPacket({ workspaceId, sessionId, loopId: nextLoop, currentTurnSeq: 1, provider, initialMessages: [], gitStatus: null });
    assert.equal(PacketWire.sectionContent(next, "emission-history"), "", "a new loop does not inherit a prior loop's replay");
});

for (const [name, content, reasoning, expected] of [
    ["runtime refusal", op("READ (workspace:///missing.md)", null), null, op("READ (workspace:///missing.md)", null)],
    ["syntax failure after a valid operation", `${note("admitted")}\n\n\`\`\`READ (unclosed`, null, ""],
    ["reasoning-only turn", "", note("Only reasoning."), ""],
    ["content NOTE only", note("Log memory only."), null, note("Log memory only.")],
    ["unmatched log curation", op("KILL (log:///1/1/*/FIND)", null), null, op("KILL (log:///1/1/*/FIND)", null)],
    ["empty turn", "", null, ""],
] as const) {
    test(`{§emission-history}: latest evaluates ${name} on the immediate turn, never an older program`, async (t) => withHistory("latest", async () => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, name);
        const sessionId = await insertSession(db, workspaceId, null, "writer");
        const loopId = await insertLoop(db, sessionId, 1, "Work.");
        const older = note("OLDER MEMORY");
        const provider = new Mock({ contextWindow: 100000, responses: [say(`${older}\n\n${op("SEND", "Older progress.")}`), say(content, reasoning), say(op("SEND [200]", "Done."))] });
        await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
        assert.equal(provider.received.length, 3);
        assert.equal(previousProgram(provider.received[1]), `${older}\n\n${op("SEND", "Older progress.")}`);
        assert.equal(previousProgram(provider.received[2]), expected);
    }));
}

for (const mode of ["latest", "all"]) test(`{§emission-history}: ${mode} never replays an exhausted rejected turn`, async (t) => withHistory(mode, async () => {
    const limit = process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS;
    process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS = "1";
    t.after(() => {
        if (limit === undefined) delete process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS;
        else process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS = limit;
    });
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "previous-rejected");
    const sessionId = await insertSession(db, workspaceId, null, "writer");
    const loopId = await insertLoop(db, sessionId, 1, "Work.");
    const older = note("Old memory.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        say(`${older}\n\n${op("SEND", "Old admitted program.")}`),
        say(`### log:///1/2/9/READ\nInvented receipt.\n\n${note("Rejected program.")}`),
        say(op("SEND [200]", "Done.")),
    ] });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const args = { workspaceId, sessionId, loopId, provider, messages: [] };
    await engine.runTurn(args);
    const rejected = await engine.runTurn(args);
    assert.equal(rejected.emissionExhausted, true);
    await engine.runTurn(args);
    assert.equal(provider.received.length, 3);
    assert.equal(previousProgram(provider.received[2]), mode === "all" ? `${older}\n\n${op("SEND", "Old admitted program.")}` : "");
    assert.doesNotMatch(observations(provider.received[2]) + previousProgram(provider.received[2]), /Rejected program\./u, "a rejected attempt's NOTE is nowhere");
}));
});

describe("packet-assembled", () => {
const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<{ sections: Array<{ name: string; slot: string; header: string | null; content: string; weight: number }> }> =>
    JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);

test("{§execution-output-identity}: assembled receipts and child inventory identify anonymous WORK and FORK", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-anonymous-sessions-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "delegate two reviews");
        const children: number[] = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            injectSession: async (args) => {
                children.push(args.sessionId);
                const history = await db.test_fork_loops.all({ session_id: args.sessionId });
                const childLoopId = await insertLoop(db, args.sessionId, history.length + 1, args.prompt);
                return { action: "enqueued_new_loop", loopId: childLoopId, message: `message://child/${childLoopId}` };
            },
        });
        const parsed = PlurnkParser.parseStatements([
            PlurnkParser.frame("WORK", "Review the files."),
            PlurnkParser.frame("FORK", "Review the reasoning."),
        ].join("\n"), { executors: fixtureExecutors([
            PlurnkParser.frame("WORK", "Review the files."),
            PlurnkParser.frame("FORK", "Review the reasoning."),
        ].join("\n")) });
        assert.deepEqual(parsed.items.filter(({ kind }) => kind === "error"), []);
        const branches = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [...branches, noteStmt("Continue.")] } },
                { assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] } },
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);
        const receipts = logEntries(packet).filter(({ logPath: path }) => /\/(WORK|FORK)$/.test(path));
        assert.equal(receipts.length, 2);
        const names = await Promise.all(children.map(async (id) => (await db.session_get.get<{ name: string }>({ id }))!.name));
        assert.equal(new Set(names).size, 2);
        const pointers = packetSection(packet, "work");
        for (const [index, name] of names.entries()) {
            assert.match(name, /^[a-f0-9]{8}$/);
            assert.equal(receipts[index]?.session, `session://${name}`, "the outcome address is visible beside the spawning operation");
            assert.equal(receipts[index]?.path, undefined, "no address is invented for the authored operand");
            assert.ok(pointers.includes(`session://${name}`), "the same identity appears in the ordinary live-child inventory");
        }
        assert.match(String(receipts[0]?.body), /Review the files\./);
        assert.match(String(receipts[1]?.body), /Review the reasoning\./);
    } finally { await db.close(); }
});

test("{§zero-width-column-one-insert} assembled packet: editable READ lines carry copyable anchors without changing their visible ordinals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-line-anchor-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "inspect notes");
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const target = urlPath("workspace", "/anchored.md");
        const source = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [
                    editStmt(target, source),
                    readStmt(target, { marks: [9, 10] }),
                    noteStmt("Continue."),
                ] } },
                { assistant: { content: "", reasoning: null, ops: [completeStmt()] } },
            ],
        });

        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const read = logEntries(await getPacket(db, second.turnId)).find((entry) =>
            entry.path === "workspace:///anchored.md"
            && typeof entry.logPath === "string"
            && entry.logPath.endsWith("/READ"));
        assert.equal(read?.path, "workspace:///anchored.md");
        assert.match(String(read?.body), /^ *9<@[0-9A-Za-z]{5}>line 9\n *10<@[0-9A-Za-z]{5}>line 10\n$/);
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} assembled packet: landed EDIT receipts expose causal parser-recovery evidence only when relevant", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-edit-parse-issues-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "edit Go sources");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const brokenTarget = urlPath("workspace", "/broken.go");
        const cleanTarget = urlPath("workspace", "/clean.go");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [
                    editStmt(brokenTarget, "package sample\nfunc broken("),
                    editStmt(cleanTarget, "package sample\nfunc valid() {}"),
                    noteStmt("Continue."),
                ] } },
                { assistant: { content: "", reasoning: null, ops: [completeStmt()] } },
            ],
        });

        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const edits = logEntries(await getPacket(db, second.turnId)).filter((entry) =>
            typeof entry.logPath === "string" && entry.logPath.endsWith("/EDIT"));
        const broken = edits.find((entry) => entry.path === "workspace:///broken.go");
        const clean = edits.find((entry) => entry.path === "workspace:///clean.go");
        assert.match(String(broken?.parseIssues), /^0->[1-9]\d*$/);
        assert.equal(clean !== undefined && "parseIssues" in clean, false);
    } finally { await db.close(); }
});

test("{§capability-admission}: packet assembly surfaces invalid workspace policy", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-policy-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ capabilities: { deny: "invalid" } }) });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }],
        });

        await assert.rejects(
            engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message, `Workspace ${workspaceId} has invalid persisted capability policy.`);
                assert.ok(error.cause instanceof InvalidCapabilityPolicyError);
                return true;
            },
        );
    } finally { await db.close(); }
});

test("{§session-initialization-entry} assembled packet: the turn-0 catalog foist renders its entries into the log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // foist markerless shallow maps at turn 0
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-backbone-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "subject");
        const loopId = await insertLoop(db, sessionId, 1, "what do I have?"); // {§session-initialization-entry}: first loop foists
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "the answer is 42", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/nested/deep.md", channel: "body", content: "nested", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/.env.defaults", channel: "body", content: "KNOB=1", mimetype: "text/plain" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/.github/settings.yml", channel: "body", content: "setting: true", mimetype: "text/yaml" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const rows = await db.test_log_entries_by_loop.all<{ id: number; op: string | null; origin: string; tx: string; rx: string; attrs: string }>({ loop_id: loopId });
        const foists = rows
            .filter((row) => row.origin === "_plurnk" && (row.op === "FIND" || row.op === "READ") && !LogEntryProjection.isEmission(row));
        assert.ok(foists.length > 0, "the first turn persists its structural observation foists");
        const sources = await db.test_turn_sources.all<{ kind: string; producer: string; content: string }>({ session_id: sessionId });
        const turnSource = sources.find(({ kind, producer }) => kind === "ops" && producer === "_plurnk");
        assert.ok(turnSource, "initialization stores its exact program as its ops source ({§session-initialization-entry})");
        const source = turnSource.content;
        const sourceFoists = PlurnkParser.parseStatements(source).items.flatMap((item) => item.kind === "statement" ? [item.statement] : [])
            .filter(({ op }) => op === "FIND" || op === "READ");
        assert.equal(sourceFoists.length, foists.length, "the exact source accounts for every structural observation");
        for (const [index, { tx }] of foists.entries()) {
            const statement = JSON.parse(tx) as { position?: unknown };
            assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
            assert.deepEqual(
                statement.position,
                sourceFoists[index].position,
                "the dispatched statement preserves its coordinate in the exact initialization source",
            );
        }
        const packet = await getPacket(db, result.turnId);
        const log = packetSection(packet, "log");

        // The foisted FIND(workspace:///*) renders its RESULT into the log
        // ({§zero-width-column-one-insert}) — the model sees the catalog groups, not just its own
        // echoed query.
        assert.match(log, /workspace:\/\/\/note\.md/, "the foisted catalog FIND renders a direct entry into the packet's log");
        assert.match(log, /workspace:\/\/\/\.env\.defaults/, "the one-level page includes direct dot entries");
        assert.match(log, /"path":"workspace:\/\/\/\.github\/\*\*","items":1,"tokens":\d+/, "a dot directory renders as an actionable recursive summary");
        assert.match(log, /"path":"workspace:\/\/\/nested\/\*\*","items":1,"tokens":\d+/, "a directory renders as an actionable recursive summary");
        assert.doesNotMatch(log, /workspace:\/\/\/nested\/deep\.md/, "the opening map does not dump a summarized descendant");
        for (const path of [".env.defaults", ".github/**", "nested/**", "note.md"]) {
            const target = `workspace:///${path}`;
            const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            assert.match(
                log,
                new RegExp(`\\n\\d+:\\[{1,2}\\{"path":"${escaped}`),
                `${target} begins its own universally numbered FIND row`,
            );
        }
        assert.ok(logEntries(packet).some(({ logPath: path }) => path.endsWith("/FIND")), "the catalog foist appears as a FIND op in the log address");
        const initialization = logEntries(packet)
            .filter(({ logPath: path }) => path.startsWith("log:///1/1/"));
        assert.deepEqual(
            [...new Set(initialization.map(({ logPath: path }) => path.split("/").at(-1) ?? ""))].toSorted(),
            ["FIND", "NOTE"],
            "{§session-initialization-entry}: turn 0 exposes its NOTEs and its surveys, and nothing else",
        );
        assert.equal(initialization.some(({ path: target }) => target?.startsWith("ops://") === true), false,
            "turn 0 reads none of its own program, and it announces no emission ({§turn-source-resources})");
        assert.deepEqual(provider.received[0].filter(({ role }) => role === "assistant"), []);
        const initializationOutcomes = initialization;
        assert.deepEqual(
            initializationOutcomes.filter(({ path: target }) => target !== undefined).map(({ path: target }) => target),
            ["workspace:///*"],
            "only the survey with entries runs: no reference is materialized and the session's own space is new ({§session-initialization-entry})",
        );
        assert.doesNotMatch(log, /workspace:\/\/\/_plurnk\/plurnk\/sh\.md/, "turn-0 never privileges the sh skill with an orientation READ");

    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("{§log-wire-format}: exact matcher FIND shows flat surgical coordinates with one compact extent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-matches-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "find the target");
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/notes.md",
            channel: "body",
            content: "heading\ntarget one\ncontext\ntarget two",
            mimetype: "text/markdown",
        });

        const matchedFind = {
            ...findStmt(urlPath("workspace", "/notes.md")),
            matcher: regex("target"),
        };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [matchedFind, noteStmt("Continue.")] } },
                { assistant: { content: "", reasoning: null, ops: [completeStmt()] } },
            ],
        });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const log = packetSection(await getPacket(db, second.turnId), "log");

        assert.match(log, /^### log:\/\/\/\S+\/FIND \(workspace:\/\/\/notes\.md\) \/target\/ · \d+$/m, "the addressed resource and matcher return on the receipt heading");
        assert.match(log, /"range":"2 match locations"/);
        assert.doesNotMatch(log, /"matchLocationCount":2/);
        assert.doesNotMatch(log, /"matchingPathCount":1/);
        // {§find-result-projection}: a location reads in the scope notation with its matched text, its default channel unnamed.
        assert.match(log, /1:\[\{"region":"<2,1,2,7>","matched":"target"\},/);
        assert.match(log, /2:\{"region":"<4,1,4,7>","matched":"target"\}\]/);
        assert.match(log, /workspace:\/\/\/notes\.md/);
    } finally { await db.close(); }
});

test("{§op-shapes} assembled packet: scoped COPY reports both operands and its landed text materialization", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-copy-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "copy the selected lines");
        const source = urlPath("workspace", "/src.md");
        const destination = urlPath("workspace", "/slice.md");
        const scopedCopy = copyStmt(source, destination, { marks: [2, 3] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                {
                    assistant: {
                        content: "",
                        reasoning: null,
                        ops: [
                            editStmt(source, "one\ntwo\nthree\nfour"),
                            scopedCopy,
                            scopedCopy,
                            noteStmt("Continue."),
                        ],
                    },
                },
                { assistant: { content: "", reasoning: null, ops: [completeStmt()] } },
            ],
        });

        const first = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.deepEqual(first.outcomes, [
            { op: "EDIT", status: 201, problemType: null },
            { op: "COPY", status: 201, problemType: null },
            { op: "COPY", status: 304, problemType: null },
            { op: "NOTE", status: 200, problemType: null },
        ]);
        const second = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);
        // Turn 0 archives the prompt by COPY (log:///1/1/…); the model's two are under test.
        const copies = logEntries(packet).filter(({ logPath: path }) => path.endsWith("/COPY") && !path.startsWith("log:///1/1/"));

        assert.equal(copies.length, 2);
        assert.equal(copies[0]?.from, "workspace:///src.md");
        assert.deepEqual(copies[0]?.scope, { from: "<2,3>" });
        assert.equal(copies[0]?.to, "workspace:///slice.md");
        assert.equal(copies[0]?.status, 201);
        assert.ok(Array.isArray(copies[0]?.effects));
        const [effect] = copies[0].effects as Array<Record<string, unknown>>;
        assert.equal(effect?.path, "workspace:///slice.md");
        assert.equal(effect?.action, "create");
        assert.equal(Object.hasOwn(effect ?? {}, "rev"), false, "no revision token in the packet");
        assert.equal(effect?.extent, "lines 0->2");
        assert.equal(effect?.change, "lines -0 +2");
        assert.equal(effect?.effect, "<1,1,1,1> -> <1,2>");
        assert.ok(copies[0] !== undefined && "body" in copies[0], "the landed materialization is open (body present, #338)");
        assert.equal(copies[1]?.from, "workspace:///src.md");
        assert.deepEqual(copies[1]?.scope, { from: "<2,3>" });
        assert.equal(copies[1]?.to, "workspace:///slice.md");
        assert.equal(copies[1]?.status, 304);
        assert.equal(copies[1]?.effects, undefined);
        assert.ok(copies[1] !== undefined && !("body" in copies[1]), "the whole-channel effect has no text body (#338)");

        assert.match(packetSection(packet, "log"), /1(?:<@[0-9A-Za-z]{5}>|:)two\n2(?:<@[0-9A-Za-z]{5}>|:)three/);
    } finally { await db.close(); }
});

test("{§packet-assembly} the initial wire preserves canonical order and the Recap override without invented history", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-monotone-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({
            provider,
            recap: "CUSTOM_RECAP_SENTINEL",
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const packet = await getPacket(db, result.turnId);

        // {§packet-assembly}: trusted control-plane sections precede the user slot;
        // append-mostly history precedes per-turn status, open message pointers and Recap.
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.deepEqual(slot("system"), ["definition", "system-policy"], "the stable system prefix has no injected resource catalog");
        assert.deepEqual(slot("user"), ["log", "git", "budget", "session", "work", "messages", "notices", "errors", "recap"]);
        assert.deepEqual(slot("assistant"), []);
        assert.equal(packet.sections.find((section) => section.name === "messages")?.header, "Open Messages");
        assert.equal(packet.sections.find((section) => section.name === "budget")?.header, "Context");
        assert.equal(packetSection(packet, "recap"), "CUSTOM_RECAP_SENTINEL", "{§packet-inject}: the override replaces the source; no recap line ships ahead of it");
        assert.equal(packetSection(packet, "emission-history"), "", "the first turn has no previous program");
    } finally { await db.close(); }
});

test("{§packet-inject} no recap line ships and the recap source is empty, so a packet has no Recap", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-recap-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const packet = await getPacket(db, result.turnId);

        assert.equal(await readFile(Paths.defaultRecap, "utf8"), "", "{§packet-inject}: the shipped recap source stays empty");
        assert.equal(packetSection(packet, "recap"), "", "{§packet-inject}: no line ships, so the packet has no Recap");
    } finally { await db.close(); }
});

test("{§tools-resource-materialization} assembled packet: the skills foist surfaces the Session's materialized skills into its log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-docs-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        // A materialized scheme doc is an ordinary entry owned by the Session
        // whose effective Functionality it describes.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/_plurnk/plurnk/session.md", channel: "body", content: "# session\n\n## Summary\n\nManage shared session entries.\n\n## Invocation\n\n````EDIT (workspace:///notes.md)\nNotes.\n````", mimetype: "text/markdown" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const log = packetSection(await getPacket(db, result.turnId), "log");

        // The materialized doc reaches the model through its private FIND, not
        // an inline packet link ({§tools-resource-materialization}).
        assert.match(log, /^### log:\/\/\/\S+\/FIND \(workspace:\/\/\/_plurnk\/plurnk\/\*\.md\) · \d+$/m, "the foist scopes discovery to the Session's skills tree");
        assert.match(log, /workspace:\/\/\/_plurnk\/plurnk\/session\.md/, "the materialized skill surfaces in the foist's rendered result");
        assert.match(log, /"aside":"Manage shared session entries\."/, "the catalog projects the document's Summary without opening its body");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("{§session-initialization-entry} assembled packet: a reference catalog with nothing materialized is left out of turn 0, which still completes", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "2";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-empty-docs-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });

        const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string | null; pathname: string }>({ loop_id: loopId });
        assert.equal(rows.some((row) => row.op === "FIND" && row.scheme === "workspace" && row.pathname === "/_plurnk/plurnk/*.md"), false,
            "the reference survey that would select nothing is left out");
        assert.ok(rows.some((row) => row.origin === "model" && row.op === "SEND"), "and the model's turn still runs and completes");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("{§operator-config-precedence}: the provider packet excludes personal XDG policy", async (t) => {
    const priorPolicy = process.env.PLURNK_SERVICE_POLICY;
    const priorConfig = process.env.XDG_CONFIG_HOME;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-gate-policy-"));
    t.after(async () => {
        if (priorPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = priorPolicy;
        if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorConfig;
        await rm(dir, { recursive: true, force: true });
    });
    await mkdir(join(dir, "plurnk"));
    const personal = "# Personal rules\nDOGFOOD_ONLY_SENTINEL";
    const path = join(dir, "plurnk", "AGENTS.md");
    await writeFile(path, personal);
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.PLURNK_SERVICE_POLICY;
    const profile = parseEnv(await readFile(new URL("../../.env.test", import.meta.url), "utf8"));
    if (profile.PLURNK_SERVICE_POLICY !== undefined) process.env.PLURNK_SERVICE_POLICY = profile.PLURNK_SERVICE_POLICY;
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `pkt-gate-policy-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
    const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "fixture language" }, { role: "user", content: "go" }] });
    const packet = await getPacket(db, result.turnId);
    assert.ok(provider.received.length > 0, "the real packet reaches the provider");
    const system = provider.received.flat().filter(({ role }) => role === "system").map((message) => chatMessageText(message)).join("\n");
    assert.match(system, /fixture language/);
    assert.doesNotMatch(system, /DOGFOOD_ONLY_SENTINEL/);
    assert.equal(packet.sections.find(({ name }) => name === "system-policy")?.content, "", "the policy slot contributes no content");
    assert.equal(await readFile(path, "utf8"), personal, "daily-driving policy remains untouched");
});

test("{§session-initialization-entry} assembled packet: PLURNK_SERVICE_POLICY renders the single privileged system-slot policy section", async () => {
    const priorPolicy = process.env.PLURNK_SERVICE_POLICY;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-policy-"));
    const db = await openMigrated();
    try {
        const sysPath = join(dir, "system-AGENTS.md");
        await writeFile(sysPath, "# House rules\nNEVER guess a file path.");
        process.env.PLURNK_SERVICE_POLICY = sysPath;

        const workspaceId = await insertWorkspace(db, `pkt-policy-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // Policy is the client's foot in the privileged zone — the system slot
        // carries the operator's authoritative rules. Project guidance
        // rides turn 0 as the foisted AGENTS.md entry ({§session-initialization-entry}).
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.deepEqual(slot("system"), ["definition", "system-policy"], "PLURNK_SERVICE_POLICY rides the system slot — privileged, not a READable entry");
        assert.equal(packetSection(packet, "system-policy"), "# House rules\nNEVER guess a file path.", "the authored policy content is preserved");
        assert.equal(packet.sections.find(({ name }) => name === "system-policy")?.header, null, "the policy owns its heading");
        const systemMessage = provider.received[0].filter(({ role }) => role === "system").map((message) => chatMessageText(message)).join("\n");
        assert.match(systemMessage, /# House rules\nNEVER guess a file path\./, "the authored heading reaches the provider");
        assert.doesNotMatch(systemMessage, /^## Policy$/m, "the engine adds no enclosing policy heading");
    } finally {
        await db.close();
        if (priorPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = priorPolicy;
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§child-orientation} the live things a session holds — child sessions — surface as terse pointers in the status clump", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `child-orient-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        // A live child session this session holds (parent_session_id = sessionId; insertLoop's default status 102 = live).
        const child = await insertSession(db, workspaceId, sessionId, "session-x");
        await insertLoop(db, child, 1, "working");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // The live child surfaces as a terse status+path pointer under `sessions` — orienting state, not advice.
        assert.match(packetSection(packet, "work"), /^\{"sessions":\[\{"status":102,"path":"session:\/\/session-x"\}\],\n"streams":\[\],\n"messages":\[\]\}$/, "the live child session is a status+path pointer the model READs/KILLs itself");
        const usr = packet.sections.filter((x) => x.slot === "user").map((x) => x.name);
        assert.ok(usr.includes("work"), "{§child-orientation}: open work rides the status clump");
    } finally { await db.close(); }
});

test("{§child-orientation} no live children or streams → Open Work states every list as empty", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `child-orient-empty-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        // {§child-orientation} — Open Work states emptiness as `[]` for every list: the model
        // decides wait-or-complete on them, so it never infers "none" from a missing heading.
        const packet = await getPacket(db, result.turnId);
        assert.equal(packetSection(packet, "work"), '{"sessions":[],\n"streams":[],\n"messages":[]}', "no live children, no open streams, no sent messages awaiting → all three lists state []");
    } finally { await db.close(); }
});

test("{§packet} assembled packet: definition tables compact without changing other whitespace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-definition-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const definition = [
            "# Definition",
            "",
            "| OP     | purpose                 |",
            "|:-------|------------------------:|",
            "| FIND   | list matching paths     |",
            "| `A \\| B` | preserve escaped pipes |",
            "| ------- | data dashes stay intact  |",
            "",
            "```text",
            "| fenced   | content   |",
            "```",
            "",
            "Prose  spacing remains exact.",
        ].join("\n");
        const expected = [
            "# Definition",
            "",
            "| OP | purpose |",
            "|:---|---:|",
            "| FIND | list matching paths |",
            "| `A \\| B` | preserve escaped pipes |",
            "| ------- | data dashes stay intact |",
            "",
            "```text",
            "| fenced   | content   |",
            "```",
            "",
            "Prose  spacing remains exact.",
        ].join("\n");

        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: definition }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        assert.equal(packetSection(packet, "definition"), expected, "the stored model-facing definition is the compact projection");
        assert.equal(packet.sections.find((section) => section.name === "definition")?.weight, contentWeight(expected), "definition render-weight measures the compact projection");
    } finally { await db.close(); }
});

test("{§packet}: canonical operation examples survive packet projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-definition-grammar-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const definition = await readFile(Paths.instructionsSystem, "utf8");

        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: definition }, { role: "user", content: "go" }] });
        const projected = packetSection(await getPacket(db, result.turnId), "definition");
        const codeBlocks = (markdown: string) => Lexer.lex(markdown)
            .flatMap((token) => token.type === "code" ? [token.text] : []);
        const examples = codeBlocks(definition);
        assert.ok(examples.length > 0, "canonical definition contains operation examples");
        assert.deepEqual(codeBlocks(projected), examples, "packet projection preserves every example's fences and body whitespace");
    } finally { await db.close(); }
});

test("{§tools-resource-materialization}: the assembled packet retains the definition without a second resource catalog", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-shape-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // The grammar (plurnk.md) must reach the model — a dropped definition section is a dead packet.
        assert.ok(packetSection(packet, "definition").length > 0, "the definition (grammar) section carries content");
        assert.deepEqual(packet.sections.filter(({ slot }) => slot === "system").map(({ name }) => name), ["definition", "system-policy"]);
    } finally { await db.close(); }
});
});

describe("packet-extension", () => {
test("{§emission-history} extension packet control: a scheme adds, removes, and reorders packet sections", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-extension-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "p");
        const schemes = new SchemeRegistry();
        const inspected: PacketSectionDraft[][] = [];
        // A third-party extension: prepend its own section, drop the kernel's budget.
        schemes.register("demo", {
            manifest: {
                name: "demo",
                channels: {},
                defaultChannel: "",
                category: "control",
                writableBy: [],
                volatile: false,
                modelVisible: false,
            },
            transformSections(sections: PacketSectionDraft[]): PacketSectionDraft[] {
                inspected.push(structuredClone(sections));
                return [
                    { name: "demo", slot: "user", header: "Demo Extension", content: "hello from the extension" },
                    ...sections.filter((s) => s.name !== "budget"),
                ];
            },
        });
        const engine = new Engine({ db, schemes });
        // {§emission-history}: the transform receives each turn's operations before their results.
        const programs = [
            `${PlurnkParser.frame("EDIT (workspace:///memo.md)", "Kept whole.")}\n\n${PlurnkParser.frame("NOTE", "Wrote the memo.")}`,
            `${PlurnkParser.frame("READ (workspace:///memo.md)", null)}\n\n${PlurnkParser.frame("NOTE", "Read it back.")}`,
            PlurnkParser.frame("SEND [200]", "Done."),
        ];
        const provider = new Mock({ contextWindow: 100000, responses: programs.map((content) => ({ assistant: { content, reasoning: null } })) });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);

        // ADD: the extension's section is in the packet, carrying its content.
        assert.equal(packetSection(packet, "demo"), "hello from the extension");
        const demo = (packet.sections as StoredPacketSection[]).find((section) => section.name === "demo");
        assert.ok(demo !== undefined);
        assert.equal(demo.weight, contentWeight(PacketWire.renderSection(demo)), "core assigns the durable render-weight");
        // REMOVE: the kernel's budget section is gone.
        assert.equal(packetSection(packet, "budget"), "");
        // REORDER: the extension's section leads the user slot.
        const userOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "user").map((s) => s.name);
        assert.equal(userOrder[0], "demo", "extension section leads the user slot");
        assert.ok(!userOrder.includes("budget"), "budget removed from the user slot");
        for (let turn = 0; turn < 2; turn++) await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        const chronological = inspected.find((sections) => sections.filter(({ slot }) => slot === "assistant").length === 2);
        assert.ok(chronological, "the transform receives the complete interpolated history");
        const expected = programs.slice(0, 2);
        assert.deepEqual(chronological.filter(({ slot }) => slot === "assistant").map(({ content }) => content), expected);
        for (const [index, section] of chronological.entries()) {
            if (section.slot !== "assistant") continue;
            const receipt: PacketSectionDraft = chronological[index + 1];
            assert.equal(receipt.slot, "user");
            assert.match(receipt.content, /^### log:\/\/\/\d+\/\d+\/\d+\/(?:EDIT|READ) \(\S+\) · \d+/u, "every turn is followed by its receipts, each naming its operand");
        }
        assert.equal(provider.received.length, 3);
        const last = provider.received[2];
        assert.deepEqual(last.filter(({ role }) => role === "assistant").map(chatMessageText), expected);
        assert.match(chatMessageText(last[3]), /^### log:\/\/\/1\/2\/\d+\/EDIT/u, "transformed packets retain the chronological result boundary");
        assert.doesNotMatch(last.map(chatMessageText).join("\n"), /## Context\n/u, "the transform still removes the requested section");
    } finally { await db.close(); }
});

test("{§packet-assembly} extension packet control: duplicate section names fail at the owning scheme boundary", async () => {
    const schemes = new SchemeRegistry();
    schemes.register("broken", {
        manifest: {
            name: "broken",
            channels: {},
            defaultChannel: "",
            category: "control",
            writableBy: [],
            volatile: false,
            modelVisible: false,
        },
        transformSections(): PacketSectionDraft[] {
            return [
                { name: "duplicate", slot: "user", header: null, content: "first" },
                { name: "duplicate", slot: "user", header: null, content: "second" },
            ];
        },
    });

    await assert.rejects(
        schemes.transformSections([]),
        /scheme 'broken' transformSections result has duplicate section name 'duplicate'/,
    );
});
});

describe("packet-inject", () => {
test("{§packet-inject} PLURNK_SERVICE_PACKET_INJECT: operator file rides as a system section after policy", async () => {
    const db = await openMigrated();
    const dir = await mkdtemp(join(tmpdir(), "plurnk-inject-intg-"));
    const prior = process.env.PLURNK_SERVICE_PACKET_INJECT;
    try {
        await writeFile(join(dir, "ops.md"), "## House style\nPrefer sqlite over node.");
        process.env.PLURNK_SERVICE_PACKET_INJECT = join(dir, "ops.md");

        const workspaceId = await insertWorkspace(db, `inject-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });

        const { turnId } = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "system", content: "PLURNK_MD" }, { role: "user", content: "go" }],
        });

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);
        assert.match(packetSection(packet, "inject"), /Prefer sqlite over node/, "the operator file is the inject section's content");
        const sysOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "system").map((s) => s.name);
        assert.equal(sysOrder.indexOf("inject"), sysOrder.indexOf("system-policy") + 1, "inject follows privileged policy");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_PACKET_INJECT; else process.env.PLURNK_SERVICE_PACKET_INJECT = prior;
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
});

describe("packet-items", () => {
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const RECORDS = ["### log:///1/1/1/FIND\n{\"status\":200}\n1:[]", "### log:///1/1/2/READ\n{\"status\":200}\n1:alpha\n2:beta"];
const packet = (records: readonly string[], prompt: string): DurablePacket => ({
    weight: 7,
    sections: [
        { name: "definition", slot: "system", header: null, content: "# Plurnk", weight: 2 },
        { name: "log", slot: "user", header: "Log", content: records.join("\n\n"), weight: 4, items: records },
        { name: "messages", slot: "user", header: "Open Messages", content: prompt, weight: 1 },
    ],
    attributions: ["session://a"],
});

test("{§packet}: a turn stores only the items the previous turn did not, and reads back exactly", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `packet-items-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const first = packet(RECORDS.slice(0, 1), "[{\"path\":\"log:///1/1/1/SEND\"}]");
        const second = packet(RECORDS, "[{\"path\":\"log:///1/1/1/SEND\"}]");
        const firstId = await insertPacketTurn(db, loopId, 1, first, 102);
        const before = (await db.test_packet_item_count.get<{ n: number }>({}))!.n;
        assert.equal(before, 3, "turn 1: definition, one log record, prompt");
        const secondId = await insertPacketTurn(db, loopId, 2, second, 200);
        const after = (await db.test_packet_item_count.get<{ n: number }>({}))!.n;
        assert.equal(after - before, 1, "turn 2 added exactly its new log record; every other block was already stored");

        const items = await db.test_turn_items.all<{ section: number; position: number; item_hash: string; text: string }>({ turn_id: secondId });
        assert.deepEqual(items.map(({ section, position, text }) => ({ section, position, text })), [
            { section: 0, position: 0, text: "# Plurnk" },
            { section: 1, position: 0, text: RECORDS[0] },
            { section: 1, position: 1, text: RECORDS[1] },
            { section: 2, position: 0, text: "[{\"path\":\"log:///1/1/1/SEND\"}]" },
        ]);
        assert.ok(items.every(({ item_hash, text }) => item_hash === sha256(text)), "an item's address is the SHA-256 of its text");

        for (const [id, expected] of [[firstId, first], [secondId, second]] as const) {
            const row = await db.test_get_packet.get<{ packet: string }>({ id });
            const parsed = StoredPacket.parse(row!.packet, `turn ${id}`);
            assert.deepEqual(parsed, { ...expected, sections: expected.sections.map(({ items: _items, ...section }) => section) }, "the assembled packet is the stored packet, sections included, without the items key");
        }
        const bag = await db.test_bag_of_turn.get<{ packet: string }>({ id: secondId });
        assert.equal(JSON.parse(bag!.packet).sections, undefined, "the bag in turns.packet carries no sections");
    } finally { await db.close(); }
});

test("{§packet}: the write view refuses a turn that is not an open model inference turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `packet-items-refuse-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const done = await insertPacketTurn(db, loopId, 1, packet(RECORDS, "[]"), 200);
        await assert.rejects(
            () => Turn.recordInference(db, done, { packet: StoredPacket.stringify(packet([], "[]")), sections: StoredPacket.sections(packet([], "[]")), usageCurationBudget: null, finishReason: null, model: "m", meta: "{}" }),
            /turn is not an open model inference turn/,
        );
    } finally { await db.close(); }
});

test("{§packet}: items nothing references are collected; shared items survive", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `packet-items-collect-${crypto.randomUUID()}`);
        const keeper = await insertSession(db, workspaceId, null, "keeper");
        const leaver = await insertSession(db, workspaceId, null, "leaver");
        await insertPacketTurn(db, await insertLoop(db, keeper, 1, "k"), 1, packet(RECORDS.slice(0, 1), "[\"k\"]"), 200);
        await insertPacketTurn(db, await insertLoop(db, leaver, 1, "l"), 1, packet(RECORDS, "[\"l\"]"), 200);
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 5, "definition + two records + two prompts");
        await db.test_delete_session.run({ id: leaver });
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 5, "deletion cascades the composition, not the items");
        await db.retention_collect_packet_items.run({ collect: 1 });
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 3, "the leaver's own record and prompt are collected; the shared definition and record stay");
    } finally { await db.close(); }
});
});

describe("workspace-prompts", () => {
const send = () => makeMockResponse("````SEND [200]\nok\n````", 50);
const addressed = (thread: string, id: string) => {
    const address = `acp://operator/threads/${thread}/messages/${id}`;
    return { source: address, messageAddress: address };
};

test("{§methods-workspace-create}: workspace prompts are newest-first and limit-capped", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send()] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "prompts-hist" });
            await runLoopToTerminal(ws, 2, { prompt: "first prompt", ...addressed("prompts-hist", "1") });
            await runLoopToTerminal(ws, 3, { prompt: "second prompt", ...addressed("prompts-hist", "2") });

            // Defaults to the attached workspace; newest-first.
            const all = await rpcCall(ws, 4, "workspace.prompts", {});
            assert.deepEqual(
                (all.result as { prompts: string[] }).prompts,
                ["second prompt", "first prompt"],
                "newest-first over the attached workspace's user prompts (no archaeology)",
            );

            // limit caps to the newest N.
            const capped = await rpcCall(ws, 5, "workspace.prompts", { limit: 1 });
            assert.deepEqual((capped.result as { prompts: string[] }).prompts, ["second prompt"], "limit caps to the newest N");

            // Malformed limit fails hard — no silent default.
            const bad = await rpcCall(ws, 6, "workspace.prompts", { limit: 0 });
            const problem = rpcProblem(bad);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/input/limit-invalid");
            assert.equal(problem.value, 0);
            assert.equal(problem.recovery, "Use a positive integer limit."); // {§operation-results}

            // A malformed sessionId fails the same way.
            const badSession = rpcProblem(await rpcCall(ws, 7, "workspace.prompts", { sessionId: 0 }));
            assert.equal(badSession.type, "https://problems.plurnk.xyz/daemon/input/identifier-invalid");
            assert.equal(badSession.field, "sessionId");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: a client prompt at a forked model session is that session's history, not the crack", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send(), send()] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "prompts-fork" });
            const workspaceId = (created.result as { id: number }).id;
            const mainSession = await namedModelSession(daemon, workspaceId, "main");
            await runLoopToTerminal(ws, 2, { prompt: "typed at main", sessionId: mainSession, ...addressed("main", "1") });

            // The TUI's /session + /attach flow: a fork of the thread's session, bound by name, seeded by a human.
            const research = await daemon.forkSession({ workspaceId, sessionId: mainSession, name: "research" });
            await runLoopToTerminal(ws, 3, { prompt: "typed at the research fork", sessionId: research.sessionId, ...addressed("research", "1") });
            await runLoopToTerminal(ws, 4, { prompt: "typed at the research fork again", sessionId: research.sessionId, ...addressed("research", "2") });

            const scopedToFork = await rpcCall(ws, 5, "workspace.prompts", { sessionId: research.sessionId });
            assert.deepEqual(
                (scopedToFork.result as { prompts: string[] }).prompts,
                ["typed at the research fork again", "typed at the research fork"],
                "the forked session's own human prompts are its history, newest-first",
            );
            const scopedToMain = await rpcCall(ws, 6, "workspace.prompts", { sessionId: mainSession });
            assert.deepEqual(
                (scopedToMain.result as { prompts: string[] }).prompts,
                ["typed at main"],
                "the forked session's parent keeps its own history, without the fork's prompts",
            );
            const unscoped = await rpcCall(ws, 7, "workspace.prompts", {});
            assert.deepEqual(
                (unscoped.result as { prompts: string[] }).prompts,
                ["typed at the research fork again", "typed at the research fork", "typed at main"],
                "an omitted sessionId lists every model session's client-addressed seeds",
            );
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: a seed nobody addressed — a session-issued task — is never history", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [send(), send()] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "prompts-authorship" });
            const workspaceId = (created.result as { id: number }).id;
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            await runLoopToTerminal(ws, 2, { prompt: "a human asked this", sessionId, ...addressed("main", "1") });
            // A session-issued seed carries the issuing session as its source and no message address
            // ({§message-arrival}); the seam admits the same shape.
            const task = await runLoopToTerminal(ws, 3, { prompt: "a session delegated this", sessionId, source: "session://exampleSessionName" });
            const seed = await db.test_loop_seed_message.get<{ address: string | null; source: string | null }>({ loop_id: task.loopId });
            assert.deepEqual(seed, { address: null, source: "session://exampleSessionName" }, "the fixture wrote an unaddressed, session-sourced seed");

            const history = await rpcCall(ws, 4, "workspace.prompts", { sessionId });
            assert.deepEqual((history.result as { prompts: string[] }).prompts, ["a human asked this"], "the delegated task is not in the session's history");
        } finally { ws.close(); }
    });
});
});

describe("workspace-share", () => {
test("{§share}: workspace.share writes the workspace's share from the daemon's own database", { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-workspace-share-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const daemon = new Daemon({ db, dbPath, provider: new Mock({ contextWindow: 8192, responses: [] }) });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const ws = await connect({ daemon });
    t.after(() => ws.close());
    await rpcCall(ws, 1, "workspace.create", { name: "not-shared" });
    await rpcCall(ws, 2, "workspace.create", { name: "shared-here" }); // creation attaches the connection
    const folder = join(root, "share_this_session_here");
    const shared = (await rpcCall(ws, 4, "workspace.share", { folder })).result as { folder: string };
    assert.deepEqual(shared, { folder });
    assert.ok(existsSync(join(folder, "digest.md")));
    const digest = JSON.parse(readFileSync(join(folder, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> };
    assert.deepEqual(digest.workspaces.map(({ name }) => name), ["shared-here"], "the share is the attached workspace alone");
    const refused = await rpcCall(ws, 5, "workspace.share", { folder: "relative/folder" });
    const problem = (refused.result as { status: number; problem: { detail: string } });
    assert.equal(problem.status, 400);
    assert.equal(problem.problem.detail, "workspace.share requires an absolute folder.");
});
});
