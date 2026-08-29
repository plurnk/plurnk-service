// Top-level orchestrator
export { default as Mimetypes } from "./Mimetypes.ts";
export { default as MimetypePluginError } from "./MimetypePluginError.ts";
export { default as MimetypeInputError, isMimetypeInputError } from "./MimetypeInputError.ts";
export { default as MimetypeInputLimitError } from "./MimetypeInputLimitError.ts";
export { default as TextCoordinates } from "./TextCoordinates.ts";
export type { TextLine, TextPosition } from "./TextCoordinates.ts";
export { default as EmbeddingVector } from "./EmbeddingVector.ts";
export {
    default as ParserCoordinates,
    isParserCoordinateError,
    materializeTreeSitterSymbols,
    ParserCoordinateError,
    treeSitterSpan,
} from "./ParserCoordinates.ts";
export type {
    TreeSitterEndBoundary,
    TreeSitterPoint,
    TreeSitterSourceNode,
    TreeSitterSpan,
    TreeSitterSymbolProjection,
} from "./ParserCoordinates.ts";
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

// Base classes for handler authors
export { default as BaseHandler } from "./BaseHandler.ts";
export { default } from "./BaseHandler.ts";
export { default as AntlrExtractor } from "./AntlrExtractor.ts";
export { default as TreeSitterExtractor } from "./TreeSitterExtractor.ts";
export type {
    DeepTreeNode,
    QueryConstructor,
    TreeSitterTree,
    TreeSitterNode,
    TreeSitterParser,
} from "./TreeSitterExtractor.ts";
export { walkDeepNode } from "./TreeSitterExtractor.ts";
export { withExtractor } from "./withExtractor.ts";
export type { HandlerContent } from "./BaseHandler.ts";
export type {
    PluginAttributionContext,
    PluginAttributionDeclaration,
    PluginAttributionSource,
} from "@plurnk/plurnk-meta";

// Detection + discovery
export { detect, emptyRegistry } from "./detect.ts";
export { discover } from "./discover.ts";

// Outline formatting (tree-building + rendering primitives)
export {
    buildTree,
    format,
    maxDepth,
    pruneToMaxDepth,
    renderTree,
} from "./format.ts";
export type { TreeNode } from "./format.ts";

// Body-matcher query (parseBodyMatcher + per-dialect primitives + the bare-
// leaves outline builder + error classes). Used by handler authors building
// custom dialect overrides.
export { parseBodyMatcher } from "./parseBodyMatcher.ts";
export type { ParsedBodyMatcher } from "./parseBodyMatcher.ts";
export { buildJsonOutline } from "./buildJsonOutline.ts";
export type { JsonOutline } from "./buildJsonOutline.ts";
export {
    globToRegex,
    queryGlob,
    queryJsonpathObject,
    queryRegex,
    queryXpathString,
    regionsForLineSpans,
} from "./query.ts";
export { projectJsonToXml } from "./projectJsonToXml.ts";
export {
    InvalidExpressionError,
    QueryParseFailureError,
    UnsupportedDialectError,
} from "./QueryError.ts";
export { GrammarNotInstalledError } from "./treesitter/handler.ts";

// Shared references engine for dedicated handler packages
// ({§mimetype-references}).
export { collectReferences } from "./treesitter/refsEngine.ts";
export type { RefsCaptureNode, RefsQuery, RefsQueryCapture } from "./treesitter/refsEngine.ts";
export type {
    ContentOffset,
    LogCoordinate,
    Notice,
    NoticeLevel,
} from "./Notice.ts";

// Registry-free half of {§mimetype-classification}.
export { classifyMimetype } from "./classify.ts";
export type { MimeClassification } from "./classify.ts";

// Public embedding seam types ({§mimetype-embedding}).
export type {
    EmbedderInfo,
    EmbedProgress,
    EmbedDocumentsOptions,
    EmbedDocumentsResult,
    EmbedQueryOptions,
    EmbedQueryResult,
    EmbeddingCallMetadata,
} from "./Embeddings.ts";

// Public tokenizer seam types ({§mimetype-tokenizer}).
export type { TokenCountOptions, TokenizerResolution } from "./Tokenizers.ts";

// Grammar compilation utilities (for handler authors building their own pipeline)
export { injectBaseImports, rewriteImports, runCompile } from "./compile.ts";
export type { CompileOptions } from "./compile.ts";

// Public types
export type {
    DetectInput,
    Discovery,
    DiscoveryResult,
    DiscoverOptions,
    ExtractionVisitor,
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
