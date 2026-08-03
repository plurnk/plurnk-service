import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { detect } from "./detect.ts";
import { discover } from "./discover.ts";
import { parseBodyMatcher, type ParsedBodyMatcher } from "./parseBodyMatcher.ts";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { UnsupportedDialectError } from "./QueryError.ts";
import { isGrammarNotInstalled } from "./TreeSitterExtractor.ts";
import BaseHandler from "./BaseHandler.ts";
import Embeddings, { type EmbedBatchOptions, type EmbedderInfo } from "./Embeddings.ts";
import Tokenizers, { type TokenizerResolution } from "./Tokenizers.ts";
import { classifyMimetype, classifyWithHandler, type MimeClassification } from "./classify.ts";
import { matchSearchExclusion } from "./searchExcluded.ts";
import { mimetypeSource, type Notice } from "./Notice.ts";
import type {
    DetectInput,
    DiscoverOptions,
    Discovery,
    HandlerMetadata,
    MimeRef,
    MimeSymbol,
    QueryMatch,
} from "./types.ts";

// The caller-selected projection vocabulary ({§mimetype-channel-selection}).
// Embedding inference is opt-in and therefore absent from the default set.
export type Channel = "symbols" | "deepJson" | "deepXml" | "references" | "content" | "embedding";

const DEFAULT_CHANNELS: readonly Channel[] = ["symbols", "deepJson", "deepXml", "references", "content"];

// Public seam types stay reachable from the orchestrator module.
export type { EmbedderInfo, EmbedProgress, EmbedBatchOptions } from "./Embeddings.ts";
export type { TokenizerResolution } from "./Tokenizers.ts";

// Loader hook: how to resolve a handler package to its default-exported class.
// The default anchors resolution in the same consumer-visible module graph
// discovery scans ({§mimetype-discovery}); tests and unusual package layouts
// may inject a loader.
export type HandlerLoader = (packageName: string) => Promise<unknown>;

const defaultLoader = (cwd: string): HandlerLoader => {
    const require = createRequire(path.join(path.resolve(cwd), "package.json"));
    return (packageName) => import(pathToFileURL(require.resolve(packageName)).href);
};

export interface MimetypesOptions {
    discoverOptions?: DiscoverOptions;
    // Pre-built discovery — bypasses the filesystem scan. Useful for tests and
    // for consumers that build their registry programmatically.
    discovery?: Discovery;
    loader?: HandlerLoader;
    // Mimetype to return when every detection lane misses. Unset means null.
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
    // Channels to materialize on this call ({§mimetype-channel-selection}).
    // Absent fields are not requested; `[]` performs no projection parse.
    channels?: readonly Channel[];
    // A missing grammar normally returns explicit empty structural channels;
    // strict mode throws instead ({§mimetype-error-policy}).
    strict?: boolean;
}

export interface ProcessResult {
    // Always-on metadata ({§mimetype-error-policy}).
    mimetype: string | null;
    ok: boolean;
    // Logical source line count; 0 for binary and every returned error path.
    totalLines: number;
    // Missing grammar package for a non-strict structural degradation.
    grammarMissing?: string;
    // Matched operator pattern, without changing readability
    // ({§mimetype-search-exclusion}).
    searchExcluded?: string;

    // Projection fields are present iff requested.
    // Structured definitions and outline source.
    symbols?: MimeSymbol[];
    // Faithful JSONPath target; null when unavailable.
    deepJson?: unknown;
    // Faithful XPath target; handler overrides remain authoritative.
    deepXml?: string;
    // Classified symbol uses ({§mimetype-references}).
    references?: MimeRef[];
    // Derived readable text ({§mimetype-content}).
    content?: string;
    // Opt-in vector in the current byte representation
    // ({§mimetype-embedding-wire}).
    embedding?: Uint8Array;
    // Missing artifact for a non-strict embedding degradation.
    embeddingMissing?: string;
    // Model-space identity for the vector above, when declared by the artifact.
    embeddingModel?: string;
    // Successful degradations projected through the shared Notice contract.
    notices?: readonly Notice[];
}

