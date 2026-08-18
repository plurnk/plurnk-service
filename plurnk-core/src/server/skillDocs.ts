// {§skills-materialization} — workspace skills reconciliation. Runs when the
// daemon boots an existing workspace and when a new workspace is created,
// never as a per-worker or per-loop ritual. Each
// <projectRoot>/skills/<folder>/SKILL.md (Agent Skills format) becomes one
// kernel-owned worker://plurnk/skills/<name>.md entry; the index entry always
// exists so turn-0 discovery shows the surface — and where skills would have
// been — even when none are installed.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
    static async materialize(engine: Engine, db: Db, workspaceId: number): Promise<void> {
        const workspace = await db.envelope_get_workspace.get<{ project_root: string | null }>({
            id: workspaceId,
        });
        const projectRoot = workspace?.project_root ?? null;
        const skills: SkillDoc[] = [];
        if (projectRoot !== null) {
            const dir = join(projectRoot, "skills");
            const folders = (await readdir(dir, { withFileTypes: true }).catch(() => []))
                .filter((entry) => entry.isDirectory())
                .toSorted((left, right) => left.name.localeCompare(right.name));
            for (const folder of folders) {
                const raw = await readFile(join(dir, folder.name, "SKILL.md"), "utf8").catch(() => null);
                if (raw === null) continue;
                skills.push(parseSkill(folder.name, raw));
            }
        }

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
