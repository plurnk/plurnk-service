import fs from "node:fs/promises";
import { detect } from "./detect.ts";
import { discover } from "./discover.ts";
import { parseBodyMatcher, type ParsedBodyMatcher } from "./parseBodyMatcher.ts";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { isGrammarNotInstalled } from "./TreeSitterExtractor.ts";
import BaseHandler from "./BaseHandler.ts";
import Embeddings, { type EmbedBatchOptions, type EmbedderInfo } from "./Embeddings.ts";
import Tokenizers, { type TokenizerResolution } from "./Tokenizers.ts";
import { classifyMimetype, classifyWithHandler, type MimeClassification } from "./classify.ts";
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

// SPEC §5 / §12.1 (#17, #24): channels process() can materialize, computed
// iff requested. "embedding" is opt-in only — never in the default set (§17).
export type Channel = "symbols" | "deepJson" | "deepXml" | "references" | "content" | "embedding";

const DEFAULT_CHANNELS: readonly Channel[] = ["symbols", "deepJson", "deepXml", "references", "content"];

// The embedder seam (issues #24/#31/#36) lives in Embeddings.ts; its public
// types are re-exported here so the module's API surface is unchanged.
export type { EmbedderInfo, EmbedProgress, EmbedBatchOptions } from "./Embeddings.ts";
// The tokenizer seam (SPEC §19, #44) lives in Tokenizers.ts.
export type { TokenizerResolution } from "./Tokenizers.ts";

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
    // Mimetype to substitute when detection finds no match (plurnk-service sets
    // "text/markdown": LLM output is overwhelmingly markdown). Unset → null.
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
    // Channels to materialize on this call (SPEC §5, #17). Default: all.
    // Absent fields = not requested; `[]` = metadata only, no parse paid.
    channels?: readonly Channel[];
    // SPEC §7 / §13.5 (#14): when set, a missing grammar throws
    // GrammarNotInstalledError instead of degrading to text-plain. Default
    // false — in the a-la-carte world a missing grammar is the normal state.
    strict?: boolean;
}

export interface ProcessResult {
    // ——— Always-on metadata (SPEC §7) ———
    mimetype: string | null;
    ok: boolean;
    // Editor-convention line count (SPEC §7); 0 for binary and every error
    // path. plurnk-service's manifest hard-depends on this (`lines`).
    totalLines: number;
    // Addressable extent for navigation bounds (SPEC §12.5, #9): line count
    // for text, item count for structured.
    extent: number;
    // SPEC §7 / §13.5 (#14): missing grammar package name when process()
    // degrades to text-plain. Absent on the happy path; independent of `ok`.
    grammarMissing?: string;

    // ——— Channels (SPEC §12.1, #17/#24): present iff requested ———
    // Structured definitions — symbol_defs raw material; outline source via
    // format() (SPEC §3/§12.1).
    symbols?: MimeSymbol[];
    // Full structural tree, jsonpath target (SPEC §12.2, #10). null when the
    // handler has no faithful tree.
    deepJson?: unknown;
    // XML projection, xpath target (SPEC §12.3, #10). Handler overrides are
    // honored (text-html/application-xml serve real source markup).
    deepXml?: string;
    // Classified symbol uses — symbol_refs raw material (SPEC §16, #16/#19).
    references?: MimeRef[];
    // Model-facing readable text, the embed-source (SPEC §18). Present only
    // when the readable form differs from the raw body (text/html → markdown);
    // HTML-only for now.
    content?: string;
    // Embedding vector (SPEC §17, #24): native-endian raw Float32 bytes,
    // length = 4 × dimension. Empty when no text projection / embedder missing
    // (see embeddingMissing). Never materialized unless requested.
    embedding?: Uint8Array;
    // SPEC §17 (#14/#24): set when embedding requested but the embeddings
    // package is absent — install hint mirroring grammarMissing. strict throws.
    embeddingMissing?: string;
    // Model identity for the vector above (SPEC §17, #31): store next to the
    // BLOB; vectors from different models are incomparable — the staleness
    // detector.
    embeddingModel?: string;
    // Degradation telemetry (SPEC §11.5, plurnk-service#276): warn events for
    // conditions hidden by ok:true — grammarMissing/embeddingMissing surface
    // here for the host to forward into packet.user.telemetry.events[]. Absent
    // on the happy path; hard failures (ok:false) need no entry.
    telemetry?: readonly TelemetryEvent[];
}

// Top-level orchestrator. plurnk-service constructs one at boot. process() is
// the primary entry point; detect() and getHandler() are exposed for callers
// that want to drive the pipeline manually.
export default class Mimetypes {
    readonly #discoverOptions: DiscoverOptions;
    readonly #loader: HandlerLoader;
    readonly #defaultMimetype: string | null;
    readonly #handlerInstances = new Map<string, BaseHandler>();
    readonly #embeddings: Embeddings;
    readonly #tokenizers: Tokenizers;
    #discovery: Discovery | null = null;
    #readyPromise: Promise<void> | null = null;

