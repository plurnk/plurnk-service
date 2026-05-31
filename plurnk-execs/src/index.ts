// Framework surface
export { default as BaseExecutor } from "./BaseExecutor.ts";
export { default as SubprocessExecutor } from "./SubprocessExecutor.ts";
export { discover } from "./discover.ts";

// Runtime-tag → spawn-args helper (subprocess family; legacy scheme path)
export { KNOWN_RUNTIMES, isKnownRuntime, resolveRuntime } from "./runtime.ts";

// Contract types
export type {
    ChannelState,
    ChannelDecl,
    ExecutorMetadata,
    ExecArgs,
    ExecResult,
    ExecInfo,
    ExecRegistry,
    Discovery,
    DiscoverOptions,
    SpawnArgs,
    RuntimeResolver,
} from "./types.ts";

// Telemetry envelope (local mirror of grammar's TelemetryEvent schema)
export type { TelemetryEvent, ContentOffset, LogCoordinate } from "./TelemetryEvent.ts";
