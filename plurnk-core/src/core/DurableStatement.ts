import type {
    ParsedPath,
    PlurnkStatement,
    ResourceSelection,
    UrlPath,
} from "@plurnk/plurnk-contracts";

// One pre-persistence projection for ordinary operation rows. Execution keeps
// the exact parsed statement; provider evidence keeps its separate exact
// contract. {§log-sensitive-request-evidence}
export default class DurableStatement {
    static readonly #REDACTED = "__redacted__";

    static project(statement: PlurnkStatement): PlurnkStatement {
        if (statement.op === "BARE") return statement;
        const target = DurableStatement.#projectPath(statement.target);
        if (statement.op === "COPY" || statement.op === "MOVE") {
            return {
                ...statement,
                target,
                body: DurableStatement.#projectSelection(statement.body),
            };
        }
        return { ...statement, target };
    }

    static #projectSelection(selection: ResourceSelection | null): ResourceSelection | null {
        return selection === null
            ? null
            : { ...selection, target: DurableStatement.#projectPath(selection.target) };
    }

    static #projectPath(path: ParsedPath): ParsedPath;
    static #projectPath(path: null): null;
    static #projectPath(path: ParsedPath | null): ParsedPath | null;
    static #projectPath(path: ParsedPath | null): ParsedPath | null {
        if (path === null || path.kind === "local") return path;
        if (path.username === null && path.password === null && (path.headers?.length ?? 0) === 0) {
            return path;
        }

        const username = path.username === null ? null : DurableStatement.#REDACTED;
        const password = path.password === null ? null : DurableStatement.#REDACTED;
        const headers = path.headers?.map(([name]) => [name, DurableStatement.#REDACTED] as [string, string]);
        return {
            ...path,
            raw: DurableStatement.#renderRaw(path, username, password, headers),
            username,
            password,
            ...(headers === undefined ? {} : { headers }),
        };
    }

    static #renderRaw(
        path: UrlPath,
        username: string | null,
        password: string | null,
        headers: [string, string][] | undefined,
    ): string {
        const userinfo = username === null && password === null
            ? ""
            : `${username ?? ""}${password === null ? "" : `:${password}`}@`;
        const hostname = path.hostname ?? "";
        const port = path.port === null ? "" : `:${path.port}`;
        const query = path.query === null ? "" : `?${path.query}`;
        const fragment = path.fragment === null ? "" : `#${path.fragment}`;
        const metadata = headers?.map(([name, value]) => `{${name}: ${value}}`).join("") ?? "";
        return `${path.scheme}://${userinfo}${hostname}${port}${path.pathname}${query}${fragment}${metadata}`;
    }
}
