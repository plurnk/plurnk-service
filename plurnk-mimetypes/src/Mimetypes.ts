import fs from "node:fs/promises";
import { defaultTokenize } from "./defaults.ts";
import { detect } from "./detect.ts";
import { discover } from "./discover.ts";
import { fitPreview, TRUNCATION_MARKER_TAIL } from "./fit.ts";
import { parseBodyMatcher } from "./parseBodyMatcher.ts";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { isGrammarNotInstalled } from "./TreeSitterExtractor.ts";
import BaseHandler from "./BaseHandler.ts";
import type {
    DetectInput,
    DiscoverOptions,
    Discovery,
    HandlerMetadata,
    Preview,
    QueryMatch,
    TokenizeFn,
} from "./types.ts";

// No default budget in the helper. plurnk-service owns the real default
// (PLURNK_ENTRY_SIZE_DEFAULT_TOKENS, runtime env, currently 256 tokens for the
// channel preview portal) and passes it per call. When budget is unspecified
// here, preview is unbounded — the handler's full material is returned as-is.
// Baking a fallback number would silently shadow the env var and create drift
// when plurnk-service changes its default.
const UNBOUNDED_BUDGET = Number.POSITIVE_INFINITY;

// Loader hook: how to resolve a handler package to its default-exported class.
// Production uses dynamic import(); tests inject a custom loader to avoid
// touching the module system.
export type HandlerLoader = (packageName: string) => Promise<unknown>;

const defaultLoader: HandlerLoader = (packageName) => import(packageName);

export interface MimetypesOptions {
    tokenize?: TokenizeFn;
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
    budget?: number;
    // When true, missing grammar for a detected mimetype throws
    // GrammarNotInstalledError instead of degrading to a text-plain fallback.
    // Default false — see issue #14: in the a-la-carte world, a missing
    // grammar is the expected normal state for any deployment that installs
    // only the languages it uses, not an error condition. Consumers that
    // genuinely require a specific grammar to be present can opt in.
    strict?: boolean;
}

export interface ProcessResult {
    mimetype: string | null;
    preview: string;
    // Token count of `preview` measured by the same `tokenize` function the
    // orchestrator was constructed with. Exposed so consumers (notably
    // plurnk-service's tokenomics ledger — see #7) don't have to re-tokenize
    // the returned preview to recover its render cost. Always present; 0 for
    // empty previews (every error path, plus `null` handler returns).
    previewTokens: number;
    // Editor-convention line count of the source content. Exposed so models
    // can reason about context management — "this preview shows lines 8-12
    // of a 200-line file" requires both the prefixes in `preview` (#8) and
    // this total. For text content: `wc -l`-style count (`abc\ndef` → 2 lines;
    // `abc\ndef\n` → 2 lines; empty string → 0). For binary content
    // (PDF, etc.): `0` — binary mimetypes aren't line-oriented and service
    // should reason about size differently for them (e.g., pages for PDF).
    // 0 on every error path.
    totalLines: number;
    // Addressable extent of the content for the model's navigation bounds
    // (issue #9). Per plurnk-grammar's `<L>` convention: line count for text
    // entries, item count for structured entries (handlers like text-csv
    // override extent() to return rows; future content-type-specific units
    // similarly). Equal to totalLines for the default text path; handlers
    // that override extent() may differ.
    extent: number;
    ok: boolean;
    // Deep-channel projections (issue #10). The full structural tree of the
    // entry in both algebras. Hidden from the model — these are the query
    // targets for the jsonpath and xpath tools, not preview material.
    // Persisted by plurnk-service in sqlite; the framework's job is to
    // produce them eagerly on every process() call. Empty string / null on
    // every error path (consistent with preview).
    deepJson: unknown;
    deepXml: string;
    // Per issue #14: when the detected mimetype's grammar package isn't
    // installed, process() degrades to a text-plain fallback and surfaces
    // the missing package name here so consumers can show an install hint.
    // Absent on the happy path. Independent of `ok` — degraded results
    // still set ok:true (the framework successfully produced a usable
    // text fallback; nothing is wrong).
    grammarMissing?: string;
}

