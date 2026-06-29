import Discover from "./discover.ts";
import Runtime from "./runtime.ts";

// Framework surface
export { default as BaseExecutor } from "./BaseExecutor.ts";
export { default as SubprocessExecutor } from "./SubprocessExecutor.ts";

// Discovery (SPEC §3). The behavior lives on the `Discover` class; the
// documented `discover()` entry is its `scan` static, re-exported here so the
// public contract and the consumer's import stay unchanged.
export const discover = Discover.scan;

// Runtime-tag → spawn-args helper (subprocess family; legacy scheme path,
// SPEC §4). Same shape: behavior on the `Runtime` class, the documented
// function/constant names re-exported over its statics.
export const KNOWN_RUNTIMES = Runtime.KNOWN;
export const isKnownRuntime = Runtime.isKnown;
export const resolveRuntime = Runtime.resolve;

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
    RuntimeResolver,
} from "./types.ts";

// Telemetry envelope (local mirror of grammar's TelemetryEvent schema)
export type { TelemetryEvent, ContentOffset, LogCoordinate } from "./TelemetryEvent.ts";
