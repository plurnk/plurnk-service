import type {
    RuntimeBodyDecl,
    RuntimeInvocation as RuntimeInvocationDecl,
    RuntimeTargetDecl,
    RuntimeTargetKind,
} from "./types.ts";

const TARGET_KINDS = new Set<RuntimeTargetKind>(["literal", "path", "resource"]);

const recordOf = (
    value: unknown,
    field: string,
    fail: (detail: string) => never,
): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
};

const assertKnownFields = (
    value: Readonly<Record<string, unknown>>,
    allowed: ReadonlySet<string>,
    field: string,
    fail: (detail: string) => never,
): void => {
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown !== undefined) fail(`${field} has unknown field '${unknown}'`);
};

const roleOf = (
    value: unknown,
    field: string,
    fail: (detail: string) => never,
): string => {
    if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value)) {
        fail(`${field} must be one non-empty line`);
    }
    return value.trim();
};

const requiredOf = (
    value: unknown,
    field: string,
    fail: (detail: string) => never,
): boolean => {
    if (typeof value !== "boolean") fail(`${field} must be boolean`);
    return value;
};

export default class RuntimeInvocation {
    static assert(value: unknown, packageName: string, runtime: string): RuntimeInvocationDecl {
        const fail = (detail: string): never => {
            throw new Error(`runtime declaration invalid: ${packageName} '${runtime}' ${detail}`);
        };
        const invocation = recordOf(value, "invocation", fail);
        assertKnownFields(invocation, new Set(["body", "target", "exclusive"]), "invocation", fail);

        const bodyValue = recordOf(invocation.body, "invocation.body", fail);
        assertKnownFields(bodyValue, new Set(["role", "required"]), "invocation.body", fail);
        const body: RuntimeBodyDecl = {
            role: roleOf(bodyValue.role, "invocation.body.role", fail),
            required: requiredOf(bodyValue.required, "invocation.body.required", fail),
        };

        let exclusive = false;
        if ("exclusive" in invocation) {
            exclusive = requiredOf(invocation.exclusive, "invocation.exclusive", fail);
        }
        if (!("target" in invocation)) {
            if (exclusive) fail("exclusive invocation must declare a target");
            return { body };
        }
        const targetValue = recordOf(invocation.target, "invocation.target", fail);
        assertKnownFields(targetValue, new Set(["role", "required", "kind", "directory"]), "invocation.target", fail);
        if (typeof targetValue.kind !== "string" || !TARGET_KINDS.has(targetValue.kind as RuntimeTargetKind)) {
            fail("invocation.target.kind must be literal, path, or resource");
        }
        const kind = targetValue.kind as RuntimeTargetKind;
        let directory: "cwd" | undefined;
        if ("directory" in targetValue) {
            if (targetValue.directory !== "cwd") fail("invocation.target.directory must be cwd");
            if (kind === "literal") fail("literal target cannot route a directory to cwd");
            directory = "cwd";
        }
        const target: RuntimeTargetDecl = {
            role: roleOf(targetValue.role, "invocation.target.role", fail),
            required: requiredOf(targetValue.required, "invocation.target.required", fail),
            kind,
            ...(directory === undefined ? {} : { directory }),
        };
        return { body, target, ...(exclusive ? { exclusive: true } : {}) };
    }
}
