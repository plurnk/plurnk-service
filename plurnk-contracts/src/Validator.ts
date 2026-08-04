import { Validator as CfValidator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import positionSchema from "../schema/Position.json" with { type: "json" };
import lineMarkerSchema from "../schema/LineMarker.json" with { type: "json" };
import channelContentSchema from "../schema/ChannelContent.json" with { type: "json" };
import parsedPathSchema from "../schema/ParsedPath.json" with { type: "json" };
import matcherBodySchema from "../schema/MatcherBody.json" with { type: "json" };
import sendBodySchema from "../schema/SendBody.json" with { type: "json" };
import resourceSelectionSchema from "../schema/ResourceSelection.json" with { type: "json" };
import schemeRegistrationSchema from "../schema/SchemeRegistration.json" with { type: "json" };
import providerDeclarationSchema from "../schema/ProviderDeclaration.json" with { type: "json" };
import plurnkStatementSchema from "../schema/PlurnkStatement.json" with { type: "json" };
import clientStatementSchema from "../schema/ClientStatement.json" with { type: "json" };
import noticeSchema from "../schema/Notice.json" with { type: "json" };
import problemDetailsSchema from "../schema/ProblemDetails.json" with { type: "json" };
import operationResultSchema from "../schema/OperationResult.json" with { type: "json" };
import textRegionSchema from "../schema/TextRegion.json" with { type: "json" };
import proposalProjectionSchema from "../schema/ProposalProjection.json" with { type: "json" };
import proposalDispositionSchema from "../schema/ProposalDisposition.json" with { type: "json" };
import loopFlagsSchema from "../schema/LoopFlags.json" with { type: "json" };
import type { Notice, OperationResult, ProblemDetails, ProposalProjection, TextRegion } from "./types.generated.ts";

export type ValidationResult = { valid: boolean; errors: OutputUnit[] };

export class InvalidNoticeError extends TypeError {}
export class InvalidProblemDetailsError extends TypeError {}
export class InvalidOperationResultError extends TypeError {}
export class InvalidTextRegionError extends TypeError {}
export class InvalidProposalProjectionError extends TypeError {}

export default class Validator {
    static #position = new CfValidator(positionSchema as Schema, "2020-12");
    static #lineMarker = new CfValidator(lineMarkerSchema as Schema, "2020-12");
    static #channelContent = new CfValidator(channelContentSchema as Schema, "2020-12");
    static #parsedPath = new CfValidator(parsedPathSchema as Schema, "2020-12");
    static #matcherBody = new CfValidator(matcherBodySchema as Schema, "2020-12");
    static #sendBody = new CfValidator(sendBodySchema as Schema, "2020-12");
    static #schemeRegistration = new CfValidator(schemeRegistrationSchema as Schema, "2020-12");
    static #providerDeclaration = new CfValidator(providerDeclarationSchema as Schema, "2020-12");
    static #plurnkStatement = Validator.#withRefs(
        plurnkStatementSchema,
        [
            positionSchema,
            lineMarkerSchema,
            parsedPathSchema,
            matcherBodySchema,
            sendBodySchema,
            resourceSelectionSchema,
        ],
    );
    static #clientStatement = Validator.#withRefs(
        clientStatementSchema,
        [
            plurnkStatementSchema,
            positionSchema,
            lineMarkerSchema,
            parsedPathSchema,
            matcherBodySchema,
            sendBodySchema,
            resourceSelectionSchema,
        ],
    );
    static #notice = new CfValidator(noticeSchema as Schema, "2020-12");
    static #problemDetails = new CfValidator(problemDetailsSchema as Schema, "2020-12");
    static #operationResult = Validator.#withRefs(operationResultSchema, [problemDetailsSchema]);
    static #textRegion = new CfValidator(textRegionSchema as Schema, "2020-12");
    static #proposalProjection = Validator.#withRefs(
        proposalProjectionSchema,
        [proposalDispositionSchema, loopFlagsSchema],
    );

    static #withRefs(mainSchema: unknown, refSchemas: unknown[]): CfValidator {
        const validator = new CfValidator(mainSchema as Schema, "2020-12");
        const mainId = (mainSchema as { $id?: string }).$id;
        for (const ref of refSchemas) {
            if ((ref as { $id?: string }).$id === mainId) continue;
            validator.addSchema(ref as Schema);
        }
        return validator;
    }

    static validatePosition(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#position, value);
    }

    static validateLineMarker(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#lineMarker, value);
    }

    static validateChannelContent(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#channelContent, value);
    }

    static validateParsedPath(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#parsedPath, value);
    }

    static validateMatcherBody(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#matcherBody, value);
    }

    static validateSendBody(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#sendBody, value);
    }

    static validateSchemeRegistration(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#schemeRegistration, value);
    }

    static validateProviderDeclaration(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#providerDeclaration, value);
    }

    static validatePlurnkStatement(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#plurnkStatement, value);
    }

    static validateClientStatement(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#clientStatement, value);
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

    static validateTextRegion(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#textRegion, value);
    }

    static validateProposalProjection(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#proposalProjection, value);
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

    static assertTextRegion<T extends TextRegion>(value: T): T {
        const result = Validator.validateTextRegion(value);
        if (!result.valid) {
            throw new InvalidTextRegionError(`invalid TextRegion: ${JSON.stringify(result.errors)}`);
        }
        if (
            value.endLine < value.startLine
            || (value.endLine === value.startLine && value.endColumn < value.startColumn)
        ) {
            throw new InvalidTextRegionError("TextRegion ends before it starts");
        }
        return value;
    }

    static assertProposalProjection<T extends ProposalProjection>(value: T): T {
        const result = Validator.validateProposalProjection(value);
        if (!result.valid) {
            throw new InvalidProposalProjectionError(
                `invalid ProposalProjection: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static #validate(validator: CfValidator, value: unknown): ValidationResult {
        const result = validator.validate(value);
        return { valid: result.valid, errors: result.errors };
    }
}
