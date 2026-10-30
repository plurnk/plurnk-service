import assert from "node:assert/strict";
import test, { describe } from "node:test";
import Http from "@plurnk/plurnk-schemes-http";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Paths from "../../src/Paths.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type FindStatement, type ParsedPath, type ReadStatement, Validator } from "@plurnk/plurnk-contracts";
import { type ChannelProducerResult, type RepresentationPreparationRequest, type RepresentationPreparationResult, type SchemeCtx, type SchemeHandler, type SchemeManifest, Results, SchemeDiscovery, type ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { copyStmt, urlPath, completeStmt } from "./_dsl.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertTurn, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { fixtureExecutors } from "./_mock.ts";
import { requestUrl } from "../../../scripts/lib/test-fetch.ts";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PluginRoots, validateManifest } from "@plurnk/plurnk-agent-plugins";
import { TEACHING_CORPUS } from "@plurnk/plurnk-meta";
import { discoverDaemonModules } from "../../src/server/module-discovery.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { serverProposals } from "./_approval.ts";
import { packetSection } from "./_packet.ts";


describe("universal-read", () => {
const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

type DataSchemeManifest = Extract<SchemeManifest, { category: "data" }>;

class EntryBackedScheme implements SchemeHandler {
    static manifest: DataSchemeManifest = {
        name: "entry-backed",
        channels: { body: "text/plain" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model"],
        volatile: false,
        modelVisible: true,
    };
}

class PublicCrudTrapScheme extends EntryBackedScheme {
    static override manifest: DataSchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "public-crud-trap",
    };
    readonly manifest = PublicCrudTrapScheme.manifest;

    async readEntry(): Promise<never> {
        throw new Error("public readEntry must not be dispatched");
    }

    async writeEntry(): Promise<never> {
        throw new Error("public writeEntry must not be dispatched");
    }
}

class ResolvedEntryScheme implements SchemeHandler {
    static manifest: DataSchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "resolved-entry",
    };

    async resolveEntryAddress(target: ParsedPath): Promise<{ authority: string; pathname: string }> {
        assert.equal(target.kind, "url");
        if (target.kind === "url") {
            assert.equal(target.pathname, "/alias_(v1).txt");
            assert.equal(target.fragment, null);
        }
        return { authority: "", pathname: "/canonical.txt" };
    }
}

class OwnerBoundPreparationScheme implements SchemeHandler {
    static manifest: DataSchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "owner-bound-preparation",
    };

    async resolveEntryAddress(): Promise<{ authority: string; pathname: string }> {
        return { authority: "", pathname: "/canonical.txt" };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        assert.equal(request.pathname, "/canonical.txt");
        const prior = await ctx.entries.read(request.pathname);
        if (prior.status === 404) {
            const written = await ctx.entries.write(request.pathname, {
                channels: {
                    body: { content: "prepared for resolved session", mimetype: "text/plain" },
                },
            });
            assert.equal(written.status, 201);
        }
        return { status: 200 };
    }
}

// A deliberately non-network protocol specimen. It knows aliases, acquisition,
// channel topology, private attributes, and producer evidence; it knows nothing about READ,
// FIND, text scope, matching, or pagination.
class ArchiveScheme implements SchemeHandler {
    static manifest: DataSchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "archive",
        channels: {
            body: "text/markdown",
            provenance: "application/json",
        },
    };

    async resolveEntryAddress(target: ParsedPath): Promise<{ authority: string; pathname: string }> {
        const pathname = target.kind === "url" && target.pathname === "/aliases/latest"
            ? "/objects/document.txt"
            : target.kind === "url"
                ? target.pathname
                : target.raw;
        return { authority: "", pathname };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        assert.equal(Object.hasOwn(request, "intent"), false);
        assert.equal(request.pathname, "/objects/document.txt");
        assert.equal("lineMarker" in request.target, false);
        if (request.target.kind === "url") assert.equal(request.target.fragment, null);
        const prior = await ctx.entries.read(request.pathname);
        if (prior.status === 404) {
            const written = await ctx.entries.write(request.pathname, {
                channels: {
                    body: {
                        content: Array.from({ length: 20 }, (_, index) => `prepared ${index + 1}`).join("\n"),
                        mimetype: "text/markdown",
                        producerResult: { status: 203, producer: "archive-specimen" },
                    },
                    provenance: {
                        content: JSON.stringify({ source: "fixture://archive/42" }),
                        mimetype: "application/json",
                    },
                },
                attributes: { kind: "imported" },
            });
            assert.ok(written.status === 200 || written.status === 201);
        } else {
            assert.equal(prior.status, 200);
        }
        return { status: 200 };
    }
}

class IndependentChannelScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        ...EntryBackedScheme.manifest,
        name: "independent-channel",
        channels: {
            body: "text/plain",
            html: "text/html",
        },
    };

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const prior = await ctx.entries.read(request.pathname);
        if (prior.status !== 404) return { status: 200 };
        const htmlFailure = Results.failure(
            "scheme:independent-channel",
            "html-unavailable",
            502,
            "The HTML representation is unavailable.",
            {},
            { retryable: true },
        ) as ChannelProducerResult;
        const written = await ctx.entries.write(request.pathname, {
            channels: {
                body: { content: "readable body", mimetype: "text/plain" },
                html: {
                    content: "",
                    mimetype: "text/html",
                    state: "errored",
                    producerResult: htmlFailure,
                },
            },
        });
        assert.ok(written.status === 200 || written.status === 201);
        return { status: 200 };
    }
}

const parseRead = (dsl: string): ReadStatement => {
    const item = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "READ",
    );
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error(`no READ parsed from ${dsl}`);
    }
    return item.statement;
};

const parseFind = (dsl: string): FindStatement => {
    const item = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "FIND",
    );
    if (item?.kind !== "statement" || item.statement.op !== "FIND") {
        throw new Error(`no FIND parsed from ${dsl}`);
    }
    return item.statement;
};

test("{§packet} entry-backed data schemes inherit exact READ projection", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("entry-backed", new EntryBackedScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-read-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "entry-backed",
            pathname: "/document.txt",
            channel: "body",
            content: lines.join("\n"),
            mimetype: "text/plain",
        });

        const result = await engine.dispatch({
            statement: parseRead("````READ (entry-backed:///document.txt)````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.content, lines.join("\n"), "a markerless READ is the first page; 20 lines fit it ({§packet})");
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.startLine, 1);
        assert.deepEqual(result.range, {
            unit: "line",
            total: 20,
            requested: [1, PAGE],
            returned: [1, 20],
        });
    } finally {
        await db.close();
    }
});

test("{§packet} inherited READ uses the scheme's canonical pathname and owner", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("resolved-entry", new ResolvedEntryScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `resolved-read-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "resolved-entry",
            pathname: "/canonical.txt",
            channel: "body",
            content: "canonical session content",
            mimetype: "text/plain",
        });

        const result = await engine.dispatch({
            statement: parseRead("````READ (resolved-entry:///alias_%28v1%29.txt#body) <1,-1>````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.content, "canonical session content");
    } finally {
        await db.close();
    }
});

test("{§packet} preparation capabilities bind to the already-resolved canonical owner", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("owner-bound-preparation", new OwnerBoundPreparationScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `owner-bound-preparation-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseRead("````READ (owner-bound-preparation:///alias.txt) <1,-1>````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.content, "prepared for resolved session");
    } finally {
        await db.close();
    }
});

test("{§scheme-operation-dispatch} scope-blind preparation durably composes producer status with cold and warm core projection", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("archive", new ArchiveScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `prepared-read-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);

        for (const sequence of [1, 2]) {
            const result = await engine.dispatch({
                statement: parseRead("````READ (archive:///aliases/latest) <17,18>````"),
                workspaceId,
                sessionId,
                loopId,
                turnId,
                sequence,
                origin: "model",
            });

            assert.equal(result.status, 203);
            assert.equal(result.content, "prepared 17\nprepared 18");
            assert.equal(result.producer, "archive-specimen");
            assert.deepEqual(result.range, {
                unit: "line",
                total: 20,
                requested: [17, 18],
                returned: [17, 18],
            });
        }
    } finally {
        await db.close();
    }
});

test("{§packet} core selects one channel before applying its independent durable producer result", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("independent-channel", new IndependentChannelScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `independent-channel-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const dispatch = (statement: ReadStatement, sequence: number) => engine.dispatch({
            statement,
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence,
            origin: "model" as const,
        });

        const body = await dispatch(
            parseRead("````READ (independent-channel:///item) <1,-1>````"),
            1,
        );
        assert.equal(body.status, 200);
        assert.equal(body.content, "readable body");

        for (const sequence of [2, 3]) {
            const html = await dispatch(
                parseRead("````READ (independent-channel:///item#html) <1,-1>````"),
                sequence,
            );
            assert.equal(html.status, 502);
            assert.equal(html.content, "", "producer evidence composes after the selected text projection");
            assert.equal(html.channel, "html");
            assert.equal(
                html.problem?.type,
                "https://problems.plurnk.xyz/scheme/independent-channel/html-unavailable",
            );
        }
    } finally {
        await db.close();
    }
});

