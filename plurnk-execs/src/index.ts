import Discover from "./discover.ts";

// Framework surface
export { default as BaseExecutor } from "./BaseExecutor.ts";
export { default as SubprocessExecutor } from "./SubprocessExecutor.ts";

// Discovery (SPEC §3). The behavior lives on the `Discover` class; the
// documented `discover()` entry is its `scan` static, re-exported here so the
// public contract and the consumer's import stay unchanged.
export const discover = Discover.scan;

// Runtime enable/disable policy (SPEC §3.3). `discover()` applies it as the
// daemon boot layer; the consumer reuses the same parser for the per-workspace
// client layer — Policy.enabledAcross(tag, [serviceEnv, clientLayer]) — so the
// cascade is byte-identical at both tiers.
export { default as Policy } from "./policy.ts";

// The EXEC family's per-loop capability contribution (SPEC §3.4). Turns a zero
// count of permitted runtimes into a single legible "No EXEC operations
// permitted" line instead of silent absence, which the model reads as unknown
// availability and fills by confabulating runtimes (execs#24).
export { default as Advertise } from "./advertise.ts";

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

// Telemetry envelope (local mirror of grammar's TelemetryEvent schema)
export type { TelemetryEvent, ContentOffset, LogCoordinate } from "./TelemetryEvent.ts";
