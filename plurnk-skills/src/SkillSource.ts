// {§skills-sources} — where an added Agent Skill comes from: a git remote on any forge, a folder, a
// lone SKILL.md, or a zip or tar archive, read with git, tar and unzip. Fetching runs nothing it
// fetched, and an installed skill holds nothing that points out of it.
import { isRecord, errnoCode } from "@plurnk/plurnk-contracts";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parseSkill, skillName } from "@plurnk/plurnk-agent-skills";
import { AgentPluginFiles } from "@plurnk/plurnk-meta/agent-plugin";
import { Knob } from "@plurnk/plurnk-meta";
import { actionError, messageOf } from "./problems.ts";

const execFileP = promisify(execFile);
const { isFile } = AgentPluginFiles;

// The ceiling of one tool run's captured output: a bound on a child process, not a choice.
const TOOL_OUTPUT_BYTES = 8 * 1024 * 1024;
const ARCHIVE = /\.(?:zip|tar|tgz|tbz2|txz|tar\.(?:gz|bz2|xz|zst))$/iu;
const SCP_REMOTE = /^[\w.~-]+@[\w.-]+:(?!\/\/)\S/u;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const MCP_SERVER_SCHEME = /^([a-z][a-z0-9-]*):\/\/\/(.*)$/u;
const RESERVED_SCHEMES = new Set([
    "http",
    "https",
    "ssh",
    "file",
    "skill",
    "workspace",
    "session",
    "ops",
    "log",
    "env",
    "sh",
    "js",
    "ftp",
    "git",
]);

type SkillSourceKind = "git" | "mcp" | "folder" | "skill-file" | "archive";

export interface McpSource {
    readonly kind: "mcp";
    readonly location: string;
    readonly server: string;
    readonly skillName?: string;
}

export type LocatedSource =
    | {
          readonly kind: Exclude<SkillSourceKind, "mcp">;
          // A git remote; a local source resolved to an absolute path.
          readonly location: string;
      }
    | McpSource;

export interface FoundSkill {
    readonly name: string;
    readonly description: string;
    // The directory whose contents become <root>/<name>.
    readonly dir: string;
}

export interface OpenedSource {
    readonly skills: readonly FoundSkill[];
    // Directories holding a SKILL.md that is not a standard skill, with the reason.
    readonly invalid: ReadonlyArray<{ readonly dir: string; readonly reason: string }>;
    // The commit a git source's checkout holds.
    readonly commit?: string;
    close(): Promise<void>;
}

// The reason a tool gave: its last stderr line, or that it outran its deadline.
const reason = (cause: unknown): string => {
    const failure = isRecord(cause) ? cause : {};
    if (failure.killed === true) return "it outran PLURNK_SKILLS_FETCH_TIMEOUT_MS";
    const text = typeof failure.stderr === "string" && failure.stderr.trim().length > 0 ? failure.stderr : messageOf(cause);
    return text.split(/\r?\n/u).map((line) => line.trim()).findLast((line) => line.length > 0) ?? messageOf(cause);
};

export default class SkillSource {
    readonly #operatorEnvironment: () => NodeJS.ProcessEnv;

    constructor(operatorEnvironment: () => NodeJS.ProcessEnv) {
        this.#operatorEnvironment = operatorEnvironment;
    }

