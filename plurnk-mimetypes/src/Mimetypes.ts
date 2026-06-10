import fs from "node:fs/promises";
import { detect } from "./detect.ts";
import { discover } from "./discover.ts";
import { parseBodyMatcher } from "./parseBodyMatcher.ts";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { isGrammarNotInstalled } from "./TreeSitterExtractor.ts";
import BaseHandler from "./BaseHandler.ts";
import type {
    DetectInput,
    DiscoverOptions,
    Discovery,
    HandlerMetadata,
    MimeRef,
    MimeSymbol,
    QueryMatch,
} from "./types.ts";

// The structural channels process() can materialize (issue #17). Each is
// computed iff requested; unrequested channels pay no parse and are absent
// from the result. Default is all of them — process() is the universal
// projection surface (#11); callers that want less say less.
export type Channel = "symbols" | "deepJson" | "deepXml" | "references";

const ALL_CHANNELS: readonly Channel[] = ["symbols", "deepJson", "deepXml", "references"];

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

    // ——— Channels (issue #17): present iff requested, absent otherwise ———
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
    #discovery: Discovery | null = null;
    #readyPromise: Promise<void> | null = null;

    constructor(options: MimetypesOptions = {}) {
        this.#discoverOptions = options.discoverOptions ?? {};
        this.#loader = options.loader ?? defaultLoader;
        this.#defaultMimetype = options.defaultMimetype ?? null;
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
        const channels = new Set<Channel>(options.channels ?? ALL_CHANNELS);
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
        const needsDeepJson = channels.has("deepJson")
            || (channels.has("deepXml") && handler.deepXml === BaseHandler.prototype.deepXml);
        let symbols: MimeSymbol[] | undefined;
        let deepJsonValue: unknown;
        let references: MimeRef[] | undefined;
        let extentValue: number;
        let deepXml: string | undefined;
        try {
            [symbols, deepJsonValue, references, extentValue] = await Promise.all([
                channels.has("symbols") ? handler.extractRaw(content) : undefined,
                needsDeepJson ? handler.deepJson(content) : undefined,
                channels.has("references") ? handler.references(content) : undefined,
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

        return {
            mimetype,
            ok: true,
            totalLines,
            extent: extentValue,
            ...(channels.has("symbols") && { symbols }),
            ...(channels.has("deepJson") && { deepJson: deepJsonValue }),
            ...(channels.has("deepXml") && { deepXml }),
            ...(channels.has("references") && { references }),
        };
    }

    // Body-matcher query entry point. Plurnk-service passes a raw matcher
    // expression (e.g. "$.users[0].name", "//user", "/error.*/g", "*.log") and
    // we dispatch by leading prefix to the resolved handler's query method.
    //
    // Errors:
    //   * detection fails → throws ReferenceError (no handler to query)
    //   * content read fails → throws (caller must know to retry/handle)
    //   * handler missing → throws ReferenceError
    //   * dialect unsupported for this mimetype → UnsupportedDialectError → 415
    //   * malformed expression → InvalidExpressionError → 400
    //   * content can't be parsed for dialect → QueryParseFailureError → 422
    //   * zero matches → returns [] (consumer maps to 204)
    async query(input: ProcessInput, expression: string): Promise<QueryMatch[]> {
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

        const parsed = parseBodyMatcher(expression);
        return handler.query(content, parsed.dialect, parsed.pattern, parsed.flags);
    }

    // Build a degraded ProcessResult when the detected mimetype's grammar
    // isn't installed (issue #14). The consumer still gets honest metadata
    // (line count, extent) plus empty channels for whatever it requested, and
    // grammarMissing as a structured install hint. ok stays true — in the
    // a-la-carte world a missing grammar is a normal state, not an error.
    #degradedResult(
        mimetype: string,
        content: string | Uint8Array,
        channels: ReadonlySet<Channel>,
        plurnkPackage: string,
    ): ProcessResult {
        const totalLines = typeof content === "string" ? countLines(content) : 0;
        return {
            mimetype,
            ok: true,
            totalLines,
            extent: totalLines,
            grammarMissing: plurnkPackage,
            ...(channels.has("symbols") && { symbols: [] }),
            ...(channels.has("deepJson") && { deepJson: null }),
            ...(channels.has("deepXml") && { deepXml: "" }),
            ...(channels.has("references") && { references: [] }),
        };
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