test("{§packet} exact FIND shares representation preparation but retains universal query semantics", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("archive", new ArchiveScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `prepared-find-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("````FIND (archive:///aliases/latest)````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 203);
        assert.equal(result.producer, "archive-specimen");
        assert.equal(result.matchingPathCount, 1);
        const [channels] = result.results as Array<Array<{
            path: string;
            mimetype: string;
            weight: number;
            lines: number;
        }>>;
        assert.deepEqual(channels?.map(({ path }) => path), [
            "archive:///objects/document.txt",
            "archive:///objects/document.txt#provenance",
        ]);
        assert.equal(channels?.[0]?.mimetype, "text/markdown");
        assert.equal(channels?.[0]?.lines, 20);
        assert.ok((channels?.[0]?.weight ?? 0) > 0);
    } finally {
        await db.close();
    }
});

test("{§packet} COPY resolves and prepares the canonical source representation before selection", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("archive", new ArchiveScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `prepared-copy-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: copyStmt(
                urlPath("archive", "/aliases/latest"),
                urlPath("archive", "/imported.txt"),
            ),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 201, JSON.stringify(result));
        const copied = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/imported.txt",
            scheme: "archive",
            name: "body",
        });
        assert.equal(
            copied?.content,
            Array.from({ length: 20 }, (_, index) => `prepared ${index + 1}`).join("\n"),
            "unscoped COPY selects the complete prepared source, not READ's preview",
        );
    } finally {
        await db.close();
    }
});

test("{§packet} COPY refuses a selected channel whose canonical producer outcome failed", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("independent-channel", new IndependentChannelScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `failed-copy-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: copyStmt(
                urlPath("independent-channel", "/item", "html"),
                urlPath("independent-channel", "/copied.html", "html"),
            ),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 502);
        assert.equal(
            result.problem?.type,
            "https://problems.plurnk.xyz/scheme/independent-channel/html-unavailable",
        );
        const copied = await db.test_get_channel_by_pathname_scheme.get({
            pathname: "/copied.html",
            scheme: "independent-channel",
            name: "html",
        });
        assert.equal(copied, undefined);
    } finally {
        await db.close();
    }
});

test("{§packet} public schemes cannot replace canonical COPY storage with incidental CRUD methods", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("public-crud-trap", new PublicCrudTrapScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `public-crud-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "public-crud-trap",
            pathname: "/source.txt",
            channel: "body",
            content: "canonical source",
            mimetype: "text/plain",
        });

        const result = await engine.dispatch({
            statement: copyStmt(
                urlPath("public-crud-trap", "/source.txt"),
                urlPath("public-crud-trap", "/destination"),
            ),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 201, JSON.stringify(result));
        const copied = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/destination",
            scheme: "public-crud-trap",
            name: "body",
        });
        assert.equal(copied?.content, "canonical source");
    } finally {
        await db.close();
    }
});

