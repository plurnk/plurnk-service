import fs from "node:fs/promises";
import { detect } from "./detect.ts";
import { discover } from "./discover.ts";
import { parseBodyMatcher, type ParsedBodyMatcher } from "./parseBodyMatcher.ts";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { isGrammarNotInstalled } from "./TreeSitterExtractor.ts";
import BaseHandler from "./BaseHandler.ts";
import Embeddings, { type EmbedBatchOptions, type EmbedderInfo } from "./Embeddings.ts";
import { mimetypeSource, type TelemetryEvent } from "./TelemetryEvent.ts";
import type {
    DetectInput,
    DiscoverOptions,
    Discovery,
    HandlerMetadata,
    MimeRef,
    MimeSymbol,
    QueryMatch,
} from "./types.ts";

// The channels process() can materialize (issues #17, #24). Each is
// computed iff requested; unrequested channels pay no work and are absent
// from the result. Default is the four STRUCTURAL channels — process() is
// the universal projection surface (#11); callers that want less say less.
// "embedding" is NEVER in the default set: it is a model inference (orders
// of magnitude costlier than parsing) and must be requested explicitly.
export type Channel = "symbols" | "deepJson" | "deepXml" | "references" | "content" | "embedding";

const DEFAULT_CHANNELS: readonly Channel[] = ["symbols", "deepJson", "deepXml", "references", "content"];

// The embedder seam (issues #24/#31/#36) lives in Embeddings.ts; its public
// types are re-exported here so the module's API surface is unchanged.
export type { EmbedderInfo, EmbedProgress, EmbedBatchOptions } from "./Embeddings.ts";

// Loader hook: how to resolve a handler package to its default-exported class.
// Production uses dynamic import(); tests inject a custom loader to avoid
// touching the module system.
export type HandlerLoader = (packageName: string) => Promise<unknown>;

const defaultLoader: HandlerLoader = (packageName) => import(packageName);

export interface MimetypesOptions {
    discoverOptions?: DiscoverOptions;
    // Pre-built discovery — bypasses the filesystem scan. Useful for tests and
    // for consumers that build their registry programmatically.
    discovery?: Discovery;
    loader?: HandlerLoader;
    // Mimetype to substitute when detection finds no match. plurnk-service sets
    // this to "text/markdown" because LLM output is overwhelmingly markdown —
    // null is a worse answer than markdown for almost all model-generated
    // content. Unset → detection returns null when nothing matches (the
    // original behavior, preserved for standalone use).
    defaultMimetype?: string;
}

export interface ProcessInput {
    path?: string;
    // Inline content. `string` for text mimetypes (default); `Uint8Array` for
    // binary mimetypes (handler declared via `plurnk.binary: true`). When path
    // is supplied and content is not, the framework reads the file as whichever
    // shape the resolved handler expects.
    content?: string | Uint8Array;
    ext?: string;
    hint?: string;
}

export interface ProcessOptions {
    // Channels to materialize on this call (issue #17). Default: all.
    // Unrequested channels are not computed and their fields are absent from
    // the result. `[]` is valid — metadata only (mimetype, ok, totalLines,
    // extent), no parse paid.
    channels?: readonly Channel[];
    // When true, missing grammar for a detected mimetype throws
    // GrammarNotInstalledError instead of degrading to a text-plain fallback.
    // Default false — see issue #14: in the a-la-carte world, a missing
    // grammar is the expected normal state for any deployment that installs
    // only the languages it uses, not an error condition. Consumers that
    // genuinely require a specific grammar to be present can opt in.
    strict?: boolean;
}

export interface ProcessResult {
    // ——— Always-on metadata (every call, every channel selection) ———
    mimetype: string | null;
    ok: boolean;
    // Editor-convention line count of the source content (`abc\ndef` → 2;
    // `abc\ndef\n` → 2; "" → 0). Binary content: 0 — lines aren't a
    // meaningful unit; consumers reason about size differently (pages for
    // PDF). 0 on every error path. The one process() output plurnk-service's
    // manifest hard-depends on (its `lines` field).
    totalLines: number;
    // Addressable extent for the model's navigation bounds (issue #9), per
    // plurnk-grammar's `<L>` convention: line count for text, item count for
    // structured entries (text-csv overrides extent() to return rows).
    extent: number;
    // Per issue #14: when the detected mimetype's grammar package isn't
    // installed, process() degrades to a text-plain fallback and surfaces
    // the missing package name here so consumers can show an install hint.
    // Absent on the happy path. Independent of `ok` — degraded results
    // still set ok:true.
    grammarMissing?: string;

