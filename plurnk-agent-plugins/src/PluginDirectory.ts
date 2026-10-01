import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SkillDirectory } from "@plurnk/plurnk-agent-skills";
import { AgentPluginFiles, expandPlaceholders, type PluginManifest } from "@plurnk/plurnk-meta/agent-plugin";
import { validateMcpConfiguration, type McpServerEntry } from "./McpConfiguration.ts";
import { isFileError, type PluginOutcome, type PluginReport } from "./PluginReport.ts";

export interface AgentPlugin {
    readonly root: string;
    readonly manifest: PluginManifest;
    readonly skills: readonly SkillDirectory[];
    readonly mcpServers: ReadonlyMap<string, McpServerEntry> | null;
}

export interface PluginLoad {
    readonly plugin: AgentPlugin | null;
    readonly reports: readonly PluginReport[];
}

type Report = (path: string, section: string, outcome: PluginOutcome, message: string) => void;

const read = async <T>(path: string, outcome: PluginOutcome, report: Report, action: () => Promise<T>): Promise<T | null> => {
    try { return await action(); }
    catch (cause) {
        if (!isFileError(cause)) throw cause;
        report(path, "client", outcome, cause.message);
        return null;
    }
};

// A lexical stand-in for the client-managed data directory, which the consumer checks again at launch.
const DATA = "/PLUGIN_DATA";

const { inside, resolved, contained } = AgentPluginFiles;

const pointer = (server: string): string => `mcp.json#/mcpServers/${server.replaceAll("~", "~0").replaceAll("/", "~1")}`;

const parseJson = async (path: string): Promise<{ value: unknown } | null> => {
    try {
        return { value: JSON.parse(await readFile(path, "utf8")) };
    } catch (cause) {
        if (cause instanceof SyntaxError) return null;
        throw cause;
    }
};

// {§agent-plugins-scope} One plugin directory: its manifest, then each supported component type in isolation.
export default class PluginDirectory {
    static async load(directory: string): Promise<PluginLoad> {
        const reports: PluginReport[] = [];
        const report: Report = (path, section, outcome, message) => { reports.push({ root: directory, path, section, outcome, message }); };
        const root = await read("", "rejected", report, () => resolved(directory));
        if (root === null || !(await read("", "rejected", report, () => stat(root)))?.isDirectory()) {
            if (reports.length > 0) return { plugin: null, reports };
            report("", "11.1", "rejected", "the plugin directory does not exist");
            return { plugin: null, reports };
        }
        const manifest = await read("plugin.json", "rejected", report, () => PluginDirectory.#manifest(root, report));
        if (manifest === null) return { plugin: null, reports };
        const skills = await read("skills", "invalid", report, () => PluginDirectory.#skills(root, report)) ?? [];
        const mcpServers = await read("mcp.json", "invalid", report, () => PluginDirectory.#mcp(root, report));
        return { plugin: { root, manifest, skills, mcpServers }, reports };
    }

    static async #manifest(root: string, report: Report): Promise<PluginManifest | null> {
        const result = await AgentPluginFiles.manifest(root);
        if (result === null) {
            report("plugin.json", "5.1", "rejected", "plugin.json is missing");
            return null;
        }
        for (const finding of result.ignored) report("plugin.json", finding.section, "ignored", finding.message);
        if ("rejected" in result) {
            report("plugin.json", result.rejected.section, "rejected", result.rejected.message);
            return null;
        }
        return result.manifest;
    }

    // {§agent-plugins-components} Immediate children of `skills/` whose SKILL.md resolves to a regular file.
    static async #skills(root: string, report: Report): Promise<SkillDirectory[]> {
        const location = join(root, "skills");
        const real = await resolved(location);
        if (real === null) return [];
        if (!inside(root, real)) {
            report("skills", "4.1", "invalid", "skills/ resolves outside the plugin root");
            return [];
        }
        if (!(await stat(real)).isDirectory()) {
            report("skills", "6.2", "invalid", "skills is not a directory");
            return [];
        }
        const skills: SkillDirectory[] = [];
        for (const name of (await readdir(real)).toSorted()) {
            const file = await read(`skills/${name}`, "skipped", report, () => resolved(join(real, name, "SKILL.md")));
            if (file === null) continue;
            if (!inside(root, file)) {
                report(`skills/${name}/SKILL.md`, "4.1", "skipped", "SKILL.md resolves outside the plugin root");
                continue;
            }
            if (!(await read(`skills/${name}`, "skipped", report, () => stat(file)))?.isFile()) continue;
            try {
                skills.push(await SkillDirectory.load(join(real, name)));
            } catch (cause) {
                report(`skills/${name}`, "7.1", "skipped", (cause as Error).message);
            }
        }
        return skills;
    }

    static async #mcp(root: string, report: Report): Promise<ReadonlyMap<string, McpServerEntry> | null> {
        const location = join(root, "mcp.json");
        const real = await resolved(location);
        if (real === null) return null;
        if (!inside(root, real)) {
            report("mcp.json", "4.1", "invalid", "mcp.json resolves outside the plugin root; MCP is disabled for this plugin");
            return null;
        }
        if (!(await stat(real)).isFile()) {
            report("mcp.json", "6.2", "invalid", "mcp.json is not a regular file; MCP is disabled for this plugin");
            return null;
        }
        const parsed = await parseJson(real);
        if (parsed === null) {
            report("mcp.json", "7.2.2", "invalid", "mcp.json is not valid JSON; MCP is disabled for this plugin");
            return null;
        }
        const result = validateMcpConfiguration(parsed.value);
        if ("disabled" in result) {
            report("mcp.json", result.disabled.section, "invalid", `${result.disabled.message}; MCP is disabled for this plugin`);
            return null;
        }
        for (const finding of result.skipped) report(pointer(finding.server), finding.section, "skipped", finding.message);
        const servers = new Map<string, McpServerEntry>();
        for (const [name, entry] of result.servers) {
            let escape: string | null;
            try { escape = await PluginDirectory.#escape(root, entry); }
            catch (cause) {
                if (!isFileError(cause)) throw cause;
                report(pointer(name), "client", "skipped", cause.message);
                continue;
            }
            if (escape === null) servers.set(name, entry);
            else report(pointer(name), "4.1", "skipped", escape);
        }
        return servers;
    }

    // {§agent-plugins-containment} A `./` command, and a working directory once its placeholders expand.
    static async #escape(root: string, entry: McpServerEntry): Promise<string | null> {
        if (entry.type !== "stdio") return null;
        if (entry.command.startsWith("./") && !(await contained(root, resolve(root, entry.command)))) {
            return `command ${entry.command} resolves outside the plugin root`;
        }
        if (entry.cwd === undefined) return null;
        const expanded = expandPlaceholders(entry.cwd, { root, data: DATA });
        if (entry.cwd.startsWith("${PLUGIN_DATA}")) return inside(DATA, resolve(expanded)) ? null : `cwd ${entry.cwd} leaves the plugin data directory`;
        return (await contained(root, resolve(root, expanded))) ? null : `cwd ${entry.cwd} resolves outside the plugin root`;
    }
}
