// {§skills-sources} — where an added Agent Skill comes from: a git remote on any forge, a folder, a
// lone SKILL.md, or a zip or tar archive, read with git, tar and unzip. Fetching runs nothing it
// fetched, and an installed skill holds nothing that points out of it.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseSkill, skillName } from "@plurnk/plurnk-agent-skills";
import { Knob } from "@plurnk/plurnk-meta";
import ExecEnv from "../schemes/exec-env.ts";
import { actionError, messageOf } from "./skills-problems.ts";

const execFileP = promisify(execFile);

// The ceiling of one tool run's captured output: a bound on a child process, not a choice.
const TOOL_OUTPUT_BYTES = 8 * 1024 * 1024;
const ARCHIVE = /\.(?:zip|tar|tgz|tbz2|txz|tar\.(?:gz|bz2|xz|zst))$/iu;
const SCP_REMOTE = /^[\w.~-]+@[\w.-]+:(?!\/\/)\S/u;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/u;

export type SkillSourceKind = "git" | "folder" | "skill-file" | "archive";

export interface LocatedSource {
    readonly kind: SkillSourceKind;
    // A git remote exactly as given; a local source resolved to an absolute path.
    readonly location: string;
}

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

const inside = (root: string, candidate: string): boolean => {
    const path = relative(root, candidate);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const isFile = (path: string): Promise<boolean> => stat(path).then((info) => info.isFile(), (cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return false;
    throw cause;
});

// The reason a tool gave: its last stderr line, or that it outran its deadline.
const reason = (cause: unknown): string => {
    const failure = cause as { killed?: boolean; stderr?: unknown };
    if (failure.killed === true) return "it outran PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS";
    const text = typeof failure.stderr === "string" && failure.stderr.trim().length > 0 ? failure.stderr : messageOf(cause);
    return text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0).at(-1) ?? messageOf(cause);
};

const tool = async (command: string, args: readonly string[]): Promise<string> => {
    const env = ExecEnv.withoutOwnSecrets();
    const { stdout } = await execFileP(command, [...args], {
        // {§exec-env-scoped} — the operator's git configuration, credentials and SSH agent reach the
        // fetch; plurnk's own secrets never do, and neither git nor ssh ever prompts.
        env: {
            ...env,
            GIT_TERMINAL_PROMPT: "0",
            ...(env.GIT_SSH_COMMAND === undefined && env.GIT_SSH === undefined ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } : {}),
        },
        timeout: Knob.integer("PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS", 1),
        maxBuffer: TOOL_OUTPUT_BYTES,
    });
    return stdout;
};