    // ——— Channels (issues #17/#24): present iff requested, absent otherwise ———
    // Structured definitions — the graph's symbol_defs raw material and the
    // outline source (render via format() when a human needs to read it).
    symbols?: MimeSymbol[];
    // Full structural tree, jsonpath query target (issue #10). null when the
    // handler has no faithful tree for its algebra.
    deepJson?: unknown;
    // XML projection of the structural tree, xpath query target (issue #10).
    // Handler deepXml() overrides are honored (text-html/application-xml
    // serve real source markup).
    deepXml?: string;
    // Classified symbol uses (issue #16 D4) — the graph's symbol_refs raw
    // material. [] until the per-language extraction engine lands (#19); the
    // field ships now so consumers build against the final shape.
    references?: MimeRef[];
    // Model-facing readable text — the markup-free projection for READ and
    // the embed-source (the content channel). Present only when the readable
    // form differs from the raw body: text/html projects Readability+turndown
    // markdown; directly-readable formats (code/markdown/json) leave it
    // absent (the body IS the content); binary uses toText as its body, not
    // this channel. HTML-only for now.
    content?: string;
    // Embedding vector (issue #24): native-endian raw Float32 bytes,
    // length = 4 × dimension, scalar per entry. plurnk-service stores the
    // bytes verbatim as a sqlite BLOB and cosine-ranks over a Float32Array
    // view. Empty (length 0) when the content has no text projection or the
    // embedder package is missing (see embeddingMissing). NEVER materialized
    // unless explicitly requested.
    embedding?: Uint8Array;
    // Set when the embedding channel was requested but the opt-in
    // @plurnk/plurnk-mimetypes-embeddings package isn't installed — the
    // install hint, mirroring grammarMissing (#14). strict: true throws
    // instead.
    embeddingMissing?: string;
    // Model identity for the vector above, when the embedder declares one.
    // Store it next to the BLOB: vectors from different models are silently
    // incomparable, and this is the staleness detector.
    embeddingModel?: string;
    // The framework's contribution to plurnk-service's telemetry stream for
    // this call (plurnk-service#276). Carries non-fatal conditions whose
    // severity is HIDDEN by ok:true — a degraded result still reports success,
    // so grammarMissing/embeddingMissing surface here as `warn` events the host
    // forwards into `packet.user.telemetry.events[]`. Absent on the happy path.
    // Hard failures (ok:false) need no entry: the status is the severity.
    telemetry?: readonly TelemetryEvent[];
}

// Top-level orchestrator. Plurnk-service constructs one of these at boot,
// injecting its tokenize function. process(path) is the primary entry point;
// detect() and getHandler() are exposed for callers that want to drive the
// pipeline manually.
export default class Mimetypes {
    readonly #discoverOptions: DiscoverOptions;
    readonly #loader: HandlerLoader;
    readonly #defaultMimetype: string | null;
    readonly #handlerInstances = new Map<string, BaseHandler>();
    readonly #embeddings: Embeddings;
    #discovery: Discovery | null = null;
    #readyPromise: Promise<void> | null = null;

    constructor(options: MimetypesOptions = {}) {
        this.#discoverOptions = options.discoverOptions ?? {};
        this.#loader = options.loader ?? defaultLoader;
        this.#defaultMimetype = options.defaultMimetype ?? null;
        this.#embeddings = new Embeddings(this.#loader);
        if (options.discovery !== undefined) this.#discovery = options.discovery;
    }

    // Eagerly run discovery. Safe to call multiple times — subsequent calls
    // share the same in-flight promise. Optional: every public method that
    // needs discovery awaits this internally.
    async ready(): Promise<void> {
        if (this.#discovery !== null) return;
        if (this.#readyPromise !== null) return this.#readyPromise;
        this.#readyPromise = (async () => {
            this.#discovery = await discover(this.#discoverOptions);
        })();
        return this.#readyPromise;
    }

