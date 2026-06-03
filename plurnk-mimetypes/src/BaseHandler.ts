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