export default class SkillSource {
    // Reads a source's form without fetching it. A relative path is the project's.
    static async locate(source: string, context: { readonly projectRoot: string | null; readonly home: string }): Promise<LocatedSource> {
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
        const expanded = source === "~" || source.startsWith("~/") ? join(context.home, source.slice(1)) : source;
        if (!isAbsolute(expanded) && context.projectRoot === null) {
            throw actionError("source-invalid", 400, `'${source}' is relative, and this workspace has no project root to resolve it against.`, { source, retryable: false });
        }
        const location = resolve(context.projectRoot ?? "/", expanded);
        let info;
        try {
            info = await stat(location);
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
                const hint = SHORTHAND.test(source) ? "; owner/repo shorthand names no forge, so give the repository's full https or ssh URL" : "";
                throw actionError("source-missing", 404, `No folder or file is at '${source}'${hint}.`, { source, path: location, retryable: false });
            }
            throw actionError("source-unreadable", 422, `'${source}' cannot be read: ${messageOf(cause)}`, { source, path: location, retryable: false }, cause);
        }
        if (info.isDirectory()) return { kind: "folder", location };
        if (info.isFile() && basename(location) === "SKILL.md") return { kind: "skill-file", location };
        if (info.isFile() && ARCHIVE.test(location)) return { kind: "archive", location };
        throw actionError("source-invalid", 400, `'${source}' is neither a folder, a SKILL.md, nor a zip or tar archive.`, { source, path: location, retryable: false });
    }

    // The commit a git remote's branch or tag names now; its default branch when no ref is given.
    static async resolveCommit(remote: string, ref?: string): Promise<string> {
        let listing: string;
        try {
            // Exact refnames: a bare pattern tail-matches (`v1` finds `feature/v1`) and omits a tag's peeled commit.
            listing = await tool("git", ref === undefined
                ? ["ls-remote", "--", remote, "HEAD"]
                : ["ls-remote", "--", remote, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]);
        } catch (cause) {
            throw actionError("source-unreachable", 502, `git could not reach '${remote}': ${reason(cause)}`, { source: remote, retryable: true }, cause);
        }
        const refs = new Map(listing.split("\n").filter((line) => line.includes("\t")).map((line) => {
            const [commit, name] = line.split("\t");
            return [name!, commit!] as const;
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

    // Fetches a located source into private staging and finds its skills; close() discards the staging.
    static async open(located: LocatedSource, pin: { readonly ref?: string; readonly commit?: string } = {}): Promise<OpenedSource> {
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
                        await tool("git", ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--single-branch", "--no-recurse-submodules",
                            ...(pin.ref === undefined ? [] : ["--branch", pin.ref]), "--", located.location, root]);
                        commit = (await tool("git", ["-C", root, "rev-parse", "HEAD"])).trim();
                    } catch (cause) {
                        const at = pin.ref === undefined ? "" : ` at '${pin.ref}'`;
                        throw actionError("source-unreachable", 502, `git could not fetch '${located.location}'${at}: ${reason(cause)}`, {
                            source: located.location, ...(pin.ref === undefined ? {} : { ref: pin.ref }), retryable: true,
                        }, cause);
                    }
                    if (pin.commit !== undefined && commit !== pin.commit) {
                        throw actionError("source-moved", 409, `'${located.location}' ${pin.ref ?? "HEAD"} now names ${commit}; this skill was added at ${pin.commit}.`, {
                            source: located.location, ...(pin.ref === undefined ? {} : { ref: pin.ref }), commit: pin.commit, current: commit,
                            recovery: "Remove the skill and add it again to take the current commit.", retryable: false,
                        });
                    }
                    break;
                }
                case "folder":
                    root = located.location;
                    break;
                case "skill-file": {
                    const document = await readFile(located.location, "utf8");
                    let name: string;
                    try {
                        name = skillName(located.location, document);
                    } catch (cause) {
                        throw actionError("skill-invalid", 422, `'${located.location}' is not a standard Agent Skill: ${messageOf(cause)}`, { path: located.location, retryable: false }, cause);
                    }
                    root = join(staging, name);
                    await mkdir(root);
                    await cp(located.location, join(root, "SKILL.md"));
                    break;
                }
                case "archive": {
                    const into = join(staging, "archive");
                    await mkdir(into);
                    try {
                        // Both tools strip absolute and parent-relative member names and create an
                        // archive's links only after its files, so no member lands outside staging.
                        if (/\.zip$/iu.test(located.location)) await tool("unzip", ["-qq", "-n", located.location, "-d", into]);
                        else await tool("tar", ["-x", "-f", located.location, "-C", into]);
                    } catch (cause) {
                        throw actionError("source-unreadable", 422, `'${located.location}' could not be unpacked: ${reason(cause)}`, { path: located.location, retryable: false }, cause);
                    }
                    const entries = await readdir(into, { withFileTypes: true });
                    root = entries.length === 1 && entries[0]!.isDirectory() ? join(into, entries[0]!.name) : into;
                    break;
                }
            }
            if (await isFile(join(root, "plugin.json"))) {
                throw actionError("source-is-plugin", 422, `'${located.location}' is an Agent Plugin; install it as a plugin, so its skills keep the plugin's identity and servers.`, {
                    source: located.location, retryable: false,
                });
            }
            const { skills, invalid } = await SkillSource.#find(root);
            return { skills, invalid, ...(commit === undefined ? {} : { commit }), close };
        } catch (error) {
            await close();
            throw error;
        }
    }

    // Every directory holding a SKILL.md, not descending into a skill or into .git. A skill at the
    // source's root is named by its frontmatter; below the root the standard folder rule applies.
    static async #find(root: string): Promise<{ skills: FoundSkill[]; invalid: Array<{ dir: string; reason: string }> }> {
        const canonicalRoot = await realpath(root);
        const skills: FoundSkill[] = [];
        const invalid: Array<{ dir: string; reason: string }> = [];
        const visit = async (dir: string, atRoot: boolean): Promise<void> => {
            const file = join(dir, "SKILL.md");
            if (await isFile(file)) {
                try {
                    if (!inside(canonicalRoot, await realpath(file))) throw new Error(`${file} resolves outside the source`);
                    const document = await readFile(file, "utf8");
                    const parsed = parseSkill(file, atRoot ? skillName(file, document) : basename(dir), document);
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
            await SkillSource.#assertInward(staged);
            const target = join(root, skill.name);
            await rename(staged, target);
            return target;
        } finally {
            await rm(holding, { recursive: true, force: true });
        }
    }

    static async #assertInward(root: string): Promise<void> {
        const walk = async (dir: string): Promise<void> => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(path);
                    continue;
                }
                if (entry.isFile()) continue;
                if (entry.isSymbolicLink() && inside(root, resolve(dir, await readlink(path)))) continue;
                const what = entry.isSymbolicLink() ? "links outside its skill" : "is neither a file, a directory, nor an inward link";
                throw actionError("source-unsafe", 422, `'${relative(root, path)}' ${what}.`, { path: relative(root, path), retryable: false });
            }
        };
        await walk(root);
    }
}
