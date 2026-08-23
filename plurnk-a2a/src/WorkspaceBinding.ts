import type { ApplicationPort } from "@plurnk/plurnk-contracts";

export interface A2aWorkspaceConfiguration {
    readonly name: string;
    /** Required only when creating a new workspace; null adopts an existing named workspace. */
    readonly projectRoot: string | null;
}

/** Lazily resolves the workspace owned by one inbound A2A exposure. */
export default class WorkspaceBinding {
    readonly #port: ApplicationPort;
    readonly #configuration: A2aWorkspaceConfiguration;
    #resolution: Promise<number> | null = null;

    constructor(port: ApplicationPort, configuration: A2aWorkspaceConfiguration) {
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

    async #resolve(): Promise<number> {
        const matches = (await this.#port.listWorkspaces())
            .filter(({ name }) => name === this.#configuration.name);
        if (matches.length > 1) {
            throw new Error(`A2A workspace name '${this.#configuration.name}' is not unique.`);
        }
        const existing = matches[0];
        if (existing !== undefined) {
            if (
                this.#configuration.projectRoot !== null
                && existing.project_root !== this.#configuration.projectRoot
            ) {
                throw new Error(
                    `A2A workspace '${this.#configuration.name}' has project root `
                    + `${JSON.stringify(existing.project_root)}, not configured root `
                    + `${JSON.stringify(this.#configuration.projectRoot)}.`,
                );
            }
            return existing.id;
        }
        const created = await this.#port.createWorkspace({
            name: this.#configuration.name,
            projectRoot: this.#configuration.projectRoot,
        });
        return created.workspaceId;
    }
}
