import Validator from "./Validator.ts";
import type { ProblemDetails } from "./types.generated.ts";

const TYPE_ROOT = "https://problems.plurnk.dev";
const OWNER = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/;
const CODE = /^[a-z][a-z0-9-]*$/;

export interface ProblemOptions {
    readonly title?: string;
}

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
}