test("{§packet} cold finite HTTP READ acquires before applying the exact text scope", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("https", new Http());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const originalFetch = globalThis.fetch;
    const lines = Array.from({ length: 20 }, (_, index) => `remote ${index + 1}`);
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        const requested = requestUrl(input);
        if (requested.endsWith("/llms.txt")) return new Response(null, { status: 404 });
        requests.push(requested);
        return new Response(lines.join("\n"), {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    });
    try {
        const workspaceId = await insertWorkspace(db, `http-read-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: parseRead("````READ (https://93.184.216.34/document.txt) <17,18>````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.content, "remote 17\nremote 18");
        assert.deepEqual(result.range, {
            unit: "line",
            total: 20,
            requested: [17, 18],
            returned: [17, 18],
        });
        assert.deepEqual(requests, ["https://93.184.216.34/document.txt"]);
        const subscriptions = await db.test_count_subscriptions_for_session.get<{ n: number }>({ session_id: sessionId });
        assert.equal(subscriptions?.n, 0, "a finite representation never opens a subscription");
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});
});

describe("extensibility-examples", () => {
const fences = (markdown: string): Array<{ info: string; body: string }> =>
    [...markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```$/gmu)].map(([, info, body]) => ({ info: info.trim(), body: body }));

const chapter = async (): Promise<Array<{ info: string; body: string }>> =>
    fences(await readFile(Paths.teachingSource(TEACHING_CORPUS.skillChapters.extensibility), "utf8"));

const page = async (packageName: string, name: string): Promise<string> =>
    readFile(join(dirname(createRequire(import.meta.url).resolve(`${packageName}/package.json`)), "docs", name), "utf8");

const withTrust = async (value: string, run: () => Promise<void>): Promise<void> => {
    const prior = process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
    process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = value;
    try { await run(); } finally {
        if (prior === undefined) delete process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
        else process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = prior;
    }
};

test("{§tools-resource-materialization} the chapter shows a plugin, a scheme extension and a module, in that order", async () => {
    assert.deepEqual((await chapter()).map(({ info }) => info), ["text", "json", "json", "json", "json", "js"]);
});

test("{§tools-resource-materialization} the plugin example is a valid Agent Plugin whose layout carries its skill and MCP server", async (t) => {
    const [layout, manifest, mcp] = await chapter();
    const validated = validateManifest(JSON.parse(manifest.body));
    assert.ok("manifest" in validated, "the manifest is accepted");
    assert.deepEqual(validated.ignored, [], "no field of the example is ignored");
    const files = layout.body.split("\n").map((line) => /[├└]── (\S+)$/u.exec(line)?.[1]).filter((file) => file !== undefined);
    assert.deepEqual(files, ["plugin.json", "mcp.json", "skills/notes-format/SKILL.md"]);

    const roots = await mkdtemp(join(tmpdir(), "plurnk-extensibility-plugin-"));
    t.after(() => rm(roots, { recursive: true, force: true }));
    const bundle = join(roots, "acme-tools");
    await mkdir(join(bundle, "skills", "notes-format"), { recursive: true });
    await writeFile(join(bundle, "plugin.json"), manifest.body);
    await writeFile(join(bundle, "mcp.json"), mcp.body);
    await writeFile(join(bundle, "skills", "notes-format", "SKILL.md"), "---\nname: notes-format\ndescription: Format notes as a Markdown list.\n---\n\nWrite each note as one list item.\n");
    const { plugins, reports } = await PluginRoots.discover([{ scope: "plurnk", directory: roots }]);
    assert.deepEqual(reports, [], "nothing in the bundle is refused or ignored");
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].manifest.name, "acme-tools");
    assert.deepEqual(plugins[0].skills.map(({ document }) => document.name), ["notes-format"]);
    assert.deepEqual([...plugins[0].mcpServers?.keys() ?? []], ["files"]);
});

test("{§tools-resource-materialization} the scheme example's package is discovered as the scheme it declares", async (t) => {
    const [, , , scheme] = await chapter();
    const declaration = JSON.parse(scheme.body) as { name: string };
    const root = await mkdtemp(join(tmpdir(), "plurnk-extensibility-scheme-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "node_modules", declaration.name);
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), scheme.body);
    await writeFile(join(dir, "dist", "index.js"), "export default class Notes {}\n");
    await withTrust(declaration.name, async () => {
        const { schemes, skipped } = await SchemeDiscovery.discover({ packageDirs: [dir] });
        assert.deepEqual(skipped, [], "a package the operator lists is trusted");
        assert.deepEqual(schemes.map(({ name, packageName }) => ({ name, packageName })), [{ name: "notes", packageName: declaration.name }]);
    });
});

test("{§tools-resource-materialization} the module example loads from its export subpath as one daemon module", async (t) => {
    const [, , , , modulePackage, moduleSource] = await chapter();
    const declaration = JSON.parse(modulePackage.body) as { name: string };
    const root = await mkdtemp(join(tmpdir(), "plurnk-extensibility-module-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "node_modules", declaration.name);
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), modulePackage.body);
    await writeFile(join(dir, "dist", "module.js"), moduleSource.body);
    await withTrust(declaration.name, async () => {
        const discovered = await discoverDaemonModules({
            hostPaths: new HostPaths({ env: {}, home: join(root, "home") }),
            packageDirs: [{ dir, name: declaration.name }],
        });
        assert.deepEqual(discovered.skipped, []);
        assert.deepEqual(discovered.configurationErrors, []);
        assert.deepEqual(discovered.modules.map(({ owner }) => owner), [declaration.name]);
        const [{ module }] = discovered.modules;
        assert.equal(typeof module.setup, "function");
        assert.equal(typeof module.stop, "function");
    });
});

