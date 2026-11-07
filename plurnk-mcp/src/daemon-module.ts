// {§mcp-module} {§mcp-http-server} {§module-contract} — this package's daemon module entry ({§module-lifecycle}):
// the interior MCP family adapter and the exterior `/mcp` Streamable HTTP server module.
import McpServerModule from "./McpServerModule.ts";
import Module from "./Module.ts";

export default (): readonly [Module, McpServerModule] => [Module.init(), McpServerModule.create()];
