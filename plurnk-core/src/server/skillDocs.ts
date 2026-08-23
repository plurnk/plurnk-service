// {§skills-materialization} — standard Agent Skills from the project, shared
// user root, and exact package bundle become worker-private pull docs. This
// runs when the worker's Functionality becomes resident and immediately before
// a changed filesystem can shape that worker's next model turn.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { generatedPathname } from "../core/plurnk-uri.ts";
import {
    UNKNOWN_POSITION,
    type EditStatement,
    type ParsedPath,
    type PlurnkStatement,
    type KillStatement,
} from "@plurnk/plurnk-contracts";
import { parse as parseYaml } from "yaml";
import type Engine from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";
import HostPaths from "../core/HostPaths.ts";
import Paths from "../Paths.ts";
import DispatchAsPlurnk from "./dispatch-as-plurnk.ts";

interface SkillDoc {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

interface SkillCandidate {
    readonly folder: string;
    readonly file: string;
    readonly source: "project" | "global" | "bundled";
}

const SKILLS_PREFIX_LENGTH = generatedPathname("/skills/").length;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const skillPath = (segment: string): ParsedPath => ({
    kind: "url",
    raw: `worker://~${generatedPathname(`/skills/${segment}`)}`,
    scheme: "worker",
    username: null,
    password: null,
    hostname: "~",
    port: null,
    pathname: generatedPathname(`/skills/${segment}`),
    query: null,
    fragment: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// Agent Skills requires YAML frontmatter with name and description. Admission
// consumes those two discovery keys and preserves the instruction body.
const parseSkill = (candidate: SkillCandidate, raw: string): SkillDoc => {
    const lines = raw.replace(/\r\n/gu, "\n").split("\n");
    if (lines[0] !== "---") {
        throw new Error(`${candidate.file}: Agent Skill requires YAML frontmatter`);
    }
    let bodyStart: number | null = null;
    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line === "---") {
            bodyStart = index + 1;
            break;
        }
    }
    if (bodyStart === null) throw new Error(`${candidate.file}: Agent Skill frontmatter is not closed`);
    let metadata: unknown;
    try {
        metadata = parseYaml(lines.slice(1, bodyStart - 1).join("\n"), {
            maxAliasCount: 0,
            uniqueKeys: true,
        });
    } catch (cause) {
        throw new Error(`${candidate.file}: Agent Skill frontmatter is invalid YAML`, { cause });
    }
    if (!isRecord(metadata)) throw new Error(`${candidate.file}: Agent Skill frontmatter must be a mapping`);
    const { name, description } = metadata;
    if (typeof name !== "string" || name.length === 0) {
        throw new Error(`${candidate.file}: Agent Skill frontmatter requires name`);
    }
    if (!SKILL_NAME.test(name)) throw new Error(`${candidate.file}: Agent Skill name ${JSON.stringify(name)} is invalid`);
    if (name.length > 64) throw new Error(`${candidate.file}: Agent Skill name exceeds 64 characters`);
    if (name !== candidate.folder) {
        throw new Error(`${candidate.file}: Agent Skill name ${JSON.stringify(name)} must match folder ${JSON.stringify(candidate.folder)}`);
    }
    if (typeof description !== "string" || description.length === 0) {
        throw new Error(`${candidate.file}: Agent Skill frontmatter requires description`);
    }
    if (description.length > 1024) throw new Error(`${candidate.file}: Agent Skill description exceeds 1024 characters`);
    return {
        name,
        description,
        body: lines.slice(bodyStart).join("\n").trim(),
    };
};

const renderSkill = (doc: SkillDoc): string => [
    `# ${doc.name}`,
    "",
    "## Summary",
    "",
    doc.description,
    ...(doc.body.length === 0 ? [] : ["", doc.body]),
].join("\n");

const renderIndex = (skills: readonly SkillDoc[]): string => [
    "# Skills",
    "",
    "## Summary",
    "",
    "Agent Skills available to this worker.",
    ...skills.flatMap((skill) => ["", `- **${skill.name}** — ${skill.description}`]),
].join("\n");

const readDirectoryCandidates = async (
    dir: string,
    source: SkillCandidate["source"],
): Promise<SkillCandidate[]> => {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new Error(`read ${source} Agent Skills directory ${dir} failed`, { cause });
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
            folder: entry.name,
            file: join(dir, entry.name, "SKILL.md"),
            source,
        }))
        .toSorted((left, right) => left.folder.localeCompare(right.folder));
};

const readCandidate = async (candidate: SkillCandidate): Promise<SkillDoc | null> => {
    let raw: string;
    try {
        raw = await readFile(candidate.file, "utf8");
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT" && candidate.source !== "bundled") return null;
        throw new Error(`read ${candidate.source} Agent Skill ${candidate.file} failed`, { cause });
    }
    return parseSkill(candidate, raw);
};

