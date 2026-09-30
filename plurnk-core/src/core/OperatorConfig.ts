import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtempDisposable, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type HostPaths from "./HostPaths.ts";

const exists = async (path: string): Promise<boolean> => access(path, constants.F_OK)
    .then(() => true)
    .catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return false;
        throw cause;
    });

// {§operator-config-discovery} — the user owns this one ordinary dotenv file.
// Package defaults remain package-owned and are projected on demand.
export default class OperatorConfig {
    // {§agui-http-authorization} — a daemon is one trust domain, and on loopback the operator's own
    // browser is inside it: any page they visit can POST to the port. The bearer is the perimeter,
    // so a fresh install mints one instead of shipping the empty value that means "no check". It
    // lands in the same file the client reads through the same cascade, so a default install keeps
    // working untouched; an operator who wants no perimeter empties the line themselves.
    static #mintToken(): string {
        return randomBytes(32).toString("base64url");
    }

    static renderSeed(token = OperatorConfig.#mintToken()): string {
        return [
            "# Plurnk user configuration. This file is yours and is never overwritten.",
            "# Full installed options: plurnk-service config defaults",
            "# Validate this cascade: plurnk-service config check",
            "#",
            "# The bearer every client presents to this daemon, minted for this install. Anything",
            "# that can reach the port can drive the daemon, so emptying this removes the perimeter.",
            `PLURNK_AGUI_TOKEN=${token}`,
            "",
            "# Choose one model profile by uncommenting its complete block.",
            "",
            "# OPENROUTER — bring any supported OpenRouter model.",
            "# PLURNK_MODEL_openrouter=\"openrouter/qwen/qwen3-coder\"",
            "# OPENROUTER_API_KEY=\"...\"",
            "# PLURNK_MODEL=openrouter",
            "",
            "# LOCAL — an OpenAI-compatible llama-server; your own GBNF grammar is optional.",
            "# PLURNK_MODEL_local=\"openai/qwen\"",
            "# PLURNK_BASEURL_local=http://127.0.0.1:8080/v1",
            "# PLURNK_PROVIDERS_GBNF_local=~/.config/plurnk/local.gbnf",
            "# PLURNK_MODEL=local",
            "",
            "# AGENT SKILLS — project skills live in .agents/skills, plurnk-only skills in",
            "# $XDG_CONFIG_HOME/plurnk/skills, and user-global skills in ~/.agents/skills.",
            "# Add them per Worker with /skills (clients) or the skills executor (model)",
            "# from a git URL, a folder, a SKILL.md, or a zip or tar archive.",
            "",
            "# MCP SERVERS — complete definitions; declared servers are enabled unless explicitly disabled.",
            "# /mcp add saves a workspace definition, without installing a plugin or rewriting this file.",
            "# PLURNK_MCP_brave={\"name\":\"brave\",\"type\":\"stdio\",\"command\":\"npx\",\"args\":[\"-y\",\"@brave/brave-search-mcp-server@2.1.0\"]}",
            "# PLURNK_MCP_brave_TOOLS=[\"brave_web_search\",\"brave_news_search\"]",
            "# PLURNK_MCP_brave_ENABLED=0",
            "# File membership definitions ride the same shape ({§members-configuration}):",
            "# PLURNK_MEMBERS_docs=docs/**",
            "# PLURNK_MEMBERS_no_locks=!**/*.lock",
            "# PLURNK_MEMBERS_no_locks_ENABLED=0",
            "",
            "# OPTIONAL TAVILY HTML MATERIALIZATION — the plugin ships with the service;",
            "# uncomment both lines to select it.",
            "# TAVILY_API_KEY=\"...\"",
            "# PLURNK_SCHEMES_HTTP_MATERIALIZER=tavily-extract",
            "",
        ].join("\n");
    }

    static async ensure(paths: HostPaths, policySource: string): Promise<boolean> {
        if (await exists(paths.configDir)) return false;
        const policy = await readFile(policySource, "utf8");
        await mkdir(dirname(paths.configDir), { recursive: true, mode: 0o700 });
        await using stage = await mkdtempDisposable(join(dirname(paths.configDir), `.${basename(paths.configDir)}-`));
        await writeFile(join(stage.path, basename(paths.configFile)), OperatorConfig.renderSeed(), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await writeFile(join(stage.path, basename(paths.policyFile)), policy, { encoding: "utf8", flag: "wx", mode: 0o600 });
        // {§operator-config-discovery}: only a complete seed becomes visible.
        try {
            await rename(stage.path, paths.configDir);
        } catch (cause) {
            const code = (cause as NodeJS.ErrnoException).code;
            if (code === "EEXIST" || code === "ENOTEMPTY") return false;
            throw cause;
        }
        return true;
    }
}
