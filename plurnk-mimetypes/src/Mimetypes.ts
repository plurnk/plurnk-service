import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { detect } from "./detect.ts";
import { discover } from "./discover.ts";
import { parseBodyMatcher, type ParsedBodyMatcher } from "./parseBodyMatcher.ts";
import { projectDeepXml } from "./projectDeepXml.ts";
import { QueryParseFailureError, UnsupportedDialectError } from "./QueryError.ts";
import { isGrammarNotInstalled } from "./TreeSitterExtractor.ts";
import BaseHandler from "./BaseHandler.ts";
import Embeddings, { type EmbedBatchOptions, type EmbedderInfo } from "./Embeddings.ts";
import MimetypeInputError, { isMimetypeInputError } from "./MimetypeInputError.ts";
import MimetypeInputLimitError from "./MimetypeInputLimitError.ts";
import Tokenizers, { type TokenizerResolution } from "./Tokenizers.ts";
import { classifyMimetype, classifyWithHandler, type MimeClassification } from "./classify.ts";
import { mimetypeSource, type Notice } from "./Notice.ts";
import MimetypePluginError from "./MimetypePluginError.ts";
import Meta, {
    type PluginAttribution,
    type PluginAttributionContext,
} from "@plurnk/plurnk-meta";
import type {
    DetectInput,
    DiscoverOptions,
    Discovery,
    DiscoveryResult,
    HandlerInfo,
    MimetypeDisplayMetadata,
    HandlerMetadata,
    MimeRef,
    MimeSymbol,
    QueryMatch,
} from "./types.ts";

// The caller-selected projection vocabulary ({§mimetype-channel-selection}).
// Embedding inference is opt-in and therefore absent from the default set.
export type Channel = "symbols" | "deepJson" | "deepXml" | "references" | "content" | "embedding";

const DEFAULT_CHANNELS: readonly Channel[] = ["symbols", "deepJson", "deepXml", "references", "content"];
const FRAMEWORK_PROJECTION_REVISION = "2";
const HANDLER_METHODS = [
    "extractRaw",
    "deepJson",
    "deepXml",
    "references",
    "content",
    "validate",
    "parseIssues",
    "projectionConfiguration",
    "query",
    "symbolsRaw",
    "toText",
] as const;

// Public seam types stay reachable from the orchestrator module.
export type { EmbedderInfo, EmbedProgress, EmbedBatchOptions } from "./Embeddings.ts";
export type { TokenizerResolution } from "./Tokenizers.ts";

// Default and caller-owned loading modes ({§mimetype-package-resolution}).
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
    // Caller-owned resolution for an unusual or import-only package graph.
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
    // Request parser-recovery evidence independently of structural channel
    // materialization ({§mimetype-parse-issues}).
    parseIssues?: boolean;
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
    // Positive parser-recovery count from requested inspection.
    parseIssues?: number;

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
    // Opt-in vector in the canonical portable byte representation
    // ({§mimetype-embedding-wire}).
    embedding?: Uint8Array;
    // Missing artifact for a non-strict embedding degradation.
    embeddingMissing?: string;
    // Model-space identity for the vector above, when declared by the artifact.
    embeddingModel?: string;
    // Successful degradations projected through the shared Notice contract.
    notices?: readonly Notice[];
}

export interface ReadableProjection {
    content: string;
    sourceMimetype: string;
    projectionIdentity: string;
}