    constructor(options: MimetypesOptions = {}) {
        this.#discoverOptions = options.discoverOptions ?? {};
        this.#loader = options.loader ?? defaultLoader;
        this.#defaultMimetype = options.defaultMimetype ?? null;
        this.#embeddings = new Embeddings(this.#loader);
        this.#tokenizers = new Tokenizers(this.#loader);
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

    // Per-mimetype classification (SPEC §20, #43) — this family is the filetype
    // authority; consumers retire their hand-maintained allowlists. An INSTALLED
    // handler's declared facts (plurnk.binary, plurnk.navigation) win
    // (source: "handler"); any other mimetype string gets the taxonomy heuristic
    // (source: "heuristic") — consumers classify arbitrary stream labels, not
    // just installed types.
    async classify(mimetype: string): Promise<MimeClassification> {
        await this.ready();
        const info = this.#discovery!.handlers.get(mimetype);
        if (info === undefined) return classifyMimetype(mimetype);
        return classifyWithHandler(mimetype, { binary: info.binary, navigation: info.navigation });
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

    // The pipeline: detect → read content → resolve handler → validate →
    // materialize requested channels (SPEC §5, #17). The handler is the sole
    // authority on each channel's material; the framework owns selection,
    // routing, and the default deep-xml projection. Error routing per SPEC §7
    // (grammar-missing degrades to text-plain unless options.strict; #14).
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

        // Materialize requested channels in parallel. The default deep-xml
        // projection needs deep-json, so deepJson is computed (unexposed) when
        // only deepXml is requested and the handler hasn't overridden deepXml().
        // GrammarNotInstalledError → degradation path (SPEC §7, #14) unless strict.
        //
        // A pre-0.15 handler package's BaseHandler lacks the newer channel
        // methods; a handler that can't serve a requested channel is a contract
        // violation — crash with the cause and the fix, not "undefined is not a
        // function" (#21).
        for (const method of ["deepXml", "references"] as const) {
            if (channels.has(method) && typeof handler[method] !== "function") {
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

    // Pure model facts for the host's lossless chunker (SPEC §17, embeddings#1).
    // Delegates to the embedder seam (Embeddings.ts).
    async embedderInfo(): Promise<EmbedderInfo | null> {
        return this.#embeddings.info();
    }

    // Bulk embedding for the host's corpus ingest (SPEC §17, plurnk-service#272).
    // Delegates to the embedder seam (Embeddings.ts).
    async embedBatch(texts: readonly string[], options?: EmbedBatchOptions): Promise<Uint8Array[]> {
        return this.#embeddings.batch(texts, options);
    }

    // Exact LLM token counting for the host's window math (SPEC §19, #44).
    // Delegates to the tokenizer seam (Tokenizers.ts). The host composes this
    // AFTER the provider's own tokenize() capability — this seam covers the
    // bundled-vocab and honest-degrade links of the chain.
    async tokenizer(modelRef: string, options?: { strict?: boolean }): Promise<TokenizerResolution> {
        return this.#tokenizers.tokenizer(modelRef, options);
    }

    // Release native resources so a consumer can drain its event loop and exit
    // (issue #36). Tears down the embedder seam's onnxruntime worker pool (which
    // holds active+referenced libuv handles that otherwise keep the process
    // alive), then drops the cached handler instances. Idempotent — channels
    // re-lazy-init if the instance is used again. A consumer creating Mimetypes
    // instances per unit of work should `await m.dispose()` when done.
    async dispose(): Promise<void> {
        await this.#embeddings.dispose();
        await this.#tokenizers.dispose();
        this.#handlerInstances.clear();
    }

    // Body-matcher query (SPEC §11). Accepts the matcher as a raw string
    // (classified by leading prefix via parseBodyMatcher) OR an already-parsed
    // ParsedBodyMatcher — the grammar owns the syntax, so a parsed body is
    // dispatched verbatim: no second parser, no drift (#42). Errors per §11.4:
    // detection/content/handler missing → ReferenceError; dialect/expression/
    // parse failures → typed QueryErrors; zero matches → [].
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

    // Degraded ProcessResult when the grammar isn't installed (SPEC §7/§13.5,
    // #14): honest metadata (line count, extent) + empty requested channels +
    // grammarMissing install hint. ok stays true — a missing grammar is a
    // normal a-la-carte state, not an error.
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

// Error-path result: metadata only, channel fields absent (SPEC §7).
// Centralized so every error route returns the same shape.
function errorResult(mimetype: string | null): ProcessResult {
    return {
        mimetype,
        ok: false,
        totalLines: 0,
        extent: 0,
    };
}

// Project a degraded result's grammarMissing/embeddingMissing into `warn`
// telemetry (SPEC §11.5, plurnk-service#276) — a degraded result reports
// ok:true, so its severity is invisible unless the producer puts it on the
// wire. Derived from the result's own fields so it can't drift. Only reached
// for ok:true results that carry a mimetype.
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

// Editor-convention line count (SPEC §7): `abc\ndef`→2, `abc\ndef\n`→2
// (trailing newline terminates, doesn't add a line), `\n`→1, ""→0. Matches
// `wc -l` and plurnk-grammar's `<L>` slot addressing.
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