// Top-level orchestrator. Plurnk-service constructs one of these at boot,
// injecting its tokenize function. process(path) is the primary entry point;
// detect() and getHandler() are exposed for callers that want to drive the
// pipeline manually.
export default class Mimetypes {
    readonly #tokenize: TokenizeFn;
    readonly #discoverOptions: DiscoverOptions;
    readonly #loader: HandlerLoader;
    readonly #defaultMimetype: string | null;
    readonly #handlerInstances = new Map<string, BaseHandler>();
    #discovery: Discovery | null = null;
    #readyPromise: Promise<void> | null = null;

    constructor(options: MimetypesOptions = {}) {
        this.#tokenize = options.tokenize ?? defaultTokenize;
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
    // preview material → fit. The handler is the sole authority on what
    // material the preview is built from (structured symbols, oriented text,
    // or nothing); the framework is the sole authority on fitting that
    // material into the token budget. There is no fallback — if the handler
    // returns null, the preview is empty by design.
    //
    // Error routing:
    //   * detection fails → ok:false, empty preview
    //   * content read fails → ok:false, empty preview
    //   * handler missing → ok:false, empty preview
    //   * validate throws → propagates (caller's contract; bug in content or handler)
    //   * preview throws inside handler → contained per handler's own discipline
    async process(input: ProcessInput, options: ProcessOptions = {}): Promise<ProcessResult> {
        const budget = options.budget ?? UNBOUNDED_BUDGET;
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

        // Build all three channels and the metadata in parallel. The handler
        // owns extractRaw caching (or its parser cache) so symbols + deepJson
        // typically share work. Deep channels are eager per #10: every
        // process() call materializes them for plurnk-service to persist.
        //
        // GrammarNotInstalledError catch routes to the text-plain degradation
        // path per issue #14 unless options.strict is set. Anything else
        // propagates per error policy.
        let material: Preview;
        let deepJsonValue: unknown;
        let extentValue: number;
        let deepXml: string;
        try {
            [material, deepJsonValue, extentValue] = await Promise.all([
                handler.preview(content),
                handler.deepJson(content),
                handler.extent(content),
            ]);
            deepXml = await projectDeepXml(handler, deepJsonValue, content);
        } catch (err) {
            if (isGrammarNotInstalled(err) && !options.strict) {
                return await this.#degradedResult(
                    mimetype,
                    content,
                    (err as { plurnkPackage?: string }).plurnkPackage ?? "",
                    budget,
                );
            }
            throw err;
        }
        const fitted = await fitPreview(material, budget, this.#tokenize);
        // Pre-format the preview for verbatim rendering downstream (#8). Text
        // previews get `N:\t` line prefixes per plurnk-grammar's plurnk.md
        // §"Paths" convention; symbols outlines are emitted unmodified (they
        // already carry source-line annotations like `[5-47]` inline). null
        // material or empty preview pass through. Service renders the result
        // as-is — no internal preview metadata needed at the consumer.
        const preview = renderPreviewForConsumer(material, fitted);
        // Tokenize the final (rendered) preview once and expose the count so
        // consumers (plurnk-service tokenomics ledger — see #7) don't have to
        // repeat the work. Empty preview short-circuits without paying.
        const previewTokens = preview.length === 0 ? 0 : await this.#tokenize(preview);
        // Total source-line count for the model's context-management
        // reasoning. Editor-convention count for text content; 0 for binary
        // content (PDF etc.) since lines aren't a meaningful unit there.
        const totalLines = typeof content === "string" ? countLines(content) : 0;

        return {
            mimetype,
            preview,
            previewTokens,
            totalLines,
            extent: extentValue,
            ok: true,
            deepJson: deepJsonValue,
            deepXml,
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
    // isn't installed (issue #14). Routes content through text/plain so the
    // consumer still gets a usable preview + line count, and sets
    // grammarMissing as a structured install hint.
    async #degradedResult(
        mimetype: string,
        content: string | Uint8Array,
        plurnkPackage: string,
        budget: number,
    ): Promise<ProcessResult> {
        const fallback = await this.getHandler("text/plain");
        if (fallback === null) {
            // Floor missing — the framework's own dep tree is broken; surface
            // an honest error result rather than fabricating fake data.
            return {
                ...errorResult(mimetype),
                grammarMissing: plurnkPackage,
            };
        }
        const material = await fallback.preview(content);
        const fitted = await fitPreview(material, budget, this.#tokenize);
        const preview = renderPreviewForConsumer(material, fitted);
        const previewTokens = preview.length === 0 ? 0 : await this.#tokenize(preview);
        const totalLines = typeof content === "string" ? countLines(content) : 0;
        return {
            mimetype,
            preview,
            previewTokens,
            totalLines,
            extent: totalLines,
            ok: true,
            deepJson: null,
            deepXml: "",
            grammarMissing: plurnkPackage,
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

// Apply plurnk-grammar's `N:\t` line-number convention (plurnk.md §"Paths" /
// plurnk-service SPEC §16.6) to the fitted preview, so downstream renders
// verbatim:
//   - symbols / null material / empty preview → return unchanged
//   - text head → number from 1; truncation marker rides on the final line
//   - text tail → number from the source line of the first surviving char;
//     truncation marker rides on the first line
// Line numbers reflect positions in the handler's own `material.text` (which
// for content-transforming handlers like text-html or application-pdf is the
// post-transform text, not the raw bytes).
function renderPreviewForConsumer(material: Preview, preview: string): string {
    if (preview.length === 0 || material === null || material.kind === "symbols") {
        return preview;
    }
    const startLine = material.orientation === "tail"
        ? tailStartLine(material.text, preview)
        : 1;
    return prefixLinesWithSourceNumbers(preview, startLine);
}

// Deep-XML channel (issue #10). Honors handler `deepXml` overrides (text-html
// and application-xml serve real source markup) so the persisted channel and
// the live query() xpath target can't disagree. The default projection is
// computed from the already-built deepJson value to avoid re-parsing the
// content; handlers from packages bundle their own BaseHandler copy, so
// prototype identity can't be checked across realms — those route through
// the handler method, whose inherited default produces the same projection.
function projectDeepXml(
    handler: BaseHandler,
    deepJsonValue: unknown,
    content: string | Uint8Array,
): string | Promise<string> {
    if (handler.deepXml === BaseHandler.prototype.deepXml) {
        return deepJsonValue === null || deepJsonValue === undefined
            ? ""
            : projectJsonToXml(deepJsonValue);
    }
    return handler.deepXml(content);
}

// Compute the source line of the first surviving character in a tail-oriented
// preview. Strips the leading truncation marker (if present), finds where the
// surviving slice starts in the original material text, and counts newlines
// before that point.
function tailStartLine(original: string, preview: string): number {
    const slice = preview.startsWith(TRUNCATION_MARKER_TAIL)
        ? preview.slice(TRUNCATION_MARKER_TAIL.length)
        : preview;
    const sliceStart = original.length - slice.length;
    if (sliceStart <= 0) return 1;
    let line = 1;
    for (let i = 0; i < sliceStart; i += 1) {
        if (original.charCodeAt(i) === 0x0a) line += 1;
    }
    return line;
}

// `<startLine>:\t<line>\n<startLine+1>:\t<line>\n...` per plurnk.md §"Paths".
function prefixLinesWithSourceNumbers(text: string, startLine: number): string {
    const lines = text.split("\n");
    let out = "";
    for (let i = 0; i < lines.length; i += 1) {
        if (i > 0) out += "\n";
        out += `${startLine + i}:\t${lines[i]}`;
    }
    return out;
}

// Error-path result. Centralized so every error route returns the same shape
// (avoids the bug of forgetting to populate a new field when ProcessResult
// grows).
function errorResult(mimetype: string | null): ProcessResult {
    return {
        mimetype,
        preview: "",
        previewTokens: 0,
        totalLines: 0,
        extent: 0,
        ok: false,
        deepJson: null,
        deepXml: "",
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
