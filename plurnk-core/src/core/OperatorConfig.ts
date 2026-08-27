import { constants } from "node:fs";
import { access, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import type HostPaths from "./HostPaths.ts";

const exists = async (path: string): Promise<boolean> => access(path, constants.F_OK)
    .then(() => true)
    .catch(() => false);

// {§operator-config-discovery} — the user owns this one ordinary dotenv file.
// Package defaults remain package-owned and are projected on demand.
export default class OperatorConfig {
    static renderSeed(): string {
        return [
            "# Plurnk user configuration. This file is yours and is never overwritten.",
            "# Full installed options: plurnk-service config defaults",
            "# Validate this cascade: plurnk-service config check",
            "#",
            "# Choose one model profile by uncommenting its complete block.",
            "",
            "# PLURNK.AI — the proprietary Plurnk endpoint.",
            "# PLURNK_MODEL_plurnk=\"plurnk/plurnk\"",
            "# PLURNK_API_KEY=\"...\"",
            "# PLURNK_MODEL=plurnk",
            "",
            "# OPENROUTER — bring any supported OpenRouter model.",
            "# PLURNK_MODEL_openrouter=\"openrouter/qwen/qwen3-coder\"",
            "# OPENROUTER_API_KEY=\"...\"",
            "# PLURNK_MODEL=openrouter",
            "",
            "# LOCAL QWEN — an OpenAI-compatible llama-server with the Qwen GBNF rail.",
            "# PLURNK_MODEL_local=\"openai/qwen\"",
            "# PLURNK_BASEURL_local=http://127.0.0.1:8080/v1",
            "# PLURNK_PROVIDERS_GBNF_local=plurnk.qwen.gbnf",
            "# PLURNK_MODEL=local",
            "",
            "# AGENT SKILLS — project skills live in .agents/skills; user-global skills",
            "# live in ~/.agents/skills. Manage them per Worker with /skills (clients) or",
            "# EXEC [skills] (model). Optional overrides of the standard machinery:",
            "# PLURNK_SERVICE_SKILLS_CLI=\"npx --yes skills\"",
            "# PLURNK_SERVICE_SKILLS_REGISTRY_URL=https://skills.sh",
            "",
            "# OPTIONAL BRAVE SEARCH MCP — uncomment the complete block and provide the key.",
            "# BRAVE_API_KEY=\"...\"",
            "# PLURNK_MCP_BRAVE=npx",
            "# PLURNK_MCP_BRAVE_ARGS=[\"-y\",\"@brave/brave-search-mcp-server@2.1.0\"]",
            "# PLURNK_MCP_BRAVE_ENV={\"BRAVE_API_KEY\":\"${BRAVE_API_KEY}\"}",
            "# PLURNK_MCP_BRAVE_TOOLS=[\"brave_web_search\",\"brave_news_search\"]",
            "# PLURNK_MCP_BRAVE_READ=[\"brave_web_search\",\"brave_news_search\"]",
            "# PLURNK_MCP_ENABLED=[\"brave\"]",
            "# File membership definitions ride the same shape ({§members-configuration}):",
            "# PLURNK_MEMBERS_DOCS=docs/**",
            "# PLURNK_MEMBERS_NO_LOCKS=!**/*.lock",
            "# PLURNK_MEMBERS_ENABLED=[\"docs\"]",
            "",
            "# OPTIONAL TAVILY HTML MATERIALIZATION — install",
            "# @plurnk/plurnk-schemes-http-tavily, then uncomment both lines.",
            "# TAVILY_API_KEY=\"...\"",
            "# PLURNK_SCHEMES_HTTP_MATERIALIZER=tavily-extract",
            "",
        ].join("\n");
    }

    static async ensure(paths: HostPaths, policySource: string): Promise<boolean> {
        if (await exists(paths.configDir)) return false;
        const policy = await readFile(policySource, "utf8");
        const firstCreated = await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
        const createdFiles: string[] = [];
        try {
            await writeFile(paths.configFile, OperatorConfig.renderSeed(), { encoding: "utf8", flag: "wx", mode: 0o600 });
            createdFiles.push(paths.configFile);
            await writeFile(paths.policyFile, policy, { encoding: "utf8", flag: "wx", mode: 0o600 });
            createdFiles.push(paths.policyFile);
            return true;
        } catch (cause) {
            const rollbackErrors: unknown[] = [];
            for (const file of createdFiles.toReversed()) {
                try { await unlink(file); }
                catch (rollbackCause) {
                    if ((rollbackCause as NodeJS.ErrnoException).code !== "ENOENT") rollbackErrors.push(rollbackCause);
                }
            }
            if (firstCreated !== undefined) {
                try { await rmdir(paths.configDir); }
                catch (rollbackCause) {
                    if ((rollbackCause as NodeJS.ErrnoException).code !== "ENOENT") rollbackErrors.push(rollbackCause);
                }
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError([cause, ...rollbackErrors], "operator config bootstrap failed and rollback was incomplete");
            }
            throw cause;
        }
    }
}
