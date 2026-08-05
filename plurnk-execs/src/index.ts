import Discover from "./discover.ts";

// Framework surface
export { default as BaseExecutor } from "./BaseExecutor.ts";
export { default as SubprocessExecutor } from "./SubprocessExecutor.ts";
export { default as ErrorDetail, ERROR_DETAIL_LIMIT } from "./ErrorDetail.ts";
export { CommandSyntaxError, tokenizeArgv } from "./tokenizeArgv.ts";
export { default as RuntimeTag } from "./RuntimeTag.ts";

// Discovery ({§executor-discovery}). The behavior lives on `Discover`; the
// documented `discover()` entry is its `scan` static, re-exported here so the
// public contract and the consumer's import stay unchanged.
export const discover = Discover.scan;

// Subtractive runtime policy ({§executor-policy}). `discover()` applies it as the
// daemon boot layer; the consumer reuses the same parser for the per-workspace
// client layer — Policy.enabledAcross(tag, [serviceEnv, clientLayer]) — so the
// cascade is byte-identical at both tiers.
export { default as Policy } from "./policy.ts";

// Legacy public capability contributor. It has no production consumer; #103
// owns whether this surface is removed or becomes the single filtering path.
export { default as Advertise } from "./advertise.ts";

// Universal operation-result helpers. Executors return the same result shape as
// schemes; the consuming daemon validates it at the plugin boundary.
export { Results } from "@plurnk/plurnk-schemes";
export type { ProblemDetails, SchemeResult } from "@plurnk/plurnk-schemes";

// Contract types
export type {
    ChannelState,
    ChannelDecl,
    ExecutorMetadata,
    ExecArgs,
    ExecResult,
    Effect,
    RuntimeAvailability,
    RuntimeDecl,
    RuntimesHook,
    ExecInfo,
    ExecRegistry,
    Discovery,
    DiscoverOptions,
    SpawnArgs,
} from "./types.ts";

// Transient observation contract, re-exported for executor authors.
export type { Notice, NoticeLevel, ContentOffset, LogCoordinate } from "./Notice.ts";
export type {
    PluginAttributionContext,
    PluginAttributionDeclaration,
    PluginAttributionSource,
} from "@plurnk/plurnk-meta";
