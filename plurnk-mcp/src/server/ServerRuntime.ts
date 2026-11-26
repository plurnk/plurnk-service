// {§mcp-http-server} — Lazy-loaded `@modelcontextprotocol/server` runtime bundle
// so booting a daemon with no `/mcp` traffic retains zero MCP server SDK heap (#1578).
export {
    McpServer,
    WebStandardStreamableHTTPServerTransport,
    createMcpHandler,
    isLegacyRequest,
} from "@modelcontextprotocol/server";
export { registerMcpResources } from "./ResourceSurface.ts";
export { CatalogToolCache } from "./ToolCatalog.ts";