const binaryInputMaximum = (): number => {
    const name = "PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES";
    const raw = process.env[name];
    const value = Number(raw);
    if (raw === undefined || raw.trim() === "" || !Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer; got ${JSON.stringify(raw)}.`);
    }
    return value;
};

// Top-level discovery, projection, and artifact orchestrator
// ({§mimetype-lifecycle}).
export default class Mimetypes {
    readonly #discoverOptions: DiscoverOptions;
    readonly #loader: HandlerLoader;
    readonly #defaultMimetype: string | null;
    readonly #handlerInstances = new Map<string, Promise<BaseHandler>>();
    readonly #grammarFingerprints = new Map<string, Promise<string>>();
    readonly #embeddings: Embeddings;
    readonly #tokenizers: Tokenizers;
    #discovery: DiscoveryResult | null = null;
    #readyPromise: Promise<void> | null = null;
    #disposePromise: Promise<void> | null = null;

    constructor(options: MimetypesOptions = {}) {
        this.#discoverOptions = options.discoverOptions ?? {};
        this.#loader = options.loader ?? defaultLoader(this.#discoverOptions.cwd ?? process.cwd());
        this.#defaultMimetype = options.defaultMimetype ?? null;
        this.#embeddings = new Embeddings(this.#loader);
        this.#tokenizers = new Tokenizers(this.#loader);
        if (options.discovery !== undefined) {
            this.#discovery = {
                ...options.discovery,
                packageAttributions: options.discovery.packageAttributions ?? new Map(),
            };
        }
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

    async displayMetadata(): Promise<readonly MimetypeDisplayMetadata[]> {
        await this.ready();
        return [...this.#discovery!.handlers.values()]
            .map(({ mimetype, glyph }) => ({ mimetype, glyph }))
            .toSorted((a, b) => a.mimetype.localeCompare(b.mimetype));
    }

    // {§plugin-attribution} Static package tags remain always-on. Runtime
    // collection consults only handler objects already loaded by ordinary
    // mimetype work, preserving the family's lazy-loading contract.
    async attributions(context: PluginAttributionContext): Promise<PluginAttribution> {
        await this.ready();
        const lists: PluginAttribution[] = [...this.#discovery!.packageAttributions.values()];
        const packageSources = new Map<string, Set<BaseHandler>>();
        for (const [mimetype, resolution] of this.#handlerInstances) {
            const info = this.#discovery!.handlers.get(mimetype);
            if (info?.source !== "package") continue;
            const sources = packageSources.get(info.packageName) ?? new Set<BaseHandler>();
            sources.add(await resolution);
            packageSources.set(info.packageName, sources);
        }
        for (const [packageName, sources] of packageSources) {
            for (const source of sources) {
                lists.push(Meta.runtimeAttribution(source, context, packageName));
            }
        }
        return Meta.composeAttributions(...lists);
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

    // Opaque identity for installed projection behavior
    // ({§mimetype-projection-identity}).
    async projectionIdentity(mimetype: string): Promise<string> {
        await this.ready();
        const info = this.#discovery!.handlers.get(mimetype);
        if (info === undefined) {
            return projectionDigest({
                contract: 1,
                mimetype,
                registration: null,
            });
        }

        const handler = await this.getHandler(mimetype);
        if (handler === null) {
            throw new MimetypePluginError({
                reason: "registered handler could not be resolved",
                packageName: info.packageName,
                mimetype,
            });
        }

        let configuration: unknown;
        try {
            configuration = await handler.projectionConfiguration();
        } catch (cause) {
            throw new MimetypePluginError({
                reason: "projection configuration failed",
                packageName: info.packageName,
                mimetype,
                cause,
            });
        }
        if (typeof configuration !== "string") {
            throw new MimetypePluginError({
                reason: "projectionConfiguration() must return a string",
                packageName: info.packageName,
                mimetype,
                cause: new TypeError(`received ${typeof configuration}`),
            });
        }

        const grammar = info.source === "treesitter"
            ? await this.#treeSitterGrammarFingerprint(info)
            : null;
        return projectionDigest({
            contract: 1,
            frameworkRevision: FRAMEWORK_PROJECTION_REVISION,
            mimetype,
            source: info.source,
            packageName: info.packageName,
            handlerRevision: info.projectionRevision,
            configuration,
            grammar,
        });
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

        const resolution = (async (): Promise<BaseHandler> => {
            const candidate = info.source === "treesitter"
                ? await this.#instantiateTreeSitterHandler(metadata, info)
                : await this.#instantiatePackageHandler(metadata, info.packageName, info.mimetype);
            const surfaceFailure = handlerSurfaceFailure(candidate, metadata);
            if (surfaceFailure !== null) {
                throw new MimetypePluginError({
                    reason: "handler surface is incompatible",
                    packageName: info.packageName,
                    mimetype: info.mimetype,
                    cause: surfaceFailure,
                });
            }
            return candidate as BaseHandler;
        })();
        this.#handlerInstances.set(mimetype, resolution);
        try {
            return await resolution;
        } catch (error) {
            if (this.#handlerInstances.get(mimetype) === resolution) {
                this.#handlerInstances.delete(mimetype);
            }
            throw error;
        }
    }

    // One derived-Unicode seam for string, inline-byte, and filesystem sources
    // ({§mimetype-binary-input}). Absence is decided before binary acquisition
    // when the installed handler does not own a content projection.
    async projectReadable(input: ProcessInput): Promise<ReadableProjection | null> {
        const mimetype = await this.detect(input);
        if (mimetype === null) return null;
        const handler = await this.getHandler(mimetype);
        if (handler === null || handler.content === BaseHandler.prototype.content) return null;
        const result = await this.process(input, { channels: ["content"] });
        if (typeof result.content !== "string") return null;
        return {
            content: result.content,
            sourceMimetype: mimetype,
            projectionIdentity: await this.projectionIdentity(mimetype),
        };
    }

    // Streamed bytes remain within the framework-owned memory ceiling and are
    // never retained when no installed binary content projection exists.
    async projectReadableStream(
        chunks: AsyncIterable<Uint8Array>,
        mimetype: string,
    ): Promise<ReadableProjection | null> {
        await this.ready();
        const info = this.#discovery!.handlers.get(mimetype);
        if (info?.binary !== true) return null;
        const handler = await this.getHandler(mimetype);
        if (handler === null || handler.content === BaseHandler.prototype.content) return null;
        return this.projectReadable({
            content: await Mimetypes.#collectBinary(chunks, mimetype),
            hint: mimetype,
        });
    }

    async #instantiatePackageHandler(
        metadata: HandlerMetadata,
        packageName: string,
        mimetype: string,
    ): Promise<unknown> {
        let mod: unknown;
        try {
            mod = await this.#loader(packageName);
        } catch (cause) {
            throw new MimetypePluginError({
                reason: "package import failed",
                packageName,
                mimetype,
                cause,
            });
        }
        if (typeof mod !== "object" || mod === null) {
            throw new MimetypePluginError({
                reason: "module must expose a default handler constructor",
                packageName,
                mimetype,
                cause: new TypeError("handler module is not an object"),
            });
        }
        const HandlerClass = (mod as { default?: unknown }).default;
        if (typeof HandlerClass !== "function") {
            throw new MimetypePluginError({
                reason: "module must expose a default handler constructor",
                packageName,
                mimetype,
                cause: new TypeError("default export is not a constructor"),
            });
        }
        try {
            const Ctor = HandlerClass as new (m: HandlerMetadata) => unknown;
            return new Ctor(metadata);
        } catch (cause) {
            throw new MimetypePluginError({
                reason: "handler construction failed",
                packageName,
                mimetype,
                cause,
            });
        }
    }

    async #instantiateTreeSitterHandler(
        metadata: HandlerMetadata,
        info: HandlerInfo,
    ): Promise<unknown> {
        const { lookupTreeSitterLanguage } = await import("./treesitter/registry.ts");
        const entry = lookupTreeSitterLanguage(info.mimetype);
        if (entry === null) {
            throw new MimetypePluginError({
                reason: "framework registry entry is absent",
                packageName: info.packageName,
                mimetype: info.mimetype,
            });
        }
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

        const content = await this.#resolveContent(input, isBinary, mimetype);
        if (content === null) {
            return errorResult(mimetype);
        }

        const handler = await this.getHandler(mimetype);
        if (handler === null) {
            return errorResult(mimetype);
        }

        await this.#validateInput(handler, content, mimetype);

        // Materialize requested channels in parallel. Default deep-XML
        // dependencies are reused and remain unexposed when not requested
        // ({§mimetype-channel-selection}). GrammarNotInstalledError selects the
        // non-strict degradation path.
        //
        const usesDefaultDeepXml = channels.has("deepXml")
            && handler.deepXml === BaseHandler.prototype.deepXml;
        const needsDeepJson = channels.has("deepJson") || usesDefaultDeepXml;
        const needsParseIssues = options.parseIssues === true
            || channels.has("symbols")
            || channels.has("deepJson")
            || channels.has("deepXml")
            || channels.has("references");
        let symbols: MimeSymbol[] | undefined;
        let deepJsonValue: unknown;
        let references: MimeRef[] | undefined;
        let contentValue: string | undefined;
        let rawParseIssues: number | undefined;
        let deepXml: string | undefined;
        try {
            [symbols, deepJsonValue, references, contentValue, rawParseIssues] = await Promise.all([
                channels.has("symbols") ? handler.extractRaw(content) : undefined,
                needsDeepJson ? handler.deepJson(content) : undefined,
                channels.has("references") ? handler.references(content) : undefined,
                channels.has("content") ? handler.content(content) : undefined,
                needsParseIssues ? handler.parseIssues(content) : undefined,
            ]);
            if (channels.has("deepXml")) {
                deepXml = usesDefaultDeepXml
                    ? await projectDeepXml(deepJsonValue, async () => {
                        symbols ??= await handler.extractRaw(content);
                        return symbols;
                    })
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
        const parseIssues = normalizeParseIssues(rawParseIssues, mimetype);

        return attachNotices({
            mimetype,
            ok: true,
            totalLines,
            ...(parseIssues === undefined ? {} : { parseIssues }),
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
        if (this.#disposePromise !== null) return this.#disposePromise;
        const disposal = this.#disposeResources();
        this.#disposePromise = disposal;
        try {
            await disposal;
        } finally {
            if (this.#disposePromise === disposal) this.#disposePromise = null;
        }
    }

    async #disposeResources(): Promise<void> {
        const handlers = [...this.#handlerInstances.values()];
        this.#handlerInstances.clear();
        this.#grammarFingerprints.clear();
        const results = await Promise.allSettled([
            this.#embeddings.dispose(),
            this.#tokenizers.dispose(),
            ...handlers.map(async (handler) => (await handler).dispose?.()),
        ]);
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .flatMap((result) => result.reason instanceof AggregateError
                ? [...result.reason.errors]
                : [result.reason]);
        if (errors.length > 0) throw new AggregateError(errors, "mimetype resource shutdown failed");
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

        const content = await this.#resolveContent(input, isBinary, mimetype);
        if (content === null) {
            throw new ReferenceError(`Mimetypes.query: content unreadable for ${mimetype}`);
        }

        const handler = await this.getHandler(mimetype);
        if (handler === null) {
            throw new UnsupportedDialectError({
                mimetype,
                dialect: parsed.dialect,
                reason: "no registered handler provides a readable projection",
            });
        }

        try {
            // Structural matchers require a valid structural source. Text
            // matchers remain available against malformed structured files
            // because they do not consume that structure.
            if (parsed.dialect === "jsonpath" || parsed.dialect === "xpath") {
                await this.#validateInput(handler, content, mimetype);
            }
            return await handler.query(content, parsed.dialect, parsed.pattern, parsed.flags);
        } catch (cause) {
            if (isMimetypeInputError(cause)) {
                if ((cause as Error).name === "QueryParseFailureError") throw cause;
                throw new QueryParseFailureError({ mimetype, cause });
            }
            throw cause;
        }
    }

    // validate() is the one handler-owned source-rejection gate. Classify its
    // failure once; projection/load defects retain their identities.
    async #validateInput(
        handler: BaseHandler,
        content: string | Uint8Array,
        mimetype: string,
    ): Promise<void> {
        try {
            await handler.validate(content);
        } catch (cause) {
            if (isMimetypeInputError(cause)) throw cause;
            throw new MimetypeInputError({ mimetype, cause });
        }
    }

    // Missing grammar preserves mimetype/body metadata and reports empty
    // requested structural channels ({§mimetype-error-policy}).
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
        return attachNotices({
            mimetype,
            ok: true,
            totalLines,
            grammarMissing: plurnkPackage,
            ...(channels.has("symbols") && { symbols: [] }),
            ...(channels.has("deepJson") && { deepJson: null }),
            ...(channels.has("deepXml") && { deepXml: "" }),
            ...(channels.has("references") && { references: [] }),
            ...embeddingPart,
        });
    }

    async #resolveContent(
        input: ProcessInput,
        binary: boolean,
        mimetype: string,
    ): Promise<string | Uint8Array | null> {
        if (input.content !== undefined) {
            if (binary && input.content instanceof Uint8Array) {
                Mimetypes.#assertBinarySize(input.content.byteLength, mimetype);
            }
            return input.content;
        }
        if (input.path === undefined || input.path === "") return null;
        try {
            return binary
                ? await Mimetypes.#readBinaryFile(input.path, mimetype)
                : await fs.readFile(input.path, "utf-8");
        } catch (error) {
            if (error instanceof MimetypeInputLimitError) throw error;
            return null;
        }
    }

    static #assertBinarySize(
        observedBytes: number,
        mimetype: string,
        maximumBytes = binaryInputMaximum(),
    ): void {
        if (observedBytes > maximumBytes) {
            throw new MimetypeInputLimitError({ mimetype, maximumBytes, observedBytes });
        }
    }

    static async #collectBinary(
        chunks: AsyncIterable<Uint8Array>,
        mimetype: string,
    ): Promise<Uint8Array> {
        const maximumBytes = binaryInputMaximum();
        const collected: Uint8Array[] = [];
        let observedBytes = 0;
        for await (const chunk of chunks) {
            if (!(chunk instanceof Uint8Array)) {
                throw new TypeError(`Binary projection for ${mimetype} yielded a non-Uint8Array chunk.`);
            }
            observedBytes += chunk.byteLength;
            Mimetypes.#assertBinarySize(observedBytes, mimetype, maximumBytes);
            collected.push(chunk);
        }
        const content = new Uint8Array(observedBytes);
        let offset = 0;
        for (const chunk of collected) {
            content.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return content;
    }

    static async #readBinaryFile(file: string, mimetype: string): Promise<Uint8Array> {
        const handle = await fs.open(file, "r");
        try {
            const { size } = await handle.stat();
            Mimetypes.#assertBinarySize(size, mimetype, binaryInputMaximum());
            const content = new Uint8Array(size);
            let offset = 0;
            while (offset < content.byteLength) {
                const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
                if (bytesRead === 0) break;
                offset += bytesRead;
            }
            return offset === content.byteLength ? content : content.slice(0, offset);
        } finally {
            await handle.close();
        }
    }

    async #treeSitterGrammarFingerprint(info: HandlerInfo): Promise<string> {
        const cached = this.#grammarFingerprints.get(info.packageName);
        if (cached !== undefined) return cached;

        const fingerprint = (async (): Promise<string> => {
            const { lookupTreeSitterLanguage } = await import("./treesitter/registry.ts");
            const entry = lookupTreeSitterLanguage(info.mimetype);
            if (entry === null) {
                throw new MimetypePluginError({
                    reason: "framework registry entry is absent",
                    packageName: info.packageName,
                    mimetype: info.mimetype,
                });
            }
            const { resolveWasmPath } = await import("./treesitter/handler.ts");
            let wasmPath: string;
            try {
                wasmPath = await resolveWasmPath(entry);
            } catch (cause) {
                if (isGrammarNotInstalled(cause)) return "absent";
                throw cause;
            }
            try {
                const wasm = await fs.readFile(wasmPath);
                return `sha256:${createHash("sha256").update(wasm).digest("hex")}`;
            } catch (cause) {
                if (isMissingFile(cause)) return "absent";
                throw new MimetypePluginError({
                    reason: "grammar artifact fingerprint failed",
                    packageName: info.packageName,
                    mimetype: info.mimetype,
                    cause,
                });
            }
        })();
        this.#grammarFingerprints.set(info.packageName, fingerprint);
        void fingerprint.catch(() => {
            if (this.#grammarFingerprints.get(info.packageName) === fingerprint) {
                this.#grammarFingerprints.delete(info.packageName);
            }
        });
        return fingerprint;
    }
}

function projectionDigest(value: object): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isMissingFile(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === "ENOENT";
}

function normalizeParseIssues(value: number | undefined, mimetype: string): number | undefined {
    if (value === undefined || value === 0) return undefined;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(
            `Invalid parseIssues result for ${mimetype}: expected a nonnegative safe integer; got ${JSON.stringify(value)}`,
        );
    }
    return value;
}

// One metadata-only returned-error shape ({§mimetype-error-policy}).
function errorResult(mimetype: string | null): ProcessResult {
    return {
        mimetype,
        ok: false,
        totalLines: 0,
    };
}

function handlerSurfaceFailure(candidate: unknown, metadata: HandlerMetadata): TypeError | null {
    if (typeof candidate !== "object" || candidate === null) {
        return new TypeError("invalid handler surface: constructor did not return an object");
    }
    const surface = candidate as Record<string, unknown>;
    const missing = HANDLER_METHODS.filter((method) => typeof surface[method] !== "function");
    if (missing.length > 0) {
        return new TypeError(`invalid handler surface: missing callable ${missing.map((method) => `${method}()`).join(", ")}`);
    }
    if (
        surface.mimetype !== metadata.mimetype
        || surface.glyph !== metadata.glyph
        || !Array.isArray(surface.extensions)
        || surface.extensions.length !== metadata.extensions.length
        || !surface.extensions.every((extension, index) => extension === metadata.extensions[index])
    ) {
        return new TypeError("invalid handler surface: constructor did not preserve injected metadata");
    }
    return null;
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
