// {§text-region} — the package root: validators, Problems and generated types. The schemas
// themselves are published at `./schema/*.json`, never re-exported here as values.
export {
    default as Validator,
    InvalidOperationResultError,
    InvalidProblemDetailsError,
} from "./Validator.ts";
export { default as Problems } from "./Problems.ts";
export { errnoCode, isRecord, isSafeInteger } from "./guards.ts";
export type { MessageResource, MessageResourceReceipt, MessageEvidence, ApplicationMessage, ApplicationInboxMessage } from "./MessageResource.ts";
export type { ApplicationStream, ApplicationStreamChannel } from "./ApplicationStream.ts";
export { lifecycleOfLoopStatus, selectSessionLoop, type LoopLifecycle } from "./LoopLifecycle.ts";
export { excerptOf } from "./Excerpt.ts";
export type { ProblemOptions, ProblemProjectionContext } from "./Problems.ts";
export type { ValidationResult } from "./Validator.ts";
export { default as PlurnkParseError } from "./PlurnkParseError.ts";
export { default as PathSyntax } from "./PathSyntax.ts";
export { default as TurnDisposition } from "./TurnDisposition.ts";
export { renderJsonResult } from "./JsonResult.ts";
export { formatJsonDocument } from "./JsonDocument.ts";
export type { JsonReplacer } from "./JsonResult.ts";
export {
    admitBearerRequest,
    admitBrowserOrigin,
    buildCorsHeaders,
    isLoopbackHost,
    parseScopedRoute,
    requestOrigin,
    resolvePublicOrigin,
} from "./HttpOrigin.ts";
export type {
    BearerAdmission,
    BearerAdmissionOptions,
    BrowserOriginAdmission,
    BrowserOriginOptions,
    CorsHeaderOptions,
    RequestHeaders,
    ScopedRouteOptions,
    ScopedRouteParseResult,
} from "./HttpOrigin.ts";
export {
    actorsMatch,
    extractActor,
    isDefaultExteriorActor,
    parseExteriorActor,
    type ExteriorActor,
    type ExteriorActorScheme,
} from "./ActorIdentity.ts";
export {
    LOG_ENTRY_KINDS,
    addressOf,
    isLogEntryKind,
    toolKindOf,
    type LogAddressColumns,
    type LogEntryKind,
    type ProposalToolKind,
} from "./LogRow.ts";
export {
    APPLICATION_RUNTIME_STREAM_EVENTS,
    DAEMON_NOTIFICATION_EVENTS,
    isApplicationRuntimeStreamEvent,
    isDaemonNotificationEvent,
    isRuntimeTelemetryNotice,
    matchesNotificationFilter,
    toDaemonNotification,
    type ApplicationNotificationContract,
    type ApplicationRuntimeStreamEvent,
    type ApplicationRuntimeStreamHandler,
    type ApplicationRuntimeStreamPayloadMap,
    type DaemonNotification,
    type DaemonNotificationEvent,
    type DaemonNotificationPayloadMap,
    type FunctionalityChangedNotification,
    type LogEntryNotification,
    type LoopGateSettledNotification,
    type LoopInteractionNotification,
    type LoopPacketNotification,
    type LoopParkedNotification,
    type LoopStartedNotification,
    type NoticeEventNotification,
    type NotificationFilter,
    type NotificationReplayResult,
    type NotificationsResyncPayload,
    type ProposalNotification,
    type ReasoningEventNotification,
    type SessionArchivedNotification,
    type SessionCreatedNotification,
    type SessionDeletedNotification,
    type SessionPolicyNotification,
    type SessionTitledNotification,
    type StreamConcludedNotification,
    type StreamEventNotification,
    type TerminatedNotification,
    type WorkspaceArchivedNotification,
    type WorkspaceCreatedNotification,
    type WorkspacePreparationNotification,
    type WorkspaceRenamedNotification,
} from "./ApplicationNotifications.ts";
// {§whitespace-contract} The application port is Node-bound and is its own entry, `@plurnk/plurnk-contracts/port`.
export {
    expandLearnCommand,
    formatFamilyResult,
    formatFamilyRows,
    formatServiceUpdateReport,
    parseFamilyCommand,
} from "./Application.ts";
export {
    SCHEDULE_ADD_FLAGS,
    SCHEDULE_USAGE,
    extractScheduleProblem,
    formatScheduleInspect,
    formatScheduleStepReceipts,
    tokenizeSlashArgs,
    type ScheduleRunResult,
    type ScheduleStatus,
    type ScheduledStepReceipt,
    type ScheduledToolCall,
} from "./ScheduleCommand.ts";
export {
    FAMILY_SUBCOMMANDS_BY_FAMILY,
    INTERACTIVE_COMMANDS,
    buildPromptBlocks,
    classifyComposerInput,
    completeInteractiveCommand,
    longestCommonPrefix,
} from "./InteractiveCommands.ts";
export {
    SingleFlightRefresh,
    buildAuthorizationServerMetadataUrls,
    discoverAuthorizationServerMetadata,
    discoverProtectedResourceMetadata,
    generatePkcePair,
    isAllowedOAuthUrl,
    parseJwtExpiresAt,
    parseWwwAuthenticateResourceMetadata,
    resolveTokenExpiresAt,
    type AuthorizationServerMetadata,
    type PkcePair,
    type ProtectedResourceMetadata,
} from "./OAuthClient.ts";
export {
    flattenConfigSelectOptions,
    formatProblemSummary,
    parseSessionConfigOptions,
    projectSessionStatus,
    rankModelChoices,
    summarizeOperation,
    type FlatConfigSelectOption,
    type ModelChoiceCandidate,
    type OperationSummary,
    type ParsedConfigOption,
    type ParsedSessionConfigOptions,
    type ProjectedSessionStatus,
    type SessionPhase,
    type SessionStatusInput,
} from "./SessionProjection.ts";
export type * from "./InteractiveCommands.ts";
export type * from "./Application.ts";
export type * from "./Functionality.ts";

export { PLURNK_OPS, PROPOSAL_POLICIES, RUNTIME_TAG, INTERNAL_ROW_OPS, isExecution, isExecutionOp, isPlurnkOp, writtenOp, EFFORTS, SESSION_NAME, SKILL_NAME, UNKNOWN_POSITION, MAX_TIMER_MS } from "./types.ts";
export { MCP_WIRE_TOOL, type McpWireToolDefinition } from "./McpWireTool.ts";
export type * from "./types.ts";
export type { ErrorSource, Severity } from "./PlurnkParseError.ts";
