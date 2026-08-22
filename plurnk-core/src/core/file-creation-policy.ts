// {§operator-config-file-create-scope}: one ordered service/workspace ceiling for
// filesystem creation. Admission itself remains owned by file membership; this module
// only parses and composes the configuration contract.

export const FILE_CREATE_SCOPES = ["none", "root", "namespace"] as const;
export type FileCreateScope = typeof FILE_CREATE_SCOPES[number];

const rank = new Map<FileCreateScope, number>(FILE_CREATE_SCOPES.map((scope, index) => [scope, index]));

export default class FileCreationPolicy {
    static parse(value: unknown, name: string): FileCreateScope {
        if (typeof value !== "string" || !rank.has(value as FileCreateScope)) {
            throw new TypeError(`${name} must be one of ${FILE_CREATE_SCOPES.join(", ")}; got ${JSON.stringify(value)}`);
        }
        return value as FileCreateScope;
    }

    static serviceScope(env: NodeJS.ProcessEnv = process.env): FileCreateScope {
        return FileCreationPolicy.parse(env.PLURNK_SERVICE_FILE_CREATE_SCOPE, "PLURNK_SERVICE_FILE_CREATE_SCOPE");
    }

    static effective(service: FileCreateScope, workspace: FileCreateScope | null): FileCreateScope {
        if (workspace === null) return service;
        return (rank.get(workspace) ?? 0) < (rank.get(service) ?? 0) ? workspace : service;
    }

    static admits(scope: FileCreateScope, outsideRoot: boolean): boolean {
        return scope === "namespace" || (scope === "root" && !outsideRoot);
    }
}
