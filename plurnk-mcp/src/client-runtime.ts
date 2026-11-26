// {§mcp-module} — Lazy-loaded MCP client SDK, executor, resource scheme, OAuth continuation,
// and skills runtime so daemons without configured MCP servers retain zero MCP client SDK heap (#1578).
export {
    default as ServerConnection,
    AuthorizationRequiredError,
    isClientCredentialsRejection,
} from "./client.ts";
export { SkillVerificationError } from "@modelcontextprotocol/client/ext/skills";
export { computeSkillCommit, fetchVerifiedSkillFiles } from "./skills.ts";
export {
    default as McpExecutor,
    runtimeDecl,
    runtimeDetails,
    runtimeServerSummary,
} from "./McpExecutor.ts";
export { default as McpResources } from "./McpResources.ts";
export { preparationError, unavailableRuntime } from "./attachment-runtime.ts";
export {
    beginOAuth,
    completeOAuth,
    completePromptOrResource,
} from "./continuation.ts";
