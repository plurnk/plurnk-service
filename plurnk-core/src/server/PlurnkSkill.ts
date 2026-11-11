import { errnoCode } from "@plurnk/plurnk-contracts";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, type SkillDocument, type SkillTree } from "@plurnk/plurnk-agent-skills";
import Meta, { TEACHING_CORPUS } from "@plurnk/plurnk-meta";
import { FileByteSource, GeneratedByteSource, type ByteSource } from "@plurnk/plurnk-schemes";
import Paths from "../Paths.ts";
import EnvDefaults from "../core/env-defaults.ts";

const SERVICE = "@plurnk/plurnk-service";
const ACP_SDK = "@agentclientprotocol/sdk";
const ACP_SDK_PREFIXES = ["dist/v2/", "dist/transports/", "dist/core/", "dist/mcp/"] as const;

const isAcpSdkDeclaration = (rel: string): boolean =>
    !rel.endsWith("/zod.gen.d.ts")
    && (rel === "dist/protocol-router.d.ts" || ACP_SDK_PREFIXES.some((prefix) => rel.startsWith(prefix)));

// {§tools-resource-materialization} Core composes sources; their packages remain their authors.
export default class PlurnkSkill implements SkillTree {
    static readonly CHAPTER_NAMES: ReadonlySet<string> = new Set([
        "configuration",
        "copy-move",
        "delegation",
        "extensibility",
        "https",
        "models",
        "pattern",
        "recipes",
        "session",
        "wss",
    ]);

    readonly document: SkillDocument;
    readonly #nodeModules: string;
    readonly #files = new Map([
        ["SKILL.md", Paths.teachingSource(TEACHING_CORPUS.skill)],
        ["configuration.md", Paths.configuration],
        ["configuration/plurnk.nginx.conf", Paths.nginxConfig],
        ["configuration/plurnk.service", Paths.systemdUnit],
        ["copy-move.md", resolve(dirname(Paths.configuration), "docs/copy-move.md")],
        ["delegation.md", Paths.teachingSource(TEACHING_CORPUS.docs.delegation.source)],
        ["extensibility.md", Paths.teachingSource(TEACHING_CORPUS.skillChapters.extensibility)],
        ["https.md", resolve(dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-schemes-http/package.json"))), "docs/https.md")],
        ["models.md", resolve(dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-providers/package.json"))), "docs/models.md")],
        ["pattern.md", Paths.teachingSource(TEACHING_CORPUS.docs.pattern.source)],
        ["recipes.md", Paths.teachingSource(TEACHING_CORPUS.skillChapters.recipes)],
        ["session.md", Paths.teachingSource(TEACHING_CORPUS.docs.session.source)],
        ["wss.md", resolve(dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-schemes-http/package.json"))), "docs/wss.md")],
    ]);

    private constructor(document: SkillDocument, nodeModules: string) {
        this.document = document;
        this.#nodeModules = nodeModules;
    }

    static async load(nodeModules: string): Promise<PlurnkSkill> {
        const file = Paths.teachingSource(TEACHING_CORPUS.skill);
        return new PlurnkSkill(parseSkill(file, "plurnk", await readFile(file, "utf8")), nodeModules);
    }

    async list(): Promise<string[]> {
        return [...this.#files.keys(), "configuration/.env.defaults", ...(await this.#contracts()).keys()].toSorted();
    }

    resource(pathname: string): ByteSource {
        const file = this.#files.get(pathname);
        if (file !== undefined) return new FileByteSource(async () => file);
        if (pathname.startsWith("packages/")) return new FileByteSource(async () => (await this.#contracts()).get(pathname) ?? null);
        return new GeneratedByteSource(async () => {
            if (pathname !== "configuration/.env.defaults") return null;
            const files = await EnvDefaults.collect(dirname(Paths.configuration), this.#nodeModules);
            return new TextEncoder().encode(EnvDefaults.renderCatalog(files));
        });
    }

    // The service's own contract, each installed ecosystem member's SPEC.md + dist/**/*.d.ts, and
    // the installed ACP v2 SDK declarations (`@agentclientprotocol/sdk`). The service's
    // declarations are its internals, not a contract.
    async #contracts(): Promise<ReadonlyMap<string, string>> {
        const candidates = await Meta.packageDirs(this.#nodeModules);
        const members = EnvDefaults.members(candidates);
        const contracts = new Map<string, string>();
        for (const { name, dir } of [{ name: SERVICE, dir: Paths.packageRoot }, ...members.filter((member) => member.name !== SERVICE)]) {
            if (!await PlurnkSkill.#isFile(join(dir, "SPEC.md"))) continue;
            contracts.set(`packages/${name}/SPEC.md`, join(dir, "SPEC.md"));
            if (name === SERVICE) continue;
            for (const file of await PlurnkSkill.#declarations(join(dir, "dist"))) {
                contracts.set(`packages/${name}/${relative(dir, file).replaceAll("\\", "/")}`, file);
            }
        }
        const acpDir = candidates.find((candidate) => candidate.name === ACP_SDK)?.dir
            ?? members.filter((member) => member.name === "@plurnk/plurnk-acp")
                .map((member) => join(member.dir, "node_modules", "@agentclientprotocol", "sdk"))[0];
        if (acpDir !== undefined) {
            for (const file of await PlurnkSkill.#declarations(join(acpDir, "dist"))) {
                const rel = relative(acpDir, file).replaceAll("\\", "/");
                if (isAcpSdkDeclaration(rel)) contracts.set(`packages/${ACP_SDK}/${rel}`, file);
            }
        }
        return contracts;
    }

    static async #isFile(file: string): Promise<boolean> {
        try {
            return (await stat(file)).isFile();
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT") return false;
            throw cause;
        }
    }

    // Regular `.d.ts` files beneath `dist/`; a symbolic link is never followed out of the package.
    static async #declarations(dist: string): Promise<string[]> {
        try {
            return (await readdir(dist, { recursive: true, withFileTypes: true }))
                .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
                .map((entry) => join(entry.parentPath, entry.name));
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT") return [];
            throw cause;
        }
    }
}
