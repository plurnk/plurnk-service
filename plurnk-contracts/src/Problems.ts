import Validator from "./Validator.ts";
import type { ProblemDetails, ProblemProjection } from "./types.generated.ts";

const TYPE_ROOT = "https://problems.plurnk.xyz";
const OWNER = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/;
const CODE = /^[a-z][a-z0-9-]*$/;

export interface ProblemOptions {
    readonly title?: string;
}

export interface ProblemProjectionContext {
    readonly status: number;
    readonly row?: Readonly<Record<string, unknown>>;
}

const sameFact = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left)
            && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => sameFact(value, right[index]));
    }
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
    const leftEntries = Object.entries(left);
    const rightRecord = right as Record<string, unknown>;
    return leftEntries.length === Object.keys(rightRecord).length
        && leftEntries.every(([key, value]) => Object.hasOwn(rightRecord, key) && sameFact(value, rightRecord[key]));
};

export default class Problems {
    static create(
        owner: string,
        code: string,
        status: number,
        detail: string,
        extensions: Readonly<Record<string, unknown>> = {},
        options: ProblemOptions = {},
    ): ProblemDetails {
        if (!OWNER.test(owner)) {
            throw new Error(`problem owner must be a colon-delimited lowercase identifier; got ${JSON.stringify(owner)}`);
        }
        if (!CODE.test(code)) {
            throw new Error(`problem code must be a lowercase kebab-case identifier; got ${JSON.stringify(code)}`);
        }
        const title = options.title ?? code.charAt(0).toUpperCase() + code.slice(1).replaceAll("-", " ");
        return Validator.assertProblemDetails({
            ...extensions,
            type: `${TYPE_ROOT}/${owner.replaceAll(":", "/")}/${code}`,
            title,
            status,
            detail,
        });
    }

    static project(problem: ProblemDetails, context: ProblemProjectionContext): ProblemProjection {
        Validator.assertProblemDetails(problem);
        if (problem.status !== context.status) {
            throw new TypeError(`Problem status ${problem.status} does not match enclosing status ${context.status}.`);
        }
        const projection: Record<string, unknown> = {
            type: problem.type,
            detail: problem.detail,
        };
        for (const [key, value] of Object.entries(problem)) {
            if (key === "type" || key === "title" || key === "status" || key === "detail" || key === "instance") continue;
            if (context.row !== undefined && Object.hasOwn(context.row, key) && sameFact(value, context.row[key])) continue;
            projection[key] = value;
        }
        return Validator.assertProblemProjection(projection as ProblemProjection);
    }
}