    async detect(input: DetectInput): Promise<string | null> {
        await this.ready();
        const result = detect(input, this.#discovery!.registry);
        return result ?? this.#defaultMimetype;
    }

    async getHandler(mimetype: string): Promise<BaseHandler | null> {
        await this.ready();

        const cached = this.#handlerInstances.get(mimetype);
        if (cached !== undefined) return cached;

        const info = this.#discovery!.handlers.get(mimetype);
        if (info === undefined) return null;

        const metadata: HandlerMetadata = {
            mimetype: info.mimetype,
            glyph: info.glyph,
            extensions: info.extensions,
        };

        let handler: BaseHandler | null;
        if (info.source === "treesitter") {
            handler = await this.#instantiateTreeSitterHandler(metadata, info.mimetype);
        } else {
            handler = await this.#instantiatePackageHandler(metadata, info.packageName);
        }
        if (handler === null) return null;

        this.#handlerInstances.set(mimetype, handler);
        return handler;
    }

    async #instantiatePackageHandler(
        metadata: HandlerMetadata,
        packageName: string,
    ): Promise<BaseHandler | null> {
        let mod: unknown;
        try {
            mod = await this.#loader(packageName);
        } catch {
            return null;
        }
        if (typeof mod !== "object" || mod === null) return null;
        const HandlerClass = (mod as { default?: unknown }).default;
        if (typeof HandlerClass !== "function") return null;
        const Ctor = HandlerClass as new (m: HandlerMetadata) => BaseHandler;
        return new Ctor(metadata);
    }