export default class SkillDocs {
    static #signatures = new WeakMap<object, Map<number, string>>();

    static async #scan(
        workspaceId: number,
        db: Db,
        hostPaths: HostPaths,
    ): Promise<{ skills: SkillDoc[]; signature: string }> {
        const workspace = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const candidates: SkillCandidate[][] = [];
        if (workspace?.project_root !== null && workspace?.project_root !== undefined) {
            candidates.push(await readDirectoryCandidates(
                hostPaths.projectSkillsDir(workspace.project_root),
                "project",
            ));
        }
        candidates.push(await readDirectoryCandidates(hostPaths.globalSkillsDir, "global"));
        candidates.push([...Paths.bundledSkills()].map(([name, file]) => ({
            folder: name,
            file,
            source: "bundled" as const,
        })));

        const skills: SkillDoc[] = [];
        const claimed = new Set<string>();
        for (const layer of candidates) {
            for (const candidate of layer) {
                if (claimed.has(candidate.folder)) continue;
                const skill = await readCandidate(candidate);
                if (skill === null) continue;
                claimed.add(candidate.folder);
                skills.push(skill);
            }
        }
        skills.sort((left, right) => left.name.localeCompare(right.name));
        const signature = createHash("sha256")
            .update(skills.map((skill) => `${skill.name}\u0000${skill.description}\u0000${skill.body}`).join("\u0001"))
            .digest("hex");
        return { skills, signature };
    }

    static #byWorker(db: Db): Map<number, string> {
        const existing = SkillDocs.#signatures.get(db);
        if (existing !== undefined) return existing;
        const created = new Map<number, string>();
        SkillDocs.#signatures.set(db, created);
        return created;
    }

    static evict(db: Db, workerId: number): void {
        SkillDocs.#signatures.get(db)?.delete(workerId);
    }

    static async refreshIfChanged(
        engine: Engine,
        db: Db,
        workspaceId: number,
        workerId: number,
        hostPaths: HostPaths = new HostPaths(),
    ): Promise<void> {
        const scanned = await SkillDocs.#scan(workspaceId, db, hostPaths);
        const signatures = SkillDocs.#byWorker(db);
        if (signatures.get(workerId) === scanned.signature) return;
        await SkillDocs.#materialize(engine, db, workspaceId, workerId, scanned);
        signatures.set(workerId, scanned.signature);
    }

    static async materialize(
        engine: Engine,
        db: Db,
        workspaceId: number,
        workerId: number,
        hostPaths: HostPaths = new HostPaths(),
    ): Promise<void> {
        const scanned = await SkillDocs.#scan(workspaceId, db, hostPaths);
        await SkillDocs.#materialize(engine, db, workspaceId, workerId, scanned);
        SkillDocs.#byWorker(db).set(workerId, scanned.signature);
    }

    static async #materialize(
        engine: Engine,
        db: Db,
        workspaceId: number,
        workerId: number,
        scanned: { skills: SkillDoc[]; signature: string },
    ): Promise<void> {
        const { skills } = scanned;
        const statements: PlurnkStatement[] = [];
        const desired = new Map<string, string>([
            ["index.md", renderIndex(skills)],
            ...skills.map((skill): [string, string] => [`${encodeURIComponent(skill.name)}.md`, renderSkill(skill)]),
        ]);
        const materialized = await db.skill_docs_materialized.all<{
            pathname: string;
            content: string | null;
        }>({
            workspace_id: workspaceId,
            owner_id: workerId,
        });
        const current = new Map(materialized.map(({ pathname, content }) => [
            pathname.slice(SKILLS_PREFIX_LENGTH),
            content,
        ]));
        for (const { pathname } of materialized) {
            if (desired.has(pathname.slice(SKILLS_PREFIX_LENGTH))) continue;
            statements.push({
                op: "KILL", delimiter: "", annotation: null, signal: null,
                target: skillPath(pathname.slice(SKILLS_PREFIX_LENGTH)),
                lineMarker: null, body: null, position: UNKNOWN_POSITION,
            } satisfies KillStatement);
        }
        for (const [segment, content] of desired) {
            if (current.get(segment) === content) continue;
            statements.push({
                op: "EDIT", delimiter: "", annotation: null, signal: null,
                target: skillPath(segment),
                lineMarker: { marks: [1, -1] }, body: content, position: UNKNOWN_POSITION,
            } satisfies EditStatement);
        }
        await DispatchAsPlurnk.dispatch(engine, db, workspaceId, workerId, statements);
    }
}
