import fs from "node:fs/promises";
import { defaultTokenize } from "./defaults.ts";
import { detect } from "./detect.ts";
import { discover } from "./discover.ts";
import { fitPreview } from "./fit.ts";
import { parseBodyMatcher } from "./parseBodyMatcher.ts";
import type BaseHandler from "./BaseHandler.ts";
import type {
    DetectInput,
    DiscoverOptions,
    Discovery,
    HandlerMetadata,
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
}

export interface ProcessResult {
    mimetype: string | null;
    preview: string;
    ok: boolean;
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

        let mod: unknown;
        try {
            mod = await this.#loader(info.packageName);
        } catch {
            return null;
        }

        if (typeof mod !== "object" || mod === null) return null;
        const HandlerClass = (mod as { default?: unknown }).default;
        if (typeof HandlerClass !== "function") return null;

        const metadata: HandlerMetadata = {
            mimetype: info.mimetype,
            glyph: info.glyph,
            extensions: info.extensions,
        };
        const Ctor = HandlerClass as new (m: HandlerMetadata) => BaseHandler;
        const handler = new Ctor(metadata);

        this.#handlerInstances.set(mimetype, handler);
        return handler;
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
            return { mimetype: null, preview: "", ok: false };
        }

        // Look up the handler's binary flag before reading content, so we read
        // the file as Uint8Array vs utf-8 string per the handler's expectation.
        const info = this.#discovery!.handlers.get(mimetype) ?? null;
        const isBinary = info?.binary ?? false;

        const content = await this.#resolveContent(input, isBinary);
        if (content === null) {
            return { mimetype, preview: "", ok: false };
        }

        const handler = await this.getHandler(mimetype);
        if (handler === null) {
            return { mimetype, preview: "", ok: false };
        }

        // Validate errors propagate per error policy — caller's contract.
        // Await in case the handler returns a Promise (async validators).
        await handler.validate(content);

        const material = await handler.preview(content);
        const preview = await fitPreview(material, budget, this.#tokenize);

        return { mimetype, preview, ok: true };
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