    async #instantiateTreeSitterHandler(
        metadata: HandlerMetadata,
        mimetype: string,
    ): Promise<BaseHandler | null> {
        const { lookupTreeSitterLanguage } = await import("./treesitter/registry.ts");
        const entry = lookupTreeSitterLanguage(mimetype);
        if (entry === null) return null;
        const { default: TreeSitterLanguageHandler } = await import("./treesitter/handler.ts");
        return new TreeSitterLanguageHandler(metadata, entry);
    }

    // The pipeline. Detection → content read → handler resolve → validate →
    // requested channels (issue #17). The handler is the sole authority on
    // each channel's material; the framework owns selection, routing, and
    // the default deep-xml projection.
    //
    // Error routing:
    //   * detection fails → ok:false, metadata only
    //   * content read fails → ok:false, metadata only
    //   * handler missing → ok:false, metadata only
    //   * validate throws → propagates (caller's contract; bug in content or handler)
    //   * grammar missing → degrades to text-plain metadata + empty channels
    //     with grammarMissing set (#14), unless options.strict
    async process(input: ProcessInput, options: ProcessOptions = {}): Promise<ProcessResult> {
        const channels = new Set<Channel>(options.channels ?? DEFAULT_CHANNELS);
        const mimetype = await this.detect(input);

        if (mimetype === null) {
            return errorResult(null);
        }

        // Look up the handler's binary flag before reading content, so we read
        // the file as Uint8Array vs utf-8 string per the handler's expectation.
        const info = this.#discovery!.handlers.get(mimetype) ?? null;
        const isBinary = info?.binary ?? false;

        const content = await this.#resolveContent(input, isBinary);
        if (content === null) {
            return errorResult(mimetype);
        }

        const handler = await this.getHandler(mimetype);
        if (handler === null) {
            return errorResult(mimetype);
        }

        // Validate errors propagate per error policy — caller's contract.
        // Await in case the handler returns a Promise (async validators).
        await handler.validate(content);

        // Materialize exactly the requested channels, in parallel. The
        // default deep-xml projection needs the deep-json value, so deepJson
        // is computed (but not exposed) when deepXml alone is requested and
        // the handler hasn't overridden deepXml().
        //
        // GrammarNotInstalledError routes to the degradation path per issue
        // #14 unless options.strict is set. Anything else propagates.
        // Pre-0.15 handler packages bundle an old framework copy whose
        // BaseHandler lacks the newer channel methods. A handler that can't
        // serve a requested channel is a contract violation — crash with the
        // cause and the fix, not "undefined is not a function" (#21).
        for (const method of ["deepXml", "references"] as const) {
            if (channels.has(method === "deepXml" ? "deepXml" : "references")
                && typeof handler[method] !== "function") {
                throw new TypeError(
                    `Handler for ${mimetype} does not implement ${method}() — its `
                    + `@plurnk/plurnk-mimetypes-* package predates the 0.15 duck `
                    + `contract. Update the handler package to a 0.15-compatible `
                    + `release (the floor handlers shipped 0.15 patches).`,
                );
            }
        }
        const needsDeepJson = channels.has("deepJson")
            || (channels.has("deepXml") && handler.deepXml === BaseHandler.prototype.deepXml);
        let symbols: MimeSymbol[] | undefined;
        let deepJsonValue: unknown;
        let references: MimeRef[] | undefined;
        let contentValue: string | undefined;
        let extentValue: number;
        let deepXml: string | undefined;
        try {
            [symbols, deepJsonValue, references, contentValue, extentValue] = await Promise.all([
                channels.has("symbols") ? handler.extractRaw(content) : undefined,
                needsDeepJson ? handler.deepJson(content) : undefined,
                channels.has("references") ? handler.references(content) : undefined,
                channels.has("content") ? handler.content(content) : undefined,
                handler.extent(content),
            ]);
            if (channels.has("deepXml")) {
                deepXml = handler.deepXml === BaseHandler.prototype.deepXml
                    ? (deepJsonValue === null || deepJsonValue === undefined
                        ? ""
                        : projectJsonToXml(deepJsonValue))
                    : await handler.deepXml(content);
            }
        } catch (err) {
            if (isGrammarNotInstalled(err) && !options.strict) {
                return this.#degradedResult(
                    mimetype,
                    content,
                    channels,
                    (err as { plurnkPackage?: string }).plurnkPackage ?? "",
                );
            }
            throw err;
        }
        const totalLines = typeof content === "string" ? countLines(content) : 0;
        const embeddingPart = channels.has("embedding")
            ? await this.#embeddings.embedFor(content, handler, options.strict === true)
            : {};

        return attachTelemetry({
            mimetype,
            ok: true,
            totalLines,
            extent: extentValue,
            ...(channels.has("symbols") && { symbols }),
            ...(channels.has("deepJson") && { deepJson: deepJsonValue }),
            ...(channels.has("deepXml") && { deepXml }),
            ...(channels.has("references") && { references }),
            ...(channels.has("content") && contentValue !== undefined && { content: contentValue }),
            ...embeddingPart,
        });
    }

    // Pure model facts for plurnk-service's lossless chunker (embeddings#1).
    // Delegates to the embedder seam (Embeddings.ts).
    async embedderInfo(): Promise<EmbedderInfo | null> {
        return this.#embeddings.info();
    }

    // Bulk embedding entry for the host's corpus ingest (plurnk-service#272).
    // Delegates to the embedder seam (Embeddings.ts).
    async embedBatch(texts: readonly string[], options?: EmbedBatchOptions): Promise<Uint8Array[]> {
        return this.#embeddings.batch(texts, options);
    }

    // Release native resources so a consumer can drain its event loop and exit
    // (issue #36). Tears down the embedder seam's onnxruntime worker pool (which
    // holds active+referenced libuv handles that otherwise keep the process
    // alive), then drops the cached handler instances. Idempotent — channels
    // re-lazy-init if the instance is used again. A consumer creating Mimetypes
    // instances per unit of work should `await m.dispose()` when done.
    async dispose(): Promise<void> {
        await this.#embeddings.dispose();
        this.#handlerInstances.clear();
    }

    // Body-matcher query entry point. Accepts the matcher in EITHER form (#42):
    //
    //   * a raw matcher string (e.g. "$.users[0].name", "//user", "/error.*/g",
    //     "*.log") — we classify the dialect by leading prefix via
    //     parseBodyMatcher; or
    //   * an already-parsed `{ dialect, pattern, flags? }` — the shape
    //     `@plurnk/plurnk-grammar` produces for the model-facing matcher syntax.
    //
    // The grammar owns that syntax, so when the caller already holds the parsed
    // body it passes the object and the framework dispatches it verbatim — no
    // second parser, no re-derivation, no drift between the grammar's
    // classification and ours (#42). Both forms converge on the same per-dialect
    // dispatch, so `m.lines` (#41) comes back uniformly for regex/glob/jsonpath/
    // xpath either way.
    //
    // Errors:
    //   * detection fails → throws ReferenceError (no handler to query)
    //   * content read fails → throws (caller must know to retry/handle)
    //   * handler missing → throws ReferenceError
    //   * dialect unsupported for this mimetype → UnsupportedDialectError → 415
    //   * malformed expression → InvalidExpressionError → 400
    //   * content can't be parsed for dialect → QueryParseFailureError → 422
    //   * zero matches → returns [] (consumer maps to 204)
    async query(input: ProcessInput, matcher: string | ParsedBodyMatcher): Promise<QueryMatch[]> {
        const mimetype = await this.detect(input);
        if (mimetype === null) {
            throw new ReferenceError("Mimetypes.query: no mimetype could be resolved for input");
        }

        const info = this.#discovery!.handlers.get(mimetype) ?? null;
        const isBinary = info?.binary ?? false;

        const content = await this.#resolveContent(input, isBinary);
        if (content === null) {
            throw new ReferenceError(`Mimetypes.query: content unreadable for ${mimetype}`);
        }

        const handler = await this.getHandler(mimetype);
        if (handler === null) {
            throw new ReferenceError(`Mimetypes.query: no handler discovered for ${mimetype}`);
        }

        // String → classify by leading prefix; parsed body → dispatch verbatim.
        const parsed = typeof matcher === "string" ? parseBodyMatcher(matcher) : matcher;
        return handler.query(content, parsed.dialect, parsed.pattern, parsed.flags);
    }

    // Build a degraded ProcessResult when the detected mimetype's grammar
    // isn't installed (issue #14). The consumer still gets honest metadata
    // (line count, extent) plus empty channels for whatever it requested, and
    // grammarMissing as a structured install hint. ok stays true — in the
    // a-la-carte world a missing grammar is a normal state, not an error.
    async #degradedResult(
        mimetype: string,
        content: string | Uint8Array,
        channels: ReadonlySet<Channel>,
        plurnkPackage: string,
    ): Promise<ProcessResult> {
        const totalLines = typeof content === "string" ? countLines(content) : 0;
        // The embedding channel does not need the grammar — a degraded entry
        // is still semantically searchable text (non-strict: a missing
        // embedder stacks its own hint alongside grammarMissing).
        const embeddingPart = channels.has("embedding")
            ? await this.#embeddings.embedFor(content, null, false)
            : {};
        return attachTelemetry({
            mimetype,
            ok: true,
            totalLines,
            extent: totalLines,
            grammarMissing: plurnkPackage,
            ...(channels.has("symbols") && { symbols: [] }),
            ...(channels.has("deepJson") && { deepJson: null }),
            ...(channels.has("deepXml") && { deepXml: "" }),
            ...(channels.has("references") && { references: [] }),
            ...embeddingPart,
        });
    }

    async #resolveContent(input: ProcessInput, binary: boolean): Promise<string | Uint8Array | null> {
        if (input.content !== undefined) return input.content;
        if (input.path === undefined || input.path === "") return null;
        try {
            return binary
                ? new Uint8Array(await fs.readFile(input.path))
                : await fs.readFile(input.path, "utf-8");
        } catch {
            return null;
        }
    }
}

