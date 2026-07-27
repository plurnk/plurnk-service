// Runtime-neutral mirror of @plurnk/plurnk-grammar/schema/Notice.json.
export type NoticeLevel = "error" | "warn" | "info";

export interface Notice {
    readonly source: string;
    readonly kind: string;
    readonly level: NoticeLevel;
    readonly message?: string | null;
    readonly position?: ContentOffset | LogCoordinate | null;
    readonly [k: string]: unknown;
}

export interface ContentOffset {
    readonly type: "content-offset";
    readonly line: number;
    readonly column: number;
}

export interface LogCoordinate {
    readonly type: "log-coordinate";
    readonly coordinate: string;
    readonly op?: string;
}