    async #tool(command: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        const env = this.#operatorEnvironment();
        const work = execFileP(command, [...args], {
            signal,
            // {§skills-sources} The host supplies the admitted operator environment; fetching never prompts.
            env: {
                ...env,
                GIT_TERMINAL_PROMPT: "0",
                ...(env.GIT_SSH_COMMAND === undefined && env.GIT_SSH === undefined ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } : {}),
            },
            timeout: Knob.integer("PLURNK_SKILLS_FETCH_TIMEOUT_MS", 1),
            maxBuffer: TOOL_OUTPUT_BYTES,
        });
        // execFile rejects on abort before the child necessarily closes; its staging is still in use.
        const closed = new Promise<void>((settle) => work.child.once("close", () => settle()));
        try { return (await work).stdout; }
        finally { await closed; }
    }

    // MCP server skill origin: <server>:///, <server>:///skills, or <server>:///skills/<name> ({§skills-sources}, #654).
    static mcp(source: string): McpSource | null {
        const match = MCP_SERVER_SCHEME.exec(source);
        if (match === null || RESERVED_SCHEMES.has(match[1].toLowerCase())) return null;
        const server = match[1];
        const rest = match[2].replace(/\/+$/u, "");
        if (rest === "" || rest === "skills") {
            return { kind: "mcp", server, location: `${server}:///skills` };
        }
        if (rest.startsWith("skills/")) {
            const name = decodeURIComponent(rest.slice("skills/".length));
            if (name.length > 0 && !name.includes("/") && name !== "." && name !== "..") {
                return { kind: "mcp", server, skillName: name, location: `${server}:///skills/${name}` };
            }
        }
        throw actionError(
            "source-invalid",
            400,
            `'${source}' is not a valid MCP skill source: use '<server>:///', '<server>:///skills', or '<server>:///skills/<name>'.`,
            { source, retryable: false },
        );
    }

    // URL admission is independent of filesystem and network availability.
    static remote(source: string): (LocatedSource & { readonly kind: "git" }) | null {
        if (/^(?:https|ssh):\/\//iu.test(source)) {
            let url: URL | null = null;
            try { url = new URL(source); } catch { /* reported below */ }
            if (url === null || url.hostname.length === 0) {
                throw actionError("source-invalid", 400, `'${source}' is not a valid git remote URL.`, { source, retryable: false });
            }
            // A recorded source is listed to every client: credentials belong to git's credential helper.
            if (url.protocol === "https:" && (url.username.length > 0 || url.password.length > 0)) {
                throw actionError("source-invalid", 400, "An https source carries no credentials; git's credential helper supplies them.", { retryable: false });
            }
            return { kind: "git", location: source };
        }
        if (SCP_REMOTE.test(source)) return { kind: "git", location: source };
        if (URL_SCHEME.test(source)) {
            throw actionError("source-invalid", 400, `'${source}' is not a source: a git remote is a full https or ssh URL.`, { source, retryable: false });
        }
        return null;
    }

    // Reads a source's form without fetching it. A relative path is the project's.
    static async locate(source: string, context: { readonly projectRoot: string | null; readonly home: string }): Promise<LocatedSource> {
        const mcp = SkillSource.mcp(source);
        if (mcp !== null) return mcp;
        const remote = SkillSource.remote(source);
        if (remote !== null) return remote;
        const expanded = source === "~" || source.startsWith("~/") ? join(context.home, source.slice(1)) : source;
        if (!isAbsolute(expanded) && context.projectRoot === null) {
            throw actionError("source-invalid", 400, `'${source}' is relative, and this workspace has no project root to resolve it against.`, { source, retryable: false });
        }
        const location = resolve(context.projectRoot ?? "/", expanded);
        let info;
        try {
            info = await stat(location);
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT") {
                throw actionError("source-missing", 404, `No folder or file is at '${source}'.`, { source, path: location, retryable: false });
            }
            throw actionError("source-unreadable", 422, `'${source}' cannot be read: ${messageOf(cause)}`, { source, path: location, retryable: false }, cause);
        }
        if (info.isDirectory()) return { kind: "folder", location };
        if (info.isFile() && basename(location) === "SKILL.md") return { kind: "skill-file", location };
        if (info.isFile() && ARCHIVE.test(location)) return { kind: "archive", location };
        throw actionError("source-invalid", 400, `'${source}' is neither a folder, a SKILL.md, nor a zip or tar archive.`, { source, path: location, retryable: false });
    }

    // The commit a git remote's branch or tag names now; its default branch when no ref is given.
    async resolveCommit(remote: string, ref?: string): Promise<string> {
        let listing: string;
        try {
            // Exact refnames: a bare pattern tail-matches (`v1` finds `feature/v1`) and omits a tag's peeled commit.
            listing = await this.#tool("git", ref === undefined
                ? ["ls-remote", "--", remote, "HEAD"]
                : ["ls-remote", "--", remote, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]);
        } catch (cause) {
            throw actionError("source-unreachable", 502, `git could not reach '${remote}': ${reason(cause)}`, { source: remote, retryable: true }, cause);
        }
        const refs = new Map(listing.split("\n").filter((line) => line.includes("\t")).map((line) => {
            const [commit, name] = line.split("\t");
            return [name, commit] as const;
        }));
        const commit = ref === undefined
            ? refs.get("HEAD")
            : refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`);
        if (commit === undefined) {
            throw actionError("ref-missing", 404, ref === undefined ? `'${remote}' names no default branch.` : `'${remote}' has no branch or tag '${ref}'.`, {
                source: remote, ...(ref === undefined ? {} : { ref }), retryable: false,
            });
        }
        return commit;
    }

    // Local trees stay in place; fetched sources own private staging released by close().
    async open(located: LocatedSource, pin: { readonly ref?: string; readonly commit?: string; readonly signal?: AbortSignal } = {}): Promise<OpenedSource> {
        const { signal } = pin;
        signal?.throwIfAborted();
        if (located.kind === "folder" || located.kind === "skill-file") {
            const root = located.kind === "folder" ? located.location : dirname(located.location);
            await SkillSource.#assertSkillSource(root, located.location);
            return { ...await SkillSource.#find(root, false), close: async () => {} };
        }
        const staging = await mkdtemp(join(tmpdir(), "plurnk-skill-source-"));
        const close = (): Promise<void> => rm(staging, { recursive: true, force: true });
        try {
            let root: string;
            let commit: string | undefined;
            switch (located.kind) {
                case "git": {
                    root = join(staging, "checkout");
                    try {
                        // No hook runs on the checkout: an operator's global post-checkout would run fetched content.
                        await this.#tool("git", ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--single-branch", "--no-recurse-submodules",
                            ...(pin.ref === undefined ? [] : ["--branch", pin.ref]), "--", located.location, root], signal);
                        commit = (await this.#tool("git", ["-C", root, "rev-parse", "HEAD"], signal)).trim();
                    } catch (cause) {
                        signal?.throwIfAborted();
                        const at = pin.ref === undefined ? "" : ` at '${pin.ref}'`;
                        throw actionError("source-unreachable", 502, `git could not fetch '${located.location}'${at}: ${reason(cause)}`, {
                            source: located.location, ...(pin.ref === undefined ? {} : { ref: pin.ref }), retryable: true,
                        }, cause);
                    }
                    if (pin.commit !== undefined && commit !== pin.commit) {
                        throw actionError("source-moved", 409, `'${located.location}' ${pin.ref ?? "HEAD"} now names ${commit}; this skill was added at ${pin.commit}.`, {
                            source: located.location, ...(pin.ref === undefined ? {} : { ref: pin.ref }), commit: pin.commit, current: commit,
                            recovery: "Use plurnk (skills) replace with the complete source definition to take the current commit.", retryable: false,
                        });
                    }
                    break;
                }
                case "archive": {
                    const into = join(staging, "archive");
                    await mkdir(into);
                    try {
                        // Both tools strip absolute and parent-relative member names and create an
                        // archive's links only after its files, so no member lands outside staging.
                        if (/\.zip$/iu.test(located.location)) await this.#tool("unzip", ["-qq", "-n", located.location, "-d", into], signal);
                        else await this.#tool("tar", ["-x", "-f", located.location, "-C", into], signal);
                    } catch (cause) {
                        signal?.throwIfAborted();
                        throw actionError("source-unreadable", 422, `'${located.location}' could not be unpacked: ${reason(cause)}`, { path: located.location, retryable: false }, cause);
                    }
                    const entries = await readdir(into, { withFileTypes: true });
                    root = entries.length === 1 && entries[0].isDirectory() ? join(into, entries[0].name) : into;
                    break;
                }
                case "mcp":
                    throw new Error("MCP sources open through SkillSource.openMcpFiles.");
            }
            signal?.throwIfAborted();
            await SkillSource.#assertSkillSource(root, located.location);
            const { skills, invalid } = await SkillSource.#find(root, true);
            return { skills, invalid, ...(commit === undefined ? {} : { commit }), close };
        } catch (error) {
            try { await close(); }
            catch (cleanup) { throw new AggregateError([error, cleanup], "Skill source preparation and cleanup failed."); }
            throw error;
        }
    }

    static async openMcpFiles(
        name: string,
        source: string,
        files: ReadonlyArray<{ readonly path: string; readonly base64: string }>,
        commit: string,
        signal?: AbortSignal,
    ): Promise<OpenedSource> {
        signal?.throwIfAborted();
        const staging = await mkdtemp(join(tmpdir(), "plurnk-skill-mcp-"));
        const close = (): Promise<void> => rm(staging, { recursive: true, force: true });
        try {
            const root = join(staging, name);
            await mkdir(root, { recursive: true });
            const canonicalRoot = await realpath(root);
            for (const file of files) {
                if (
                    file.path.length === 0 ||
                    file.path.startsWith("/") ||
                    file.path.split("/").some((seg) => seg.length === 0 || seg === "." || seg === "..")
                ) {
                    throw actionError("source-unsafe", 422, `'${file.path}' links outside its skill.`, { path: file.path, retryable: false });
                }
                const target = resolve(canonicalRoot, file.path);
                if (!AgentPluginFiles.inside(canonicalRoot, target)) {
                    throw actionError("source-unsafe", 422, `'${file.path}' links outside its skill.`, { path: file.path, retryable: false });
                }
                await mkdir(dirname(target), { recursive: true });
                await writeFile(target, Buffer.from(file.base64, "base64"));
            }
            signal?.throwIfAborted();
            await SkillSource.#assertSkillSource(root, source);
            const { skills, invalid } = await SkillSource.#find(root, true);
            return { skills, invalid, commit, close };
        } catch (error) {
            try { await close(); }
            catch (cleanup) { throw new AggregateError([error, cleanup], "Skill source preparation and cleanup failed."); }
            throw error;
        }
    }

    static async #assertSkillSource(root: string, source: string): Promise<void> {
        if (await isFile(join(root, "plugin.json"))) {
            throw actionError("source-is-plugin", 422, `'${source}' is an Agent Plugin, not a skill.`, {
                source, retryable: false,
            });
        }
    }

    // Every directory holding a SKILL.md, not descending into a skill or into .git. A skill at the
    // fetched root is named by its frontmatter; live folders retain the standard folder rule.
    static async #find(root: string, fetched: boolean): Promise<{ skills: FoundSkill[]; invalid: Array<{ dir: string; reason: string }> }> {
        const canonicalRoot = await realpath(root);
        const skills: FoundSkill[] = [];
        const invalid: Array<{ dir: string; reason: string }> = [];
        const visit = async (dir: string, atRoot: boolean): Promise<void> => {
            const file = join(dir, "SKILL.md");
            if (await isFile(file)) {
                try {
                    if (!AgentPluginFiles.inside(canonicalRoot, await realpath(file))) throw new Error(`${file} resolves outside the source`);
                    const document = await readFile(file, "utf8");
                    const parsed = parseSkill(file, atRoot && fetched ? skillName(file, document) : basename(dir), document);
                    skills.push({ name: parsed.name, description: parsed.description, dir });
                } catch (cause) {
                    invalid.push({ dir, reason: messageOf(cause) });
                }
                return;
            }
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                if (entry.isDirectory() && entry.name !== ".git") await visit(join(dir, entry.name), false);
            }
        };
        await visit(root, true);
        return { skills: skills.toSorted((left, right) => left.name.localeCompare(right.name) || left.dir.localeCompare(right.dir)), invalid };
    }

    // Copies one found skill to <root>/<name>: staged beside its destination, refused when it holds
    // a link out of itself or anything but files, directories and inward links, then renamed in.
    static async install(skill: FoundSkill, root: string): Promise<string> {
        await mkdir(root, { recursive: true });
        const holding = await mkdtemp(join(root, ".plurnk-install-"));
        try {
            const staged = join(holding, skill.name);
            await cp(skill.dir, staged, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, filter: (path) => basename(path) !== ".git" });
            await SkillSource.assertInward(staged);
            const target = join(root, skill.name);
            await rename(staged, target);
            return target;
        } finally {
            await rm(holding, { recursive: true, force: true });
        }
    }

    static async assertInward(root: string): Promise<void> {
        const walk = async (dir: string): Promise<void> => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(path);
                    continue;
                }
                if (entry.isFile()) continue;
                if (entry.isSymbolicLink() && AgentPluginFiles.inside(root, resolve(dir, await readlink(path)))) continue;
                const what = entry.isSymbolicLink() ? "links outside its skill" : "is neither a file, a directory, nor an inward link";
                throw actionError("source-unsafe", 422, `'${relative(root, path)}' ${what}.`, { path: relative(root, path), retryable: false });
            }
        };
        await walk(root);
    }
}