test("{§tools-resource-materialization} the definition pages' add examples conform to their families' definition schemas", async () => {
    for (const [packageName, docName, fence, schema] of [
        ["@plurnk/plurnk-mcp", "mcp.md", "plurnk_mcp (add)", "https://schemas.plurnk.xyz/v0/McpServerDefinition.json"],
    ] as const) {
        const examples = fences(await page(packageName, docName)).filter(({ info }) => info === fence);
        assert.ok(examples.length > 0, `${docName} shows an add example`);
        for (const { body } of examples) {
            const { alias, ...definition } = JSON.parse(body) as { alias: string } & Record<string, unknown>;
            assert.equal(typeof alias, "string");
            assert.ok(alias.length > 0);
            const validation = Validator.validateJsonSchemaInstance({ $ref: schema }, { type: "url" in definition ? "streamable-http" : "stdio", ...definition });
            assert.equal(validation.valid, true, `${docName}: ${body} — ${JSON.stringify(validation.errors)}`);
        }
    }
});
});


describe("scheme-education", () => {
test("{§manifest} {§tools-resource-materialization}: stored packets carry language and policy without an injected resource catalogue", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `scheme-edu-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const registry = new SchemeRegistry();
        registry.register("glyph-test", {
            manifest: {
                name: "glyph-test",
                channels: { body: "text/plain" },
                defaultChannel: "body",
                category: "data",
                writableBy: ["model"],
                volatile: false,
                modelVisible: true,
                glyph: "GLYPH_MUST_STAY_CLIENT_SIDE",
                documentation: "# Glyph test\n\n## Summary\n\nDiscover glyph-test resources.\n\n````READ (glyph-test:///example)````",
            },
        });
        const engine = new Engine({ db, schemes: registry });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt()] } }] });

        const { turnId } = await engine.runTurn({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "system", content: "PLURNK_MD" }, { role: "user", content: "go" }],
        });

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);
        const definition = packetSection(packet, "definition");
        assert.match(definition, /PLURNK_MD/, "definition carries the operator's plurnk.md");
        const system = packet.sections.filter((section: { slot: string }) => section.slot === "system");
        assert.deepEqual(system.map((section: { name: string }) => section.name), ["definition", "system-policy"]);
        assert.doesNotMatch(JSON.stringify(system), /glyph-test|GLYPH_MUST_STAY_CLIENT_SIDE/, "neither references nor client glyphs are injected");
        const reference = (await engine.referenceEntries(workspaceId))
            .find(({ scheme, pathname }) => scheme === "plurnk" && pathname === "/glyph-test.md");
        assert.match(reference?.content ?? "", /````READ \(glyph-test:\/\/\/example\)/, "the example remains available in its pull reference without a separate manifest example");
    } finally {
        await db.close();
    }
});
});

describe("scheme-metadata", () => {
const read = (source: string): ReadStatement => {
    const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
    assert.equal(parsed.unparsedTail, undefined);
    assert.deepEqual(parsed.items.filter(({ kind }) => kind === "error"), []);
    const item = parsed.items.find(({ kind }) => kind === "statement");
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error("fixture did not produce one READ statement");
    }
    return item.statement;
};

const manifest = (name: string, metadataModifier = false) => ({
    name,
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data" as const,
    writableBy: ["model" as const],
    volatile: false,
    modelVisible: true,
    ...(metadataModifier ? { metadataModifier: true } : {}),
});

for (const op of ["FIND", "READ", "EDIT", "KILL"] as const) {
    for (const pattern of ["needle", "absent"]) {
        test(`{§parse-recovery}: ${op} with owner metadata applies /${pattern}/ without widening selection`, async () => {
            const db = await openMigrated();
            const env = await seedEnvelope(db, `metadata-pattern-${crypto.randomUUID()}`);
            const schemes = new SchemeRegistry();
            const observed: unknown[] = [];
            schemes.register("opaque", {
                manifest: { ...manifest("opaque", true), textEditScopes: true },
                async prepareRepresentation(request) {
                    observed.push(request.metadata);
                    return { status: 200 };
                },
                async find(statement, ctx) {
                    observed.push(statement.metadata);
                    return ctx.entries.operations.find(statement);
                },
                async editBatch(statements, ctx) {
                    observed.push(...statements.map(({ metadata }) => metadata));
                    return ctx.entries.operations.editBatch(statements);
                },
            } satisfies SchemeHandler);
            const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
            const original = "keep first\nneedle one\nkeep last\nneedle two";
            try {
                await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme: "opaque", pathname: "/notes", content: original });
                const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(
                    `${op} (opaque:///notes) [{"accept":"text/plain"}] /${pattern}/`,
                    op === "EDIT" ? "replacement" : null,
                ));
                assert.equal(parsed.items.length, 1);
                const item = parsed.items[0];
                assert.ok(item?.kind === "statement" && item.statement.op === op);
                const result = await engine.dispatch({ statement: item.statement, ...env, sequence: 1, origin: "model" });
                assert.equal(result.status, pattern === "absent" ? 204 : 200, JSON.stringify(result));
                if (op === "READ") assert.equal(result.content, pattern === "absent" ? "" : "needle one\nneedle two");
                if (op === "FIND") assert.equal(result.matchLocationCount, pattern === "absent" ? 0 : 2);
                const expected = pattern === "absent" || op === "FIND" || op === "READ" ? original
                    : op === "EDIT" ? "keep first\nreplacement one\nkeep last\nreplacement two"
                        : "keep first\n one\nkeep last\n two";
                const stored = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                    scheme: "opaque", pathname: "/notes", name: "body",
                });
                assert.equal(stored?.content, expected, "unmatched content survives the real operation");
                assert.ok(observed.length > 0, "the owning scheme participates");
                for (const metadata of observed) assert.deepEqual(metadata, ['{"accept":"text/plain"}'], "the owner receives its authored options");
            } finally {
                await schemes.close();
                await db.close();
            }
        });
    }
}

