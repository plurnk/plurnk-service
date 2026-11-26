// {§mimetype-lifecycle} {§mimetype-query} — Lightweight runtime orchestrator,
// coordinate, classification, and text-query subpath. Defers structural parser
// toolkits (json-p3, @xmldom/xmldom, xpath, web-tree-sitter) until invoked (#1578).
export { default as BaseHandler, type HandlerContent } from "./BaseHandler.ts";
export { default as Mimetypes, binaryInputMaximum } from "./Mimetypes.ts";
export { projectJsonToXml, PK_PREFIX, PK_NS, type ProjectLineFor } from "./projectJsonToXml.ts";
export { default as MimetypeExtensionError } from "./MimetypeExtensionError.ts";
export { default as MimetypeDerivationError } from "./MimetypeDerivationError.ts";
export { default as MimetypeInputError, isMimetypeInputError } from "./MimetypeInputError.ts";
export { default as MimetypeInputLimitError } from "./MimetypeInputLimitError.ts";
export { default as TextCoordinates } from "./TextCoordinates.ts";
export type { TextLine, TextPosition } from "./TextCoordinates.ts";
export type { TextRegion } from "@plurnk/plurnk-contracts";
export type {
    Channel,
    HandlerLoader,
    MimetypesOptions,
    ProcessInput,
    ProcessOptions,
    ProcessResult,
    ReadableProjection,
} from "./Mimetypes.ts";
export { detect, emptyRegistry } from "./detect.ts";
export { discover } from "./discover.ts";
export { parseBodyMatcher } from "./parseBodyMatcher.ts";
export type { ParsedBodyMatcher } from "./parseBodyMatcher.ts";
export { globToRegex, queryGlob, queryRegex } from "./query-text.ts";
export {
    InvalidExpressionError,
    QueryParseFailureError,
    UnsupportedDialectError,
} from "./QueryError.ts";
export { classifyMimetype } from "./classify.ts";
export type { MimeClassification } from "./classify.ts";
export type {
    ContentOffset,
    LogCoordinate,
    Notice,
    NoticeLevel,
} from "./Notice.ts";
export type {
    DetectInput,
    Discovery,
    DiscoverOptions,
    HandlerInfo,
    HandlerMetadata,
    LineSpan,
    MimeRef,
    MimeSymbol,
    MimetypeDisplayMetadata,
    QueryDialect,
    QueryMatch,
    RefKind,
    Registry,
    SymbolKind,
} from "./types.ts";
