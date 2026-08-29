import { PathSyntax, PlurnkParser } from "@plurnk/plurnk-contracts";
import RuntimeSummary from "./RuntimeSummary.ts";
import type {
    RuntimeBodyDecl,
    RuntimeInvocationExample,
    RuntimeInvocation as RuntimeInvocationDecl,
    RuntimeRegisteredTool,
    RuntimeToolRegistry,
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

const exampleLineOf = (
    value: unknown,
    field: string,
    fail: (detail: string) => never,
): string => {
    if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || /[\r\n]/.test(value)) {
        fail(`${field} must be one non-empty canonical line`);
    }
    return value;
};

const oneExecSection = (source: string, expectedTarget?: string): boolean => {
    const parsed = PlurnkParser.parseStatements(source);
    const statements = parsed.items.filter((item) => item.kind === "statement");
    const errors = parsed.items.filter((item) => item.kind === "error");
    const statement = statements[0]?.statement;
    return statements.length === 1
        && statement?.op === "EXEC"
        && (expectedTarget === undefined || statement.target?.raw === expectedTarget)
        && errors.length === 0
        && parsed.unparsedTail === undefined;
};

export default class RuntimeInvocation {
    static assert(value: unknown, packageName: string, runtime: string): RuntimeInvocationDecl {
        const fail = (detail: string): never => {
            throw new Error(`runtime declaration invalid: ${packageName} '${runtime}' ${detail}`);
        };
        const invocation = recordOf(value, "invocation", fail);
        assertKnownFields(invocation, new Set(["body", "target", "exclusive", "example", "signature"]), "invocation", fail);

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
        let target: RuntimeTargetDecl | undefined;
        if ("target" in invocation) {
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
            target = {
                role: roleOf(targetValue.role, "invocation.target.role", fail),
                required: requiredOf(targetValue.required, "invocation.target.required", fail),
                kind,
                ...(directory === undefined ? {} : { directory }),
            };
        } else if (exclusive) {
            fail("exclusive invocation must declare a target");
        }

        const hasExample = "example" in invocation;
        const hasSignature = "signature" in invocation;
        if (hasExample === hasSignature) {
            fail("invocation must provide exactly one example or signature");
        }

        const shape: {
            body: RuntimeBodyDecl;
            target?: RuntimeTargetDecl;
            exclusive?: true;
        } = {
            body,
            ...(target === undefined ? {} : { target }),
            ...(exclusive ? { exclusive: true } : {}),
        };
        if (hasSignature) {
            return {
                ...shape,
                signature: exampleLineOf(invocation.signature, "invocation.signature", fail),
            };
        }

        const exampleValue = recordOf(invocation.example, "invocation.example", fail);
        assertKnownFields(exampleValue, new Set(["body", "target"]), "invocation.example", fail);
        const example: RuntimeInvocationExample = {
            ...("body" in exampleValue
                ? { body: exampleLineOf(exampleValue.body, "invocation.example.body", fail) }
                : {}),
            ...("target" in exampleValue
                ? { target: exampleLineOf(exampleValue.target, "invocation.example.target", fail) }
                : {}),
        };
        const hasBody = example.body !== undefined;
        const hasTarget = example.target !== undefined;
        if (!hasBody && !hasTarget) fail("invocation.example must provide a body or target");
        if (body.required && !hasBody) fail("invocation.example must provide the required body");
        if (target === undefined && hasTarget) fail("invocation.example cannot provide a refused target");
        if (target?.required === true && !hasTarget) fail("invocation.example must provide the required target");
        if (exclusive && hasBody && hasTarget) fail("invocation.example must provide exactly one exclusive input");

        const exampleTarget = example.target === undefined
            ? ""
            : ` (${PathSyntax.escapeTarget(example.target)})`;
        const source = `## EXEC0 [${runtime}]${exampleTarget}${hasBody ? `\n${example.body}` : ""}`;
        if (!oneExecSection(source)) {
            fail("invocation.example must render one valid EXEC section");
        }

        return { ...shape, example };
    }

    static assertToolRegistry(
        value: unknown,
        packageName: string,
        runtime: string,
    ): RuntimeToolRegistry {
        const fail = (detail: string): never => {
            throw new Error(`runtime declaration invalid: ${packageName} '${runtime}' ${detail}`);
        };
        const registry = recordOf(value, "tool registry", fail);
        assertKnownFields(registry, new Set(["tools"]), "tool registry", fail);
        const toolValues: unknown[] = Array.isArray(registry.tools)
            ? registry.tools
            : fail("tool registry.tools must be an array");
        const targets = new Set<string>();
        const tools = toolValues.map((value, index): RuntimeRegisteredTool => {
            const tool = recordOf(value, `tool registry.tools[${index}]`, fail);
            assertKnownFields(tool, new Set(["target", "summary", "invocation", "details"]), `tool registry.tools[${index}]`, fail);
            const exactTarget = exampleLineOf(tool.target, `tool registry.tools[${index}].target`, fail);
            const summary = RuntimeSummary.assertLine(tool.summary, `tool registry.tools[${index}].summary`, fail);
            if ("details" in tool && typeof tool.details !== "string") {
                fail(`tool registry.tools[${index}].details must be a string`);
            }
            const escapedTarget = PathSyntax.escapeTarget(exactTarget);
            if (!oneExecSection(`## EXEC0 [${runtime}] (${escapedTarget})`, exactTarget)) {
                fail(`tool registry.tools[${index}] target '${exactTarget}' must render one valid EXEC section`);
            }
            const invocation = RuntimeInvocation.assert(tool.invocation, packageName, runtime);
            if (
                invocation.target?.required !== true
                || invocation.target.kind !== "literal"
            ) {
                fail(`tool registry.tools[${index}].invocation must declare a required literal target`);
            }
            if (invocation.example?.target !== undefined && invocation.example.target !== exactTarget) {
                fail(`tool registry.tools[${index}] target '${exactTarget}' conflicts with invocation.example.target '${invocation.example.target}'`);
            }
            if (targets.has(exactTarget)) {
                fail(`tool registry contains duplicate exact target '${exactTarget}'`);
            }
            targets.add(exactTarget);
            return {
                target: exactTarget,
                summary,
                invocation,
                ...(tool.details === undefined ? {} : { details: tool.details as string }),
            };
        });
        return { tools };
    }
}
