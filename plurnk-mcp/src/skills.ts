// {§mcp-skills} SEP-2640 Skills over MCP: manifest digest computation and verified file materialization.

import { createHash } from "node:crypto";
import { DIRECTORY_MIME_TYPE, type Skill } from "@modelcontextprotocol/core/ext/skills";
import type ServerConnection from "./client.ts";

export interface VerifiedSkillFile {
    readonly path: string;
    readonly base64: string;
}

export const computeSkillCommit = (skill: Skill, skillMdBytes?: Uint8Array): string => {
    const hash = createHash("sha256");
    if (Array.isArray(skill.resources)) {
        hash.update(
            JSON.stringify({
                uri: skill.uri,
                frontmatter: skill.frontmatter,
                resources: [...skill.resources]
                    .map((r) => ({ uri: r.uri, digest: r.digest, size: r.size }))
                    .toSorted((a, b) => a.uri.localeCompare(b.uri)),
            }),
        );
    } else {
        hash.update(
            JSON.stringify({
                uri: skill.uri,
                frontmatter: skill.frontmatter,
                skillMdSha256:
                    skillMdBytes !== undefined
                        ? createHash("sha256").update(skillMdBytes).digest("hex")
                        : null,
            }),
        );
    }
    return hash.digest("hex");
};

export const relativePathFromSkillUri = (skillUri: string, resourceUri: string): string => {
    const rootPrefix = skillUri.endsWith("/SKILL.md")
        ? skillUri.slice(0, skillUri.length - "SKILL.md".length)
        : skillUri;
    if (!resourceUri.startsWith(rootPrefix)) {
        throw new Error(`Skill resource '${resourceUri}' is outside skill root '${rootPrefix}'.`);
    }
    const rawRel = resourceUri.slice(rootPrefix.length);
    const segments = rawRel.split("/").map((seg) => decodeURIComponent(seg));
    if (segments.length === 0 || segments.some((seg) => seg.length === 0 || seg === "." || seg === "..")) {
        throw new Error(`Invalid relative skill resource path '${rawRel}'.`);
    }
    return segments.join("/");
};

export const fetchVerifiedSkillFiles = async (
    connection: ServerConnection,
    skill: Skill,
    signal?: AbortSignal,
): Promise<{
    readonly commit: string;
    readonly files: readonly VerifiedSkillFile[];
}> => {
    const mainFile = await connection.readSkill(skill, undefined, signal);
    const commit = computeSkillCommit(skill, mainFile.bytes);
    const files: VerifiedSkillFile[] = [
        {
            path: "SKILL.md",
            base64: Buffer.from(mainFile.bytes).toString("base64"),
        },
    ];

    if (Array.isArray(skill.resources)) {
        for (const entry of skill.resources) {
            if (entry.uri === skill.uri) continue;
            const relPath = relativePathFromSkillUri(skill.uri, entry.uri);
            if (relPath === "SKILL.md") continue;
            const file = await connection.readSkill(skill, entry.uri, signal);
            files.push({
                path: relPath,
                base64: Buffer.from(file.bytes).toString("base64"),
            });
        }
    } else {
        const rootDirUri = skill.uri.endsWith("/SKILL.md")
            ? skill.uri.slice(0, skill.uri.length - "/SKILL.md".length)
            : skill.uri;
        const visitedDirs = new Set<string>();
        const walkDir = async (dirUri: string, prefix: string): Promise<void> => {
            if (visitedDirs.has(dirUri)) return;
            visitedDirs.add(dirUri);
            const { directoryRead, resources } = await connection.readSkillDirectory(dirUri, signal);
            if (!directoryRead) return;
            for (const res of resources) {
                if (res.uri === skill.uri || (prefix === "" && res.name === "SKILL.md")) continue;
                if (res.name.length === 0 || res.name === "." || res.name === ".." || res.name.includes("/")) {
                    throw new Error(`Invalid directory child name '${res.name}' in '${dirUri}'.`);
                }
                if (res.mimeType === DIRECTORY_MIME_TYPE) {
                    await walkDir(res.uri, `${prefix}${res.name}/`);
                } else {
                    const relPath = `${prefix}${res.name}`;
                    const file = await connection.readSkill(skill, relPath, signal);
                    files.push({
                        path: relPath,
                        base64: Buffer.from(file.bytes).toString("base64"),
                    });
                }
            }
        };
        await walkDir(rootDirUri, "");
    }

    return { commit, files };
};
