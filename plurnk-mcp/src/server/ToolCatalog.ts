// {§mcp-http-server} — Dynamic `mcp:///plurnk.json` tool catalog cache and `McpServer` registration.

import {
    fromJsonSchema,
    type JsonSchemaType,
    type JsonSchemaValidator,
    type McpServer,
    type RegisteredTool,
    type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { Validator, isRecord, type JsonSchema } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { McpCallerClaims, McpRouteTarget } from "./EventBus.ts";

export interface CompiledCatalogToolEntry {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: ReturnType<typeof fromJsonSchema>;
    readonly readOnlyHint?: boolean;
}

interface CachedCatalogTools {
    readonly rawContent: string;
    readonly tools: readonly CompiledCatalogToolEntry[];
}

export type ToolInvokeCallback = (args: {
    readonly target: McpRouteTarget;
    readonly fallbackClaims: McpCallerClaims;
    readonly toolName: string;
    readonly rawArgs: unknown;
    readonly readOnlyHint?: boolean;
    readonly signal?: AbortSignal;
}) => Promise<{
    readonly isError?: boolean;
    readonly _meta?: Record<string, unknown>;
    readonly content: Array<{ readonly type: "text"; readonly text: string }>;
}>;

const plurnkJsonSchemaValidator: jsonSchemaValidator = {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        return (input: unknown) => {
            const result = Validator.validateJsonSchemaInstance(schema, input);
            if (result.valid) {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- schema validation guarantees input satisfies T
                return { valid: true, data: input as T, errorMessage: undefined };
            }
            const errorMessage =
                result.errors
                    .map((err) => `${err.instanceLocation || "/"}: ${err.error}`)
                    .join("; ") || "Invalid arguments";
            return { valid: false, data: undefined, errorMessage };
        };
    },
};

export class CatalogToolCache {
    readonly #cache = new Map<string, CachedCatalogTools>();

    clear(): void {
        this.#cache.clear();
    }

    invalidate(workspaceId: number, sessionId: number | null): void {
        if (sessionId !== null) {
            this.#cache.delete(`${workspaceId}:${sessionId}`);
            return;
        }
        const prefix = `${workspaceId}:`;
        for (const key of [...this.#cache.keys()]) {
            if (key.startsWith(prefix)) {
                this.#cache.delete(key);
            }
        }
    }

    async read(
        seam: ApplicationPort,
        workspaceId: number,
        sessionId: number,
    ): Promise<readonly CompiledCatalogToolEntry[]> {
        const cacheKey = `${workspaceId}:${sessionId}`;
        const catalogRead = await seam.readEntry({
            workspaceId,
            sessionId,
            target: "mcp:///plurnk.json",
        });
        const catalogChannel =
            catalogRead.entry !== null
                ? (catalogRead.entry.channels.body ?? Object.values(catalogRead.entry.channels)[0])
                : undefined;
        if (catalogChannel === undefined || catalogChannel.content.length === 0) {
            this.#cache.delete(cacheKey);
            return [];
        }
        const rawContent = catalogChannel.content;
        const cached = this.#cache.get(cacheKey);
        if (cached !== undefined && cached.rawContent === rawContent) {
            this.#cache.delete(cacheKey);
            this.#cache.set(cacheKey, cached);
            return cached.tools;
        }
        try {
            const parsed: unknown = JSON.parse(rawContent);
            if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
                this.#cache.delete(cacheKey);
                return [];
            }
            const out: CompiledCatalogToolEntry[] = [];
            for (const item of parsed.tools) {
                if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) continue;
                const description =
                    typeof item.description === "string" && item.description.length > 0
                        ? item.description
                        : undefined;
                const baseSchema: JsonSchema = isRecord(item.inputSchema)
                    ? item.inputSchema
                    : { type: "object", additionalProperties: true };
                const schema: JsonSchema =
                    item.name === "send" && isRecord(baseSchema.properties)
                        ? {
                              ...baseSchema,
                              properties: {
                                  ...baseSchema.properties,
                                  actor: {
                                      type: ["string", "object"],
                                      additionalProperties: false,
                                      properties: {
                                          id: { type: "string" },
                                          handle: { type: ["string", "null"] },
                                          name: { type: ["string", "null"] },
                                      },
                                      description:
                                          "Optional exterior actor ID/URI (`<id>`, `mcp://<id>`, `acp://<id>`) or `{ id, handle?, name? }` profile when addressing `session://<name>`.",
                                  },
                              },
                          }
                        : baseSchema;
                const inputSchema = fromJsonSchema(schema as JsonSchemaType, plurnkJsonSchemaValidator);
                const readOnlyHint =
                    isRecord(item.annotations) && item.annotations.readOnlyHint === true ? true : undefined;
                out.push({
                    name: item.name,
                    ...(description !== undefined ? { description } : {}),
                    inputSchema,
                    ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
                });
            }
            const compiled: CachedCatalogTools = { rawContent, tools: out };
            this.#cache.set(cacheKey, compiled);
            if (this.#cache.size > 256) {
                const oldest = this.#cache.keys().next().value;
                if (oldest !== undefined) this.#cache.delete(oldest);
            }
            return out;
        } catch {
            this.#cache.delete(cacheKey);
            return [];
        }
    }

    async syncServerTools(args: {
        readonly seam: ApplicationPort;
        readonly server: McpServer;
        readonly target: McpRouteTarget;
        readonly fallbackClaims: McpCallerClaims;
        readonly invokeTool: ToolInvokeCallback;
        readonly registry?: Map<string, RegisteredTool>;
    }): Promise<void> {
        const { seam, server, target, fallbackClaims, invokeTool, registry } = args;
        const tools = await this.read(seam, target.workspaceId, target.sessionId);
        if (registry !== undefined) {
            const nextNames = new Set(tools.map((tool) => tool.name));
            for (const [name, handle] of [...registry.entries()]) {
                if (!nextNames.has(name)) {
                    handle.remove();
                    registry.delete(name);
                }
            }
        }
        for (const tool of tools) {
            const existing = registry?.get(tool.name);
            if (existing !== undefined) {
                existing.update({
                    description: tool.description,
                    paramsSchema: tool.inputSchema,
                    callback: async (rawArgs: unknown, extra: { mcpReq: { signal?: AbortSignal } }) =>
                        invokeTool({
                            target,
                            fallbackClaims,
                            toolName: tool.name,
                            rawArgs,
                            readOnlyHint: tool.readOnlyHint,
                            signal: extra.mcpReq.signal,
                        }),
                });
                continue;
            }
            const registered = server.registerTool(
                tool.name,
                {
                    ...(tool.description !== undefined ? { description: tool.description } : {}),
                    inputSchema: tool.inputSchema,
                },
                async (rawArgs, extra) =>
                    invokeTool({
                        target,
                        fallbackClaims,
                        toolName: tool.name,
                        rawArgs,
                        readOnlyHint: tool.readOnlyHint,
                        signal: extra.mcpReq.signal,
                    }),
            );
            registry?.set(tool.name, registered);
        }
    }
}
