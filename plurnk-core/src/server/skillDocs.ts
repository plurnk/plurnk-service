// {§skills-materialization} — workspace skills reconciliation. Runs when the
// daemon boots an existing workspace and when a new workspace is created,
// never as a per-worker or per-loop ritual. Each
// <projectRoot>/skills/<folder>/SKILL.md (Agent Skills format) becomes one
// kernel-owned worker://plurnk/skills/<name>.md entry; the index entry always
// exists so turn-0 discovery shows the surface — and where skills would have
// been — even when none are installed.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
    UNKNOWN_POSITION,
    type EditStatement,
    type ParsedPath,
    type PlurnkStatement,
    type SendStatement,
} from "@plurnk/plurnk-contracts";
import type Engine from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";
import Owner from "../core/Owner.ts";
import DispatchAsPlurnk from "./dispatch-as-plurnk.ts";

interface SkillDoc {
    readonly name: string;
    readonly description: string | null;
    readonly body: string;
}

const SKILLS_PREFIX_LENGTH = "/skills/".length;

const skillPath = (segment: string): ParsedPath => ({
    kind: "url",
    raw: `worker://plurnk/skills/${segment}`,
    scheme: "worker",
    username: null,
    password: null,
    hostname: "plurnk",
    port: null,
    pathname: `/skills/${segment}`,
    query: null,
    fragment: null,
});

// Minimal frontmatter subset (name/description between --- fences). Full YAML
// is deliberately out of scope: the kernel needs the two discovery keys; the
// body is preserved verbatim.
const parseSkill = (folder: string, raw: string): SkillDoc => {
    const lines = raw.replace(/\r\n/gu, "\n").split("\n");
    let name: string | null = null;
    let description: string | null = null;
    let bodyStart = 0;
    if (lines[0]?.trim() === "---") {
        for (let index = 1; index < lines.length; index += 1) {
            const line = lines[index]!.trimEnd();
            if (line === "---") {
                bodyStart = index + 1;
                break;
            }
            const key = /^([a-z]+):\s*(.*)$/u.exec(line.trim());
            if (key?.[1] === "name" && key[2]!.length > 0) name = key[2]!;
            else if (key?.[1] === "description" && key[2]!.length > 0) description = key[2]!;
        }
    }
    let body = lines.slice(bodyStart).join("\n").trim();
    // A bare SKILL.md may open with its own `# Title`; the folder name is the
    // entry name, so the duplicated heading is stripped.
    if (name === null) {
        const heading = /^#\s+(.+)$/mu.exec(body);
        if (heading !== null) body = body.slice(heading[0].length).trim();
    }
    return {
        name: name ?? folder,
        description,
        body,
    };
};

const renderSkill = (doc: SkillDoc): string => [
    `# ${doc.name}`,
    ...(doc.description === null ? [] : ["", `> ${doc.description}`]),
    ...(doc.body.length === 0 ? [] : ["", doc.body]),
].join("\n");

const renderIndex = (skills: readonly SkillDoc[], projectRoot: string | null): string => {
    const lines = ["# Installed skills"];
    if (skills.length === 0) {
        const location = projectRoot === null
            ? "a workspace project root"
            : `${projectRoot}/skills/`;
        lines.push(
            "",
            "None installed. Add one folder per skill under " +
            `${location}, each with a SKILL.md (name + description + instructions); ` +
            "it appears here at the next workspace refresh.",
        );
        return lines.join("\n");
    }
    for (const skill of skills) {
        lines.push(
            "",
            `- **${skill.name}**${skill.description === null ? "" : ` — ${skill.description}`}`,
        );
    }
    return lines.join("\n");
};

export default class SkillDocs {
    // {§skills-materialization} — the materialized surface tracks the skill
    // folders' signature so a per-turn refresh dispatches only on real drift.
    static #signatures = new Map<number, string>();