// Error-path result. Metadata only — channel fields stay absent, matching
// the "present iff requested AND produced" contract. Centralized so every
// error route returns the same shape.
function errorResult(mimetype: string | null): ProcessResult {
    return {
        mimetype,
        ok: false,
        totalLines: 0,
        extent: 0,
    };
}

// Project a successful result's degradation fields into `warn` telemetry
// (plurnk-service#276). A degraded result reports ok:true, so its severity is
// invisible unless the producer puts it on the wire — we know it's a warning,
// the host shouldn't have to infer it from a bare package string. Derived from
// the result's own fields so the event can never drift from grammarMissing/
// embeddingMissing. Only reached for ok:true results that carry a mimetype.
function attachTelemetry(result: ProcessResult): ProcessResult {
    const events: TelemetryEvent[] = [];
    if (typeof result.grammarMissing === "string") {
        events.push({
            source: mimetypeSource(result.mimetype!),
            kind: "grammar_degraded",
            level: "warn",
            message: `No grammar installed for ${result.mimetype}; degraded to text-plain `
                + `metadata with empty structural channels. Install ${result.grammarMissing} to enable them.`,
            position: null,
            mimetype: result.mimetype,
            plurnkPackage: result.grammarMissing,
        });
    }
    if (typeof result.embeddingMissing === "string") {
        events.push({
            source: mimetypeSource(result.mimetype!),
            kind: "embedding_degraded",
            level: "warn",
            message: `Embedding channel requested but ${result.embeddingMissing} is not installed; `
                + `returned an empty vector. Install it to enable embeddings.`,
            position: null,
            mimetype: result.mimetype,
            plurnkPackage: result.embeddingMissing,
        });
    }
    return events.length === 0 ? result : { ...result, telemetry: events };
}

// Editor-convention line count: `abc\ndef` → 2, `abc\ndef\n` → 2 (trailing
// newline is a line terminator, not a new line), `\n` → 1 (one empty line),
// "" → 0 (no lines). Matches what the model sees in `wc -l`-style output
// and what plurnk-grammar's `<L>` slot addresses.
function countLines(text: string): number {
    if (text.length === 0) return 0;
    let newlines = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 0x0a) newlines += 1;
    }
    // If the content ends with a newline, that final `\n` is a line
    // terminator — the line count equals the newline count. Otherwise, the
    // trailing characters form an unterminated line, so add 1.
    return text.charCodeAt(text.length - 1) === 0x0a ? newlines : newlines + 1;
}
