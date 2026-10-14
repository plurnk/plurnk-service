import type { ApplicationPort } from "@plurnk/plurnk-contracts";

// The port functions the binding calls.
export type WorkspacePort = Pick<ApplicationPort, "createWorkspace" | "listWorkspaces">;

// {§a2a-lazy-workspace} — at least one is set: a name selects that workspace, created on the root (or
// headless) when absent; a root alone selects the one workspace on that folder.
export interface A2aWorkspaceConfiguration {
    readonly name: string | null;
    readonly projectRoot: string | null;
}

/** Lazily resolves the workspace owned by one inbound A2A exposure. */
export default class WorkspaceBinding {
    readonly #port: WorkspacePort;
    readonly #configuration: A2aWorkspaceConfiguration;
    #resolution: Promise<number> | null = null;

    constructor(port: WorkspacePort, configuration: A2aWorkspaceConfiguration) {
        this.#port = port;
        this.#configuration = structuredClone(configuration);
    }

    id(): Promise<number> {
        this.#resolution ??= this.#resolve().catch((cause) => {
            this.#resolution = null;
            throw cause;
        });
        return this.#resolution;
    }

    existingId(): Promise<number | null> {
        return this.#resolution ?? this.#find();
    }

    async #resolve(): Promise<number> {
        const existing = await this.#find();
        if (existing !== null) return existing;
        const { name, projectRoot } = this.#configuration;
        if (name !== null) return (await this.#port.createWorkspace({ name, projectRoot })).workspaceId;
        // {§workspace-name} — a root alone takes the ordinary default name, which can belong to a
        // workspace on another folder.
        const created = await this.#port.createWorkspace({ projectRoot });
        if (created.projectRoot !== projectRoot) {
            throw new Error(
                `A2A project root ${JSON.stringify(projectRoot)} selected workspace '${created.workspaceName}' `
                + `on ${JSON.stringify(created.projectRoot)}. PLURNK_A2A_WORKSPACE names the workspace to use.`,
            );
        }
        return created.workspaceId;
    }

    async #find(): Promise<number | null> {
        const { name, projectRoot } = this.#configuration;
        const workspaces = await this.#port.listWorkspaces();
        if (name === null) {
            const onFolder = workspaces.filter(({ project_root }) => project_root === projectRoot);
            if (onFolder.length > 1) {
                throw new Error(
                    `A2A project root ${JSON.stringify(projectRoot)} holds ${onFolder.length} workspaces: `
                    + `${onFolder.map((workspace) => `'${workspace.name}'`).join(", ")}. PLURNK_A2A_WORKSPACE names the one to use.`,
                );
            }
            return onFolder[0]?.id ?? null;
        }
        const matches = workspaces.filter((workspace) => workspace.name === name);
        if (matches.length > 1) {
            throw new Error(`A2A workspace name '${name}' is not unique.`);
        }
        const existing = matches[0];
        if (existing !== undefined) {
            if (projectRoot !== null && existing.project_root !== projectRoot) {
                throw new Error(
                    `A2A workspace '${name}' has project root `
                    + `${JSON.stringify(existing.project_root)}, not configured root `
                    + `${JSON.stringify(projectRoot)}.`,
                );
            }
            return existing.id;
        }
        return null;
    }
}
