import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { validateManifest, type ManifestResult } from "./AgentPluginManifest.ts";

// {§agent-plugins-containment} Shared by portable components and native extension admission.
export default class AgentPluginFiles {
    static inside(root: string, candidate: string): boolean {
        const path = relative(root, candidate);
        return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    }

    static async resolved(path: string): Promise<string | null> {
        try {
            return await realpath(path);
        } catch (cause) {
            const code = (cause as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") return null;
            throw cause;
        }
    }

    static async contained(root: string, candidate: string): Promise<boolean> {
        if (!AgentPluginFiles.inside(root, candidate)) return false;
        const real = await AgentPluginFiles.resolved(candidate);
        return real === null || AgentPluginFiles.inside(root, real);
    }

    // null is absence, not an invalid manifest that permits another format to take its place.
    static async manifest(directory: string, { signal }: { signal?: AbortSignal } = {}): Promise<ManifestResult | null> {
        signal?.throwIfAborted();
        const authored = join(directory, "plugin.json");
        try { await lstat(authored); }
        catch (cause) {
            const code = (cause as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") return null;
            throw cause;
        }
        const root = await AgentPluginFiles.resolved(directory);
        if (root === null) return null;
        const location = await AgentPluginFiles.resolved(authored);
        if (location === null) {
            return { rejected: { section: "5.1", message: "plugin.json does not resolve to a regular file" }, ignored: [] };
        }
        if (!AgentPluginFiles.inside(root, location)) {
            return { rejected: { section: "4.1", message: "plugin.json resolves outside the plugin root" }, ignored: [] };
        }
        if (!(await stat(location)).isFile()) {
            return { rejected: { section: "5.1", message: "plugin.json is not a regular file" }, ignored: [] };
        }
        let value: unknown;
        try {
            value = JSON.parse(await readFile(location, { encoding: "utf8", signal }));
        } catch (cause) {
            if (!(cause instanceof SyntaxError)) throw cause;
            return { rejected: { section: "5.2", message: "plugin.json is not valid JSON" }, ignored: [] };
        }
        return validateManifest(value);
    }
}
