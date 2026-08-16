import { Validator as CfValidator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import positionSchema from "../schema/Position.json" with { type: "json" };
import lineMarkerSchema from "../schema/LineMarker.json" with { type: "json" };
import textLineMarkerSchema from "../schema/TextLineMarker.json" with { type: "json" };
import parsedPathSchema from "../schema/ParsedPath.json" with { type: "json" };
import matcherBodySchema from "../schema/MatcherBody.json" with { type: "json" };
import sendBodySchema from "../schema/SendBody.json" with { type: "json" };
import resourceSelectionSchema from "../schema/ResourceSelection.json" with { type: "json" };
import plurnkStatementSchema from "../schema/PlurnkStatement.json" with { type: "json" };
import clientStatementSchema from "../schema/ClientStatement.json" with { type: "json" };
import noticeSchema from "../schema/Notice.json" with { type: "json" };
import problemDetailsSchema from "../schema/ProblemDetails.json" with { type: "json" };
import operationResultSchema from "../schema/OperationResult.json" with { type: "json" };
import entryReadResultSchema from "../schema/EntryReadResult.json" with { type: "json" };
import textRegionSchema from "../schema/TextRegion.json" with { type: "json" };
import rangeExtentSchema from "../schema/RangeExtent.json" with { type: "json" };
import proposalProjectionSchema from "../schema/ProposalProjection.json" with { type: "json" };
import proposalDispositionSchema from "../schema/ProposalDisposition.json" with { type: "json" };
import loopFlagsSchema from "../schema/LoopFlags.json" with { type: "json" };
import clientDisplayCapabilitiesSchema from "../schema/ClientDisplayCapabilities.json" with { type: "json" };
import mcpServerDefinitionSchema from "../schema/McpServerDefinition.json" with { type: "json" };
import mcpServerOptionsSchema from "../schema/McpServerOptions.json" with { type: "json" };
import clientInteractionRequestSchema from "../schema/ClientInteractionRequest.json" with { type: "json" };
import clientInteractionProjectionSchema from "../schema/ClientInteractionProjection.json" with { type: "json" };
import clientInteractionResolutionSchema from "../schema/ClientInteractionResolution.json" with { type: "json" };
import type { ClientDisplayCapabilities, ClientInteractionProjection, ClientInteractionRequest, ClientInteractionResolution, EntryReadResult, LoopFlags, McpServerDefinition, McpServerOptions, Notice, OperationResult, ProblemDetails, ProposalProjection, RangeExtent, TextRegion } from "./types.generated.ts";

export type ValidationResult = { valid: boolean; errors: OutputUnit[] };

export class InvalidNoticeError extends TypeError {}
export class InvalidProblemDetailsError extends TypeError {}
export class InvalidOperationResultError extends TypeError {}
export class InvalidEntryReadResultError extends TypeError {}
export class InvalidTextRegionError extends TypeError {}
export class InvalidRangeExtentError extends TypeError {}
export class InvalidLoopFlagsError extends TypeError {}
export class InvalidProposalProjectionError extends TypeError {}
export class InvalidClientDisplayCapabilitiesError extends TypeError {}
export class InvalidMcpServerDefinitionError extends TypeError {}
export class InvalidMcpServerOptionsError extends TypeError {}
export class InvalidClientInteractionRequestError extends TypeError {}
export class InvalidClientInteractionProjectionError extends TypeError {}
export class InvalidClientInteractionResolutionError extends TypeError {}

export default class Validator {
    static #position = new CfValidator(positionSchema as Schema, "2020-12");
    static #lineMarker = new CfValidator(lineMarkerSchema as Schema, "2020-12");
    static #textLineMarker = new CfValidator(textLineMarkerSchema as Schema, "2020-12");
    static #parsedPath = new CfValidator(parsedPathSchema as Schema, "2020-12");
    static #matcherBody = new CfValidator(matcherBodySchema as Schema, "2020-12");
    static #sendBody = new CfValidator(sendBodySchema as Schema, "2020-12");
    static #plurnkStatement = Validator.#withRefs(
        plurnkStatementSchema,
        [
            positionSchema,
            lineMarkerSchema,
            textLineMarkerSchema,
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
            textLineMarkerSchema,
            parsedPathSchema,
            matcherBodySchema,
            sendBodySchema,
            resourceSelectionSchema,
        ],
    );
    static #notice = new CfValidator(noticeSchema as Schema, "2020-12");
    static #problemDetails = new CfValidator(problemDetailsSchema as Schema, "2020-12");
    static #operationResult = Validator.#withRefs(operationResultSchema, [problemDetailsSchema, rangeExtentSchema]);
    static #entryReadResult = Validator.#withRefs(entryReadResultSchema, [problemDetailsSchema]);
    static #textRegion = new CfValidator(textRegionSchema as Schema, "2020-12");
    static #rangeExtent = new CfValidator(rangeExtentSchema as Schema, "2020-12");
    static #loopFlags = new CfValidator(loopFlagsSchema as Schema, "2020-12");
    static #proposalProjection = Validator.#withRefs(
        proposalProjectionSchema,
        [proposalDispositionSchema, loopFlagsSchema],
    );
    static #clientDisplayCapabilities = new CfValidator(
        clientDisplayCapabilitiesSchema as Schema,
        "2020-12",
    );
    static #mcpServerDefinition = new CfValidator(
        mcpServerDefinitionSchema as unknown as Schema,
        "2020-12",
    );
    static #mcpServerOptions = Validator.#withRefs(
        mcpServerOptionsSchema,
        [mcpServerDefinitionSchema],
    );
    static #clientInteractionRequest = new CfValidator(
        clientInteractionRequestSchema as unknown as Schema,
        "2020-12",
    );
    static #clientInteractionProjection = Validator.#withRefs(
        clientInteractionProjectionSchema,
        [clientInteractionRequestSchema],
    );
    static #clientInteractionResolution = new CfValidator(
        clientInteractionResolutionSchema as unknown as Schema,
        "2020-12",
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

    static validateTextLineMarker(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#textLineMarker, value);
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

    static validateEntryReadResult(value: unknown): ValidationResult {
        const result = Validator.#validate(Validator.#entryReadResult, value);
        if (!result.valid) return result;
        const entry = (value as EntryReadResult).entry;
        if (entry === null) return result;
        for (const [name, channel] of Object.entries(entry.channels)) {
            const returnedLength = [...channel.content].length;
            if (channel.contentOffset + returnedLength !== channel.contentLength) {
                return {
                    valid: false,
                    errors: [{
                        keyword: "entry-read-suffix",
                        instanceLocation: `/entry/channels/${name}`,
                        keywordLocation: "#/$defs/channel",
                        error: "contentOffset plus the returned Unicode-code-point length must equal contentLength",
                    }],
                };
            }
        }
        return result;
    }

    static validateTextRegion(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#textRegion, value);
    }

    static validateRangeExtent(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#rangeExtent, value);
    }

    static validateLoopFlags(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#loopFlags, value);
    }

    static validateProposalProjection(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#proposalProjection, value);
    }

    static validateClientDisplayCapabilities(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#clientDisplayCapabilities, value);
    }

    static validateMcpServerDefinition(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#mcpServerDefinition, value);
    }

    static validateMcpServerOptions(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#mcpServerOptions, value);
    }

    static validateClientInteractionRequest(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#clientInteractionRequest, value);
    }

    static validateClientInteractionProjection(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#clientInteractionProjection, value);
    }

    static validateClientInteractionResolution(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#clientInteractionResolution, value);
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
        if (value.range !== undefined) {
            try {
                Validator.assertRangeExtent(value.range);
            } catch (cause) {
                throw new InvalidOperationResultError("operation result contains an invalid RangeExtent", { cause });
            }
        }
        return value;
    }

    static assertEntryReadResult<T extends EntryReadResult>(value: T): T {
        const result = Validator.validateEntryReadResult(value);
        if (!result.valid) {
            throw new InvalidEntryReadResultError(
                `invalid EntryReadResult: ${JSON.stringify(result.errors)}`,
            );
        }
        if ("problem" in value && value.problem.status !== value.status) {
            throw new InvalidEntryReadResultError(
                `EntryReadResult status ${value.status} does not match problem status ${value.problem.status}`,
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

    static assertRangeExtent<T extends RangeExtent>(value: T): T {
        const result = Validator.validateRangeExtent(value);
        if (!result.valid) {
            throw new InvalidRangeExtentError(`invalid RangeExtent: ${JSON.stringify(result.errors)}`);
        }
        if (value.returned !== undefined) {
            const [first, last] = value.returned;
            if (first > last || last > value.total) {
                throw new InvalidRangeExtentError("RangeExtent returned positions must be ordered within total");
            }
        }
        return value;
    }

    static assertLoopFlags<T extends LoopFlags>(value: T): T {
        const result = Validator.validateLoopFlags(value);
        if (!result.valid) {
            throw new InvalidLoopFlagsError(`invalid LoopFlags: ${JSON.stringify(result.errors)}`);
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

    static assertClientDisplayCapabilities<T extends ClientDisplayCapabilities>(value: T): T {
        const result = Validator.validateClientDisplayCapabilities(value);
        if (!result.valid) {
            throw new InvalidClientDisplayCapabilitiesError(
                `invalid ClientDisplayCapabilities: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertMcpServerDefinition<T extends McpServerDefinition>(value: T): T {
        const result = Validator.validateMcpServerDefinition(value);
        if (!result.valid) {
            throw new InvalidMcpServerDefinitionError(
                `invalid MCP server definition: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertMcpServerOptions<T extends McpServerOptions>(value: T): T {
        const result = Validator.validateMcpServerOptions(value);
        if (!result.valid) {
            throw new InvalidMcpServerOptionsError(
                `invalid MCP server options: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertClientInteractionRequest<T extends ClientInteractionRequest>(value: T): T {
        const result = Validator.validateClientInteractionRequest(value);
        if (!result.valid) {
            throw new InvalidClientInteractionRequestError(
                `invalid ClientInteractionRequest: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertClientInteractionProjection<T extends ClientInteractionProjection>(value: T): T {
        const result = Validator.validateClientInteractionProjection(value);
        if (!result.valid) {
            throw new InvalidClientInteractionProjectionError(
                `invalid ClientInteractionProjection: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertClientInteractionResolution<T extends ClientInteractionResolution>(value: T): T {
        const result = Validator.validateClientInteractionResolution(value);
        if (!result.valid) {
            throw new InvalidClientInteractionResolutionError(
                `invalid ClientInteractionResolution: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static #validate(validator: CfValidator, value: unknown): ValidationResult {
        const result = validator.validate(value);
        return { valid: result.valid, errors: result.errors };
    }
}
