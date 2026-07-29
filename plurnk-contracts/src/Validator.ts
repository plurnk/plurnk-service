import { Validator as CfValidator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import noticeSchema from "../schema/Notice.json" with { type: "json" };
import problemDetailsSchema from "../schema/ProblemDetails.json" with { type: "json" };
import operationResultSchema from "../schema/OperationResult.json" with { type: "json" };
import type { Notice, OperationResult, ProblemDetails } from "./types.generated.ts";

export type ValidationResult = { valid: boolean; errors: OutputUnit[] };

export class InvalidNoticeError extends TypeError {}
export class InvalidProblemDetailsError extends TypeError {}
export class InvalidOperationResultError extends TypeError {}

export default class Validator {
    static #notice = new CfValidator(noticeSchema as Schema, "2020-12");
    static #problemDetails = new CfValidator(problemDetailsSchema as Schema, "2020-12");
    static #operationResult = Validator.#withRefs(operationResultSchema, [problemDetailsSchema]);

    static #withRefs(mainSchema: unknown, refSchemas: unknown[]): CfValidator {
        const validator = new CfValidator(mainSchema as Schema, "2020-12");
        for (const ref of refSchemas) validator.addSchema(ref as Schema);
        return validator;
    }

    static validateNotice(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#notice, value);
    }

    static validateProblemDetails(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#problemDetails, value);
    }

    static validateOperationResult(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#operationResult, value);
    }

    static assertNotice<T extends Notice>(value: T): T {
        const result = Validator.validateNotice(value);
        if (!result.valid) throw new InvalidNoticeError(`invalid Notice: ${JSON.stringify(result.errors)}`);
        return value;
    }

    static assertProblemDetails<T extends ProblemDetails>(value: T): T {
        const result = Validator.validateProblemDetails(value);
        if (!result.valid) {
            throw new InvalidProblemDetailsError(`invalid RFC 9457 Problem Details: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertOperationResult<T extends OperationResult>(value: T): T {
        const result = Validator.validateOperationResult(value);
        if (!result.valid) {
            throw new InvalidOperationResultError(`invalid operation result: ${JSON.stringify(result.errors)}`);
        }
        if (value.problem !== undefined && value.problem.status !== value.status) {
            throw new InvalidOperationResultError(
                `operation result status ${value.status} does not match problem status ${value.problem.status}`,
            );
        }
        return value;
    }

    static #validate(validator: CfValidator, value: unknown): ValidationResult {
        const result = validator.validate(value);
        return { valid: result.valid, errors: result.errors };
    }
}
