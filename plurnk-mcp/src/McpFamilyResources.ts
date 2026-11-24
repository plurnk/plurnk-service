import type { FunctionalityFamilyHandle } from "@plurnk/plurnk-contracts";
import { FunctionalityResourceFacet } from "@plurnk/plurnk-schemes";

const OWNER = "mcp:resource";

const aliasOfPathname = (pathname: string): string | null => {
    const rest = pathname.startsWith("/servers/")
        ? pathname.slice("/servers/".length)
        : pathname.startsWith("/")
            ? pathname.slice(1)
            : "";
    if (rest.length === 0 || rest === "servers" || rest.includes("/")) return null;
    try {
        return decodeURIComponent(rest);
    } catch {
        return null;
    }
};

// {§mcp-module} MCP server definition resources (`mcp:///servers/<alias>`).
export default class McpFamilyResources extends FunctionalityResourceFacet {
    constructor(handle: () => FunctionalityFamilyHandle) {
        super({
            owner: OWNER,
            scheme: "mcp",
            handle,
            manifest: {
                channels: { results: "application/json" },
                defaultChannel: "results",
                writableBy: ["model", "client"],
            },
            claims: (pathname) => {
                if (pathname.endsWith(".md") || pathname.endsWith(".json")) return false;
                return /^\/(?:servers(?:\/|$)|[^/]+$)/u.test(pathname);
            },
            aliasFromPathname: aliasOfPathname,
            pathnameOfAlias: (alias) => `/servers/${encodeURIComponent(alias)}`,
            authorityDetail: "MCP server resources use an empty authority.",
            notFoundDetail: "The MCP server resource does not exist.",
            wholeEditDetail: "One edit sets one MCP server definition, whole.",
            wholeKillDetail: "kill retires the whole MCP server definition.",
            invalidTarget: {
                code: "target-required",
                detail: "The operation needs an mcp:///servers/<alias> target.",
            },
            toEditInvocation: FunctionalityResourceFacet.jsonReplaceInvocation(
                OWNER,
                "The MCP server definition body must be a JSON object.",
            ),
        });
    }
}
