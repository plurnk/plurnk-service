import { buildJsonOutline } from "./buildJsonOutline.ts";
import { format } from "./format.ts";
import { queryGlob, queryJsonpathObject, queryRegex } from "./query.ts";
import { UnsupportedDialectError } from "./QueryError.ts";
import type {
    HandlerMetadata,
    MimeSymbol,
    Preview,
    QueryDialect,
    QueryMatch,
} from "./types.ts";

// Content shape that handler methods accept. Text mimetypes receive `string`;
// binary mimetypes (PDF, images, archives) receive `Uint8Array`. Handlers
// signal which via `plurnk.binary: true` in their package.json. The framework
// reads files (or routes inline content) to the appropriate shape per handler.
export type HandlerContent = string | Uint8Array;

// Base class for mimetype handlers. Subclasses author preview policy by
// overriding `preview(content)` (and `validate(content)` when the mimetype
// has a real syntax check). The framework owns budget math and tokenization
// entirely — handlers never see budget or tokenize values.
//
// Diagnostic access (extractRaw, symbolsRaw) is available via getHandler()
// for consumers needing the unbudgeted structural data. Naming intentionally
// signals "Plan B" — the canonical interface is `Mimetypes.process` which
// returns the framework-fitted preview.
export default class BaseHandler {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];

    constructor(metadata: HandlerMetadata) {
        this.mimetype = metadata.mimetype;
        this.glyph = metadata.glyph;
        this.extensions = Object.freeze([...metadata.extensions]);
    }

    // Raw structural extraction. Default returns []. Subclasses override for
    // mimetypes with structural content. Return type is a union so synchronous
    // handlers (AntlrExtractor, hand-rolled scanners) stay correct without
    // ceremony; tree-sitter-backed handlers return a Promise to honor WASM
    // grammar init. Consumers must `await` unconditionally.
    extractRaw(_content: HandlerContent): MimeSymbol[] | Promise<MimeSymbol[]> {
        return [];
    }

    // Full structural tree used as the jsonpath query target by the framework's
    // deep-channel pipeline (issue #10). The framework projects the returned
    // value to deep-xml via projectJsonToXml() — handlers never write XML
    // serialization logic. Returns null when the handler has no faithful tree
    // to expose (default).
    //
    // Per-algebra conventions:
    //   - tree-sitter handlers: full named-children walk of the AST, native
    //     node types. TreeSitterExtractor provides a default walker.
    //   - JSON / YAML / TOML / CSV: the parsed value directly.
    //   - HTML / XML / SVG: the parsed DOM serialized as nested objects.
    //   - Markdown: the markdown AST.
    //   - ANTLR / hand-rolled: handler authors as appropriate.
    deepJson(_content: HandlerContent): unknown | Promise<unknown> {
        return null;
    }

    // Addressable extent of the content in the unit the model navigates by
    // (issue #9). For text content the default is line count; binary content
    // returns 0 (the handler should override with a meaningful unit like
    // pages for PDF, items for structured archives). Surfaced on
    // ProcessResult so index tiles can hand the model navigation bounds.
    extent(content: HandlerContent): number | Promise<number> {
        if (typeof content !== "string") return 0;
        return countLines(content);
    }

    // Throw on malformed content. Default no-op. Sync or async; the framework
    // awaits the result either way.
    validate(_content: HandlerContent): void | Promise<void> {
        // Default: anything is valid.
    }

    // Unbudgeted structural rendering — `format(await extractRaw(content))`
    // by default. Diagnostic access; not the primary surface (see preview).
    async symbolsRaw(content: HandlerContent): Promise<string> {
        return format(await this.extractRaw(content));
    }

    // The handler's preview policy. Returns:
    //   - SymbolPreview: structural outline (framework fits via fit())
    //   - null:          no preview (handler explicitly declines)
    //
    // Default: SymbolPreview wrapping awaited extractRaw output. Handlers whose
    // structure isn't reachable through extractRaw (notably async ones like
    // application-pdf) override preview directly. Return type stays a union
    // so sync handlers can return Preview directly without ceremony; the
    // default impl is async to handle async extractRaw transparently.
    preview(content: HandlerContent): Preview | Promise<Preview> {
        const raw = this.extractRaw(content);
        if (raw instanceof Promise) {
            return raw.then((symbols) => ({ kind: "symbols" as const, symbols }));
        }
        return { kind: "symbols", symbols: raw };
    }

    // Body-matcher query. Plurnk-service calls this through Mimetypes.query
    // with a dialect + pattern parsed from the matcher expression's leading
    // prefix (see parseBodyMatcher).
    //
    // Defaults:
    //   - regex/glob: apply against decoded text content (toText). Subclasses
    //     with binary content override toText to provide a text projection
    //     (e.g. PDF returns extracted page text).
    //   - jsonpath: apply against the bare-leaves outline tree built from
    //     extractRaw. Mimetypes with native JSON-shaped content (JSON, YAML,
    //     TOML, CSV) override to apply against the parsed value instead.
    //   - xpath: throws UnsupportedDialectError. text-html overrides to apply
    //     against the parsed DOM.
    async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        switch (dialect) {
            case "regex": {
                const text = await this.toText(content);
                return queryRegex(text, pattern, flags);
            }
            case "glob": {
                const text = await this.toText(content);
                return queryGlob(text, pattern);
            }
            case "jsonpath": {
                // Per issue #10: jsonpath dispatches against the deep-json
                // channel, not the bare-leaves symbols outline. Handlers that
                // implement deepJson() (most should, post-#10) get full-tree
                // reach. Handlers that haven't migrated yet fall back to the
                // outline so existing queries keep working through the
                // transition. The fallback should disappear once every handler
                // supplies a deep-json shape appropriate to its algebra.
                const tree = await this.deepJson(content);
                if (tree !== null && tree !== undefined) {
                    return queryJsonpathObject(tree, pattern);
                }
                const outline = buildJsonOutline(await this.extractRaw(content));
                return queryJsonpathObject(outline, pattern);
            }
            case "xpath":
                throw new UnsupportedDialectError({
                    mimetype: this.mimetype,
                    dialect: "xpath",
                    reason: "no xpath projection for this mimetype",
                });
        }
    }

    // Provide a text projection for regex/glob queries. Default: pass through
    // for string content; throw for binary. Subclasses with binary content
    // (PDF, future image OCR) override to extract a readable representation.
    protected toText(content: HandlerContent): string | Promise<string> {
        if (typeof content === "string") return content;
        throw new UnsupportedDialectError({
            mimetype: this.mimetype,
            dialect: "regex",
            reason: "binary content has no text projection for this mimetype",
        });
    }
}

// Editor-convention line count. `abc\ndef` → 2; `abc\ndef\n` → 2 (trailing
// newline is a terminator, not a new line); empty string → 0. Mirrors the
// computation in Mimetypes.ts; lives here so the default extent() can use it
// without importing the orchestrator.
function countLines(text: string): number {
    if (text.length === 0) return 0;
    let newlines = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 0x0a) newlines += 1;
    }
    return text.charCodeAt(text.length - 1) === 0x0a ? newlines : newlines + 1;
}