    // {§skills-materialization} — PLURNK_SKILLS_<ALIAS>=<path-to-skill-folder>
    // declares operator-global skills, unioned with the project's skills/ by
    // alias; the project wins a collision before the operator path is read.
    static #envSkillFolders(): Array<{ alias: string; dir: string }> {
        const out: Array<{ alias: string; dir: string }> = [];
        for (const [key, value] of Object.entries(process.env)) {
            if (!key.startsWith("PLURNK_SKILLS_") || typeof value !== "string" || value.length === 0) continue;
            const alias = key.slice("PLURNK_SKILLS_".length);
            if (alias.length === 0) continue;
            const expanded = value.startsWith("~/")
                ? resolve(homedir(), value.slice(2))
                : value === "~" ? homedir() : value;
            out.push({ alias, dir: resolve(expanded) });
        }
        return out;
    }

    static async #scan(workspaceId: number, db: Db): Promise<{ skills: SkillDoc[]; projectRoot: string | null; signature: string }> {
        const workspace = await db.envelope_get_workspace.get<{ project_root: string | null }>({
            id: workspaceId,
        });
        const projectRoot = workspace?.project_root ?? null;
        const skills: SkillDoc[] = [];
        const projectAliases = new Set<string>();
        if (projectRoot !== null) {
            const dir = join(projectRoot, "skills");
            const folders = (await readdir(dir, { withFileTypes: true }).catch(() => []))
                .filter((entry) => entry.isDirectory())
                .toSorted((left, right) => left.name.localeCompare(right.name));
            for (const folder of folders) {
                const raw = await readFile(join(dir, folder.name, "SKILL.md"), "utf8").catch(() => null);
                if (raw === null) continue;
                projectAliases.add(folder.name.toLowerCase());
                skills.push(parseSkill(folder.name, raw));
            }
        }
        for (const { alias, dir } of SkillDocs.#envSkillFolders().toSorted((left, right) => left.alias.localeCompare(right.alias))) {
            if (projectAliases.has(alias.toLowerCase())) continue; // {§skills-materialization} — project wins a collision
            const raw = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => null);
            if (raw === null) {
                throw new Error(`configured operator skill '${alias.toLowerCase()}' could not be read (PLURNK_SKILLS_${alias})`);
            }
            skills.push(parseSkill(alias.toLowerCase(), raw));
        }
        const signature = createHash("sha256")
            .update(skills.map((skill) => `${skill.name}\u0000${skill.description ?? ""}\u0000${skill.body}`).join("\u0001"))
            .digest("hex");
        return { skills, projectRoot, signature };
    }

    // The model-facing EXEC[skills] runtime mutates the skills folders during a
    // turn; the turn-completion hook refreshes the surface so an added or
    // removed skill is discoverable from the next turn onward.
    static async refreshIfChanged(engine: Engine, db: Db, workspaceId: number): Promise<void> {
        const scanned = await SkillDocs.#scan(workspaceId, db);
        if (SkillDocs.#signatures.get(workspaceId) === scanned.signature) return;
        await SkillDocs.#materialize(engine, db, workspaceId, scanned);
        SkillDocs.#signatures.set(workspaceId, scanned.signature);
    }

    static async materialize(engine: Engine, db: Db, workspaceId: number): Promise<void> {
        const scanned = await SkillDocs.#scan(workspaceId, db);
        console.error("DEBUG scan:", scanned.skills.map((x) => `${x.name}:${x.body.slice(0, 14)}`).join(" | "));
        await SkillDocs.#materialize(engine, db, workspaceId, scanned);
        SkillDocs.#signatures.set(workspaceId, scanned.signature);
    }

    static async #materialize(
        engine: Engine,
        db: Db,
        workspaceId: number,
        scanned: { skills: SkillDoc[]; projectRoot: string | null; signature: string },
    ): Promise<void> {
        const { skills, projectRoot } = scanned;
        const statements: PlurnkStatement[] = [];
        const desired = new Map<string, string>([
            ["index.md", renderIndex(skills, projectRoot)],
            ...skills.map((skill): [string, string] => [
                `${encodeURIComponent(skill.name)}.md`,
                renderSkill(skill),
            ]),
        ]);
        const ownerId = await Owner.kernelId(db, workspaceId);
        const materialized = await db.skill_docs_materialized.all<{ pathname: string }>({
            workspace_id: workspaceId,
            owner_id: ownerId,
        });
        for (const { pathname } of materialized) {
            if (desired.has(pathname.slice(SKILLS_PREFIX_LENGTH))) continue;
            statements.push({
                op: "SEND", delimiter: "", annotation: null, signal: 410,
                target: skillPath(pathname.slice(SKILLS_PREFIX_LENGTH)),
                lineMarker: null, body: null, position: UNKNOWN_POSITION,
            } satisfies SendStatement);
        }
        for (const [segment, content] of desired) {
            statements.push({
                op: "EDIT", delimiter: "", annotation: null, signal: null,
                target: skillPath(segment),
                lineMarker: { marks: [1, -1] }, body: content, position: UNKNOWN_POSITION,
            } satisfies EditStatement);
        }
        await DispatchAsPlurnk.dispatch(engine, db, workspaceId, statements);
    }
}