test("{§operation-results} scheme metadata remains outside the target and reaches only an opted-in scheme", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `scheme-metadata-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    let supportedMetadata: readonly string[] | null = null;
    let routedAliasMetadata: readonly string[] | null = null;
    let unsupportedInvoked = false;

    schemes.register("opaque", {
        manifest: manifest("opaque", true),
        async prepareRepresentation(request, ctx) {
            supportedMetadata = request.metadata;
            const written = await ctx.entries.write(request.pathname, {
                channels: { body: { content: "ready", mimetype: "text/plain" } },
            });
            assert.ok(written.status === 200 || written.status === 201);
            return { status: 200 } as const;
        },
    } satisfies SchemeHandler);
    schemes.register("plain", {
        manifest: manifest("plain"),
        async prepareRepresentation() {
            unsupportedInvoked = true;
            return { status: 200 } as const;
        },
    } satisfies SchemeHandler);
    schemes.register("https", {
        manifest: { ...manifest("https", true), authority: "resource" },
        async prepareRepresentation(request, ctx) {
            routedAliasMetadata = request.metadata;
            const written = await ctx.entries.write(request.pathname, {
                channels: { body: { content: "routed", mimetype: "text/plain" } },
            });
            assert.ok(written.status === 200 || written.status === 201);
            return { status: 200 } as const;
        },
    } satisfies SchemeHandler);
    const engine = new Engine({ db, schemes });

    try {
        const supported = read(
            "````READ (opaque:///record) [{\"first\": {\"nested\": true}}] [{\"second\": \"duplicate\"}]````",
        );
        assert.equal(supported.target?.raw, "opaque:///record");
        assert.deepEqual(supported.metadata, ['{"first": {"nested": true}}', '{"second": "duplicate"}']);
        const accepted = await engine.dispatch({
            statement: supported,
            ...env,
            sequence: 1,
            origin: "model",
        });
        assert.equal(accepted.status, 200);
        assert.deepEqual(supportedMetadata, ['{"first": {"nested": true}}', '{"second": "duplicate"}']);

        const routedAlias = await engine.dispatch({
            statement: read("````READ (http://example.test/record) [{\"Accept\": \"text/plain\"}]````"),
            ...env,
            sequence: 2,
            origin: "model",
        });
        assert.equal(routedAlias.status, 200);
        assert.deepEqual(routedAliasMetadata, ['{"Accept": "text/plain"}']);

        const rejected = await engine.dispatch({
            statement: read("````READ (plain:///record) [{\"anything\": \"the scheme might define\"}]````"),
            ...env,
            sequence: 3,
            origin: "model",
        });
        assert.equal(rejected.status, 400);
        assert.equal(
            rejected.problem?.type,
            "https://problems.plurnk.xyz/engine/dispatcher/scheme-metadata-unsupported",
        );
        assert.equal(rejected.problem?.detail, "READ on 'plain' does not accept the [metadata] modifier."); // {§operation-results}
        assert.equal(unsupportedInvoked, false);
    } finally {
        await schemes.close();
        await db.close();
    }
});

for (const [op, proposed] of [["COPY", "neither"], ["MOVE", "neither"], ["MOVE", "source"], ["MOVE", "both"]] as const) {
    test(`{§op-shapes}: parsed ${op} keeps scope and metadata with each resource (${proposed} proposed)`, async (t) => {
        serverProposals(t, "accept");
        const db = await openMigrated();
        const env = await seedEnvelope(db, `transfer-metadata-${crypto.randomUUID()}`);
        const schemes = new SchemeRegistry();
        const reads: unknown[] = [];
        const writes: unknown[] = [];
        const applications: unknown[] = [];
        const pending = new Map<string, readonly ResolvedEditStatement[]>();
        schemes.register("opaque", {
            manifest: { ...manifest("opaque", true), textEditScopes: true },
            async prepareRepresentation(request) {
                reads.push({ path: request.pathname, metadata: request.metadata });
                return { status: 200 };
            },
            async editBatch(statements, ctx) {
                writes.push(...statements.map(({ target, metadata }) => ({ path: target?.raw, metadata })));
                const path = statements[0]?.target?.raw;
                assert.ok(path);
                if (proposed === "both" || (proposed === "source" && path === "opaque:///source")) {
                    pending.set(path, statements);
                    return { status: 202, attrs: { path } };
                }
                return ctx.entries.operations.editBatch(statements);
            },
            async applyResolution(request, ctx) {
                const path = (request.attrs as { path: string }).path;
                const statements = pending.get(path);
                assert.ok(statements);
                applications.push({ path, metadata: request.metadata });
                return ctx.entries.operations.editBatch(statements);
            },
        } satisfies SchemeHandler);
        const engine = new Engine({ db, schemes });
        try {
            for (const [pathname, content] of [["/source", "first\nselected\nlast"], ["/destination", "before\nreplace\nafter"]]) {
                await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme: "opaque", pathname, content });
            }
            const parsed = PlurnkParser.parseStatements(
                `\`\`\`\`${op} (opaque:///source) <2> [{"source": "true"}] (opaque:///destination) <2> [{"destination": "true"}]\`\`\`\``,
            );
            assert.equal(parsed.unparsedTail, undefined);
            assert.equal(parsed.items.length, 1);
            const item = parsed.items[0];
            assert.ok(item?.kind === "statement" && item.statement.op === op);
            const result = await engine.dispatch({ statement: item.statement, ...env, sequence: 1, origin: "model" });
            assert.equal(result.status, 200);
            assert.deepEqual(reads, [{ path: "/source", metadata: ['{"source": "true"}'] }]);
            assert.deepEqual(writes, [
                { path: "opaque:///destination", metadata: ['{"destination": "true"}'] },
                ...(op === "MOVE" ? [{ path: "opaque:///source", metadata: ['{"source": "true"}'] }] : []),
            ]);
            assert.deepEqual(applications, proposed === "neither" ? [] : [
                ...(proposed === "both" ? [{ path: "opaque:///destination", metadata: ['{"destination": "true"}'] }] : []),
                { path: "opaque:///source", metadata: ['{"source": "true"}'] },
            ]);
            for (const [pathname, expected] of [
                ["/source", op === "COPY" ? "first\nselected\nlast" : "first\nlast"],
                ["/destination", "before\nselected\nafter"],
            ]) {
                const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                    scheme: "opaque", pathname, name: "body",
                });
                assert.equal(channel?.content, expected);
            }
        } finally {
            await schemes.close();
            await db.close();
        }
    });
}
});

