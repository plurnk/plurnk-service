import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BaseExecutor, ErrorDetail, Results } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";

// skills executor — the model-facing management surface for the workspace
// Agent Skills ({§skills-materialization}). Invocation model:
//   target = the action: `list`, `add`, or `remove`
//   body   = for add: the complete SKILL.md (name comes from its frontmatter);
//            for remove: the skill name.
// `add` and `remove` mutate the workspace's skills/ directory and are
// host-effecting ({§executor-effect}); `list` is read. The kernel re-publishes
// the worker://plurnk/skills/ entries on the next workspace refresh, so a
// skill the model adds becomes discoverable on the following turn.
const SKILLS_DIR = "skills";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const fail = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>>,
): ExecResult => Results.failure("executor:skills", code, status, detail, {}, extensions);

const frontmatter = (raw: string): { name: string | null; description: string | null } => {
    const lines = raw.replace(/\r\n/gu, "\n").split("\n");
    let name: string | null = null;
    let description: string | null = null;
    if (lines[0]?.trim() === "---") {
        for (let index = 1; index < lines.length; index += 1) {
            const line = lines[index]!.trimEnd();
            if (line === "---") break;
            const key = /^([a-z]+):\s*(.*)$/u.exec(line.trim());
            if (key?.[1] === "name" && key[2]!.length > 0) name = key[2]!;
            else if (key?.[1] === "description" && key[2]!.length > 0) description = key[2]!;
        }
    }
    return { name, description };
};

const requireName = (name: string | null, fallback: string): string => {
    if (name === null || name.length === 0) return fallback;
    if (!NAME_PATTERN.test(name)) {
        throw new Error(`skill name '${name}' must match ${NAME_PATTERN.source}`);
    }
    return name;
};

const skillsDir = (cwd: string | null): string => {
    if (cwd === null || cwd.length === 0) {
        throw new Error("the skills runtime requires a workspace project root");
    }
    return join(cwd, SKILLS_DIR);
};

export default class Skills extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    override effect(target: string | null): Effect {
        return target === "add" || target === "remove" ? "host" : "read";
    }

    override async probe(_signal?: AbortSignal): Promise<RuntimeAvailability> {
        return { available: true, detail: "built-in" };
    }

    async run({ body, cwd, target, signal, write, setState }: ExecArgs): Promise<ExecResult> {
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            setState("results", "errored");
            return ErrorDetail.invalidConfiguration("executor:skills");
        }
        try {
            signal?.throwIfAborted();
            const dir = skillsDir(cwd);
            if (target === "add") {
                const skill = await this.#add(dir, body.trim());
                write("results", JSON.stringify(skill));
                setState("results", "closed");
                return { status: 201 };
            }
            if (target === "remove") {
                const name = requireName(body.trim(), "");
                if (name.length === 0) {
                    return fail(
                        "skill-name-required",
                        400,
                        "remove requires the skill name as the body.",
                        { retryable: false },
                    );
                }
                const removed = await this.#remove(dir, name);
                if (!removed) {
                    return fail(
                        "skill-not-found",
                        404,
                        `No skill named '${name}' is installed.`,
                        { name, retryable: false },
                    );
                }
                write("results", JSON.stringify({ name, removed: true }));
                setState("results", "closed");
                return { status: 200 };
            }
            const skills = await this.#list(dir);
            write("results", JSON.stringify(skills));
            setState("results", "closed");
            return { status: 200 };
        } catch (error) {
            setState("results", "errored");
            if (error instanceof Error && /must match|requires a workspace|requires a `name:`|requires the complete/.test(error.message)) {
                return fail("invalid-skill", 400, error.message, { retryable: false });
            }
            if (error instanceof Error && signal?.aborted === true) {
                return Results.failure(
                    "executor:skills",
                    "cancelled",
                    499,
                    "The skills operation was cancelled.",
                    {},
                    { retryable: false },
                );
            }
            throw error;
        }
    }

    async #add(dir: string, raw: string): Promise<{ name: string; description: string | null }> {
        if (raw.length === 0) {
            throw new Error("add requires the complete SKILL.md content as the body.");
        }
        const { name, description } = frontmatter(raw);
        const folder = requireName(name, "");
        if (folder.length === 0) {
            throw new Error("add requires a `name:` frontmatter key (or a valid skill name).");
        }
        await mkdir(join(dir, folder), { recursive: true });
        await writeFile(join(dir, folder, "SKILL.md"), raw);
        return { name: folder, description };
    }

    async #remove(dir: string, name: string): Promise<boolean> {
        const folder = join(dir, name);
        const exists = await readdir(folder).then(() => true).catch(() => false);
        if (!exists) return false;
        await rm(folder, { recursive: true, force: true });
        return true;
    }

    async #list(dir: string): Promise<Array<{ name: string; description: string | null }>> {
        const folders = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const skills: Array<{ name: string; description: string | null }> = [];
        for (const entry of folders.filter((e) => e.isDirectory()).toSorted((a, b) => a.name.localeCompare(b.name))) {
            const raw = await readFile(join(dir, entry.name, "SKILL.md"), "utf8").catch(() => null);
            if (raw === null) continue;
            const { name, description } = frontmatter(raw);
            skills.push({ name: name ?? entry.name, description });
        }
        return skills;
    }
}