// Top-level discovery, projection, and artifact orchestrator
// ({§mimetype-lifecycle}).
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
        this.#loader = options.loader ?? defaultLoader(this.#discoverOptions.cwd ?? process.cwd());
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

    async skippedPackages(): Promise<readonly string[]> {
        await this.ready();
        return [...this.#discovery!.skipped];
    }

    async detect(input: DetectInput): Promise<string | null> {
        await this.ready();
        const result = detect(input, this.#discovery!.registry);
        return result ?? this.#defaultMimetype;
    }

    // Registry-aware classification; installed declarations are authoritative
    // ({§mimetype-classification}).
    async classify(mimetype: string): Promise<MimeClassification> {
        await this.ready();
        const info = this.#discovery!.handlers.get(mimetype);
        if (info === undefined) return classifyMimetype(mimetype);
        return classifyWithHandler(mimetype, { binary: info.binary });
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

    // Detect, read, route, validate, and materialize the selected projections
    // under {§mimetype-handler-authority} and {§mimetype-error-policy}.
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

        // Current path-only signal; scheme-aware ownership is tracked in #91.
        const searchExcluded = matchSearchExclusion(input.path);

        // Validate errors propagate per error policy — caller's contract.
        // Await in case the handler returns a Promise (async validators).
        await handler.validate(content);

        // Materialize requested channels in parallel. The default deep-xml
        // projection needs deep-json, so deepJson is computed (unexposed) when
        // only deepXml is requested and the handler hasn't overridden deepXml().
        // GrammarNotInstalledError selects the non-strict degradation path.
        //
        // Missing required methods fail explicitly. #88 owns replacing the
        // version-specific compatibility branch with one handler-load contract.
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
        let deepXml: string | undefined;
        try {
            [symbols, deepJsonValue, references, contentValue] = await Promise.all([
                channels.has("symbols") ? handler.extractRaw(content) : undefined,
                needsDeepJson ? handler.deepJson(content) : undefined,
                channels.has("references") ? handler.references(content) : undefined,
                channels.has("content") ? handler.content(content) : undefined,
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
                    searchExcluded,
                );
            }
            throw err;
        }
        const totalLines = typeof content === "string" ? countLines(content) : 0;
        const embeddingPart = channels.has("embedding")
            ? await this.#embeddings.embedFor(content, handler, options.strict === true)
            : {};

        return attachNotices({
            mimetype,
            ok: true,
            totalLines,
            ...(searchExcluded !== undefined && { searchExcluded }),
            ...(channels.has("symbols") && { symbols }),
            ...(channels.has("deepJson") && { deepJson: deepJsonValue }),
            ...(channels.has("deepXml") && { deepXml }),
            ...(channels.has("references") && { references }),
            ...(channels.has("content") && contentValue !== undefined && { content: contentValue }),
            ...embeddingPart,
        });
    }

    // Artifact-declared model-space and input-window facts
    // ({§mimetype-embedding}).
    async embedderInfo(): Promise<EmbedderInfo | null> {
        return this.#embeddings.info();
    }

    // Bulk input-order embedding through the same artifact seam.
    async embedBatch(texts: readonly string[], options?: EmbedBatchOptions): Promise<Uint8Array[]> {
        return this.#embeddings.batch(texts, options);
    }

    // Exact-or-explicitly-degraded vocabulary counting
    // ({§mimetype-tokenizer}).
    async tokenizer(modelRef: string, options?: { strict?: boolean }): Promise<TokenizerResolution> {
        return this.#tokenizers.tokenizer(modelRef, options);
    }

    // Release artifact resources and handler instances ({§mimetype-lifecycle}).
    async dispose(): Promise<void> {
        await this.#embeddings.dispose();
        await this.#tokenizers.dispose();
        this.#handlerInstances.clear();
    }

    // Raw standalone matchers and grammar-parsed matchers converge on one
    // dispatch/evidence path ({§mimetype-query-input}).
    async query(input: ProcessInput, matcher: string | ParsedBodyMatcher): Promise<QueryMatch[]> {
        const mimetype = await this.detect(input);
        if (mimetype === null) {
            throw new ReferenceError("Mimetypes.query: no mimetype could be resolved for input");
        }
        // String -> classify by leading prefix; parsed body -> dispatch verbatim.
        const parsed = typeof matcher === "string" ? parseBodyMatcher(matcher) : matcher;

        const info = this.#discovery!.handlers.get(mimetype) ?? null;
        const isBinary = info?.binary ?? false;

        const content = await this.#resolveContent(input, isBinary);
        if (content === null) {
            throw new ReferenceError(`Mimetypes.query: content unreadable for ${mimetype}`);
        }

        const handler = await this.getHandler(mimetype);
        if (handler === null) {
            if (info === null) {
                throw new UnsupportedDialectError({
                    mimetype,
                    dialect: parsed.dialect,
                    reason: "no registered handler provides a readable projection",
                });
            }
            throw new ReferenceError(`Mimetypes.query: registered handler unavailable for ${mimetype}`);
        }

        return handler.query(content, parsed.dialect, parsed.pattern, parsed.flags);
    }

    // Missing grammar preserves mimetype/body metadata and reports empty
    // requested structural channels ({§mimetype-error-policy}).
    async #degradedResult(
        mimetype: string,
        content: string | Uint8Array,
        channels: ReadonlySet<Channel>,
        plurnkPackage: string,
        searchExcluded: string | undefined,
    ): Promise<ProcessResult> {
        const totalLines = typeof content === "string" ? countLines(content) : 0;
        // The embedding channel does not need the grammar — a degraded entry
        // is still semantically searchable text (non-strict: a missing
        // embedder stacks its own hint alongside grammarMissing).
        const embeddingPart = channels.has("embedding")
            ? await this.#embeddings.embedFor(content, null, false)
            : {};
        return attachNotices({
            mimetype,
            ok: true,
            totalLines,
            grammarMissing: plurnkPackage,
            ...(searchExcluded !== undefined && { searchExcluded }),
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

// One metadata-only returned-error shape ({§mimetype-error-policy}).
function errorResult(mimetype: string | null): ProcessResult {
    return {
        mimetype,
        ok: false,
        totalLines: 0,
    };
}

// Derive successful-degradation Notices from the result signals
// ({§mimetype-error-policy}, {§notice}).
function attachNotices(result: ProcessResult): ProcessResult {
    const notices: Notice[] = [];
    if (typeof result.grammarMissing === "string") {
        notices.push({
            source: mimetypeSource(result.mimetype!),
            kind: "grammar_degraded",
            level: "warn",
            message: `No grammar installed for ${result.mimetype}; structural channels are empty. `
                + `Install ${result.grammarMissing} to enable them.`,
            position: null,
            mimetype: result.mimetype,
            plurnkPackage: result.grammarMissing,
        });
    }
    if (typeof result.embeddingMissing === "string") {
        notices.push({
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
    return notices.length === 0 ? result : { ...result, notices };
}

// Logical editor-line count ({§mimetype-error-policy}): a trailing newline
// terminates its line without creating another one.
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
