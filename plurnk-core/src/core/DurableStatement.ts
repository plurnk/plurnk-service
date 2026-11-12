import { TurnDisposition } from "@plurnk/plurnk-contracts";
import type {
    ParsedPath,
    PlurnkStatement,
    ResourceSelection,
    UrlPath,
} from "@plurnk/plurnk-contracts";

// One pre-persistence projection for ordinary operation rows. Execution keeps
// the exact parsed statement; provider evidence keeps its separate exact
// contract. {§log-history-projection}
export default class DurableStatement {
    static readonly #REDACTED = "__redacted__";

    static project(statement: PlurnkStatement): PlurnkStatement {
        if (statement.op === "bare" || statement.op === "note" || TurnDisposition.is(statement)) return statement;
        if (statement.op === "copy" || statement.op === "move") {
            return {
                ...statement,
                source: DurableStatement.#projectSelection(statement.source),
                destination: DurableStatement.#projectSelection(statement.destination),
            };
        }
        const target = DurableStatement.projectPath(statement.target);
        if (!("headers" in statement)) {
            return { ...statement, target };
        }
        const headers = DurableStatement.#projectHeaders(statement.headers);
        return { ...statement, target, headers };
    }

    static #projectSelection(selection: ResourceSelection): ResourceSelection {
        return {
            ...selection,
            target: DurableStatement.projectPath(selection.target),
            headers: DurableStatement.#projectHeaders(selection.headers),
        };
    }

    static #projectHeaders(headers: Readonly<Record<string, string>> | null): Record<string, string> | null {
        if (headers === null) return null;
        return Object.fromEntries(Object.keys(headers).map((key) => [key, DurableStatement.#REDACTED]));
    }

    static projectPath(path: ParsedPath): ParsedPath;
    static projectPath(path: null): null;
    static projectPath(path: ParsedPath | null): ParsedPath | null;
    static projectPath(path: ParsedPath | null): ParsedPath | null {
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
