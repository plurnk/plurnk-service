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
        if (statement.op === "BARE" || statement.op === "PLAN") return statement;
        if (statement.op === "COPY" || statement.op === "MOVE") {
            return {
                ...statement,
                source: DurableStatement.#projectSelection(statement.source),
                destination: DurableStatement.#projectSelection(statement.destination),
            };
        }
        const target = DurableStatement.#projectPath(statement.target);
        const metadata = statement.metadata === null
            ? null
            : statement.metadata.map(() => DurableStatement.#REDACTED);
        return { ...statement, target, metadata };
    }

    static #projectSelection(selection: ResourceSelection): ResourceSelection {
        return {
            ...selection,
            target: DurableStatement.#projectPath(selection.target),
            metadata: selection.metadata === null
                ? null
                : selection.metadata.map(() => DurableStatement.#REDACTED),
        };
    }

    static #projectPath(path: ParsedPath): ParsedPath;
    static #projectPath(path: null): null;
    static #projectPath(path: ParsedPath | null): ParsedPath | null;
    static #projectPath(path: ParsedPath | null): ParsedPath | null {
        if (path === null || path.kind === "local") return path;
        if (path.username === null && path.password === null) {
            return path;
        }

        const username = path.username === null ? null : DurableStatement.#REDACTED;
        const password = path.password === null ? null : DurableStatement.#REDACTED;
        return {
            ...path,
            raw: DurableStatement.#renderRaw(path, username, password),
            username,
            password,
        };
    }

    static #renderRaw(
        path: UrlPath,
        username: string | null,
        password: string | null,
    ): string {
        const userinfo = username === null && password === null
            ? ""
            : `${username ?? ""}${password === null ? "" : `:${password}`}@`;
        const hostname = path.hostname ?? "";
        const port = path.port === null ? "" : `:${path.port}`;
        const query = path.query === null ? "" : `?${path.query}`;
        const fragment = path.fragment === null ? "" : `#${path.fragment}`;
        return `${path.scheme}://${userinfo}${hostname}${port}${path.pathname}${query}${fragment}`;
    }
}
