import { Validator as CfValidator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import positionSchema from "../schema/Position.json" with { type: "json" };
import lineMarkerSchema from "../schema/LineMarker.json" with { type: "json" };
import textLineMarkerSchema from "../schema/TextLineMarker.json" with { type: "json" };
import parsedPathSchema from "../schema/ParsedPath.json" with { type: "json" };
import matcherBodySchema from "../schema/MatcherBody.json" with { type: "json" };
import sendBodySchema from "../schema/SendBody.json" with { type: "json" };
import resourceSelectionSchema from "../schema/ResourceSelection.json" with { type: "json" };
import acpPlanSchema from "../schema/AcpPlan.json" with { type: "json" };
import planSchema from "../schema/Plan.json" with { type: "json" };
import plurnkStatementSchema from "../schema/PlurnkStatement.json" with { type: "json" };
import clientStatementSchema from "../schema/ClientStatement.json" with { type: "json" };
import noticeSchema from "../schema/Notice.json" with { type: "json" };
import problemDetailsSchema from "../schema/ProblemDetails.json" with { type: "json" };
import problemProjectionSchema from "../schema/ProblemProjection.json" with { type: "json" };
import operationResultSchema from "../schema/OperationResult.json" with { type: "json" };
import entryReadResultSchema from "../schema/EntryReadResult.json" with { type: "json" };
import textRegionSchema from "../schema/TextRegion.json" with { type: "json" };
import rangeExtentSchema from "../schema/RangeExtent.json" with { type: "json" };
import proposalProjectionSchema from "../schema/ProposalProjection.json" with { type: "json" };
import proposalDispositionSchema from "../schema/ProposalDisposition.json" with { type: "json" };
import capabilityDescriptorSchema from "../schema/CapabilityDescriptor.json" with { type: "json" };
import capabilityPolicySchema from "../schema/CapabilityPolicy.json" with { type: "json" };
import capabilityProjectionSchema from "../schema/CapabilityProjection.json" with { type: "json" };
import capabilitySelectorSchema from "../schema/CapabilitySelector.json" with { type: "json" };
import loopPolicySchema from "../schema/LoopPolicy.json" with { type: "json" };
import clientDisplayCapabilitiesSchema from "../schema/ClientDisplayCapabilities.json" with { type: "json" };
import mcpServerDefinitionSchema from "../schema/McpServerDefinition.json" with { type: "json" };
import skillDefinitionSchema from "../schema/SkillDefinition.json" with { type: "json" };
import a2aAgentDefinitionSchema from "../schema/A2aAgentDefinition.json" with { type: "json" };
import mcpServerOptionsSchema from "../schema/McpServerOptions.json" with { type: "json" };
import mcpConfigurationOverlaySchema from "../schema/McpConfigurationOverlay.json" with { type: "json" };
import clientInteractionRequestSchema from "../schema/ClientInteractionRequest.json" with { type: "json" };
import clientInteractionProjectionSchema from "../schema/ClientInteractionProjection.json" with { type: "json" };
import clientInteractionResolutionSchema from "../schema/ClientInteractionResolution.json" with { type: "json" };
import reasoningPolicySchema from "../schema/ReasoningPolicy.json" with { type: "json" };
import modelCatalogPageSchema from "../schema/ModelCatalogPage.json" with { type: "json" };
import modelCatalogQuerySchema from "../schema/ModelCatalogQuery.json" with { type: "json" };
import functionalityCandidateSchema from "../schema/FunctionalityCandidate.json" with { type: "json" };
import functionalityDiscoverQuerySchema from "../schema/FunctionalityDiscoverQuery.json" with { type: "json" };
import functionalityDiscoverResultSchema from "../schema/FunctionalityDiscoverResult.json" with { type: "json" };
import functionalityDefinitionStateSchema from "../schema/FunctionalityDefinitionState.json" with { type: "json" };
import functionalityListResultSchema from "../schema/FunctionalityListResult.json" with { type: "json" };
import functionalityMutationResultSchema from "../schema/FunctionalityMutationResult.json" with { type: "json" };
import modelReadinessSchema from "../schema/ModelReadiness.json" with { type: "json" };
import modelRouteSchema from "../schema/ModelRoute.json" with { type: "json" };
import aguiDiscoverySchema from "../schema/AguiDiscovery.json" with { type: "json" };
import aguiClientConformanceSchema from "../schema/AguiClientConformance.json" with { type: "json" };
import aguiConformanceKitSchema from "../schema/AguiConformanceKit.json" with { type: "json" };
import providerAccountingSchema from "../schema/ProviderAccounting.json" with { type: "json" };
import providerRequestAccountingSchema from "../schema/ProviderRequestAccounting.json" with { type: "json" };
import providerUsageSchema from "../schema/ProviderUsage.json" with { type: "json" };
import providerCostSchema from "../schema/ProviderCost.json" with { type: "json" };
import type { A2AAgentDefinition as A2aAgentDefinition, AguiClientConformance, AguiConformanceKit, AguiDiscovery, CapabilityDescriptor, CapabilityPolicy, ClientDisplayCapabilities, ClientInteractionProjection, ClientInteractionRequest, ClientInteractionResolution, EntryReadResult, FunctionalityDiscoverResult, FunctionalityListResult, FunctionalityMutationResult, LoopPolicy, McpConfigurationOverlay, McpServerDefinition, McpServerOptions, ModelCatalogPage, ModelCatalogQuery, ModelReadiness, ModelRoute, Notice, OperationResult, ProblemDetails, ProblemProjection, ProposalProjection, RangeExtent, ReasoningPolicy, SkillDefinition, TextRegion } from "./types.generated.ts";
import type { JsonSchema } from "./types.generated.ts";

export type ValidationResult = { valid: boolean; errors: OutputUnit[] };

export class InvalidNoticeError extends TypeError {}
export class InvalidProblemDetailsError extends TypeError {}
export class InvalidProblemProjectionError extends TypeError {}
export class InvalidOperationResultError extends TypeError {}
export class InvalidEntryReadResultError extends TypeError {}
export class InvalidTextRegionError extends TypeError {}
export class InvalidRangeExtentError extends TypeError {}
export class InvalidCapabilityDescriptorError extends TypeError {}
export class InvalidCapabilityPolicyError extends TypeError {}
export class InvalidLoopPolicyError extends TypeError {}
export class InvalidProposalProjectionError extends TypeError {}
export class InvalidClientDisplayCapabilitiesError extends TypeError {}
export class InvalidMcpServerDefinitionError extends TypeError {}
export class InvalidSkillDefinitionError extends TypeError {}
export class InvalidA2aAgentDefinitionError extends TypeError {}
export class InvalidMcpServerOptionsError extends TypeError {}
export class InvalidMcpConfigurationOverlayError extends TypeError {}
export class InvalidClientInteractionRequestError extends TypeError {}
export class InvalidClientInteractionProjectionError extends TypeError {}
export class InvalidClientInteractionResolutionError extends TypeError {}
export class InvalidReasoningPolicyError extends TypeError {}
export class InvalidModelCatalogPageError extends TypeError {}
export class InvalidModelCatalogQueryError extends TypeError {}
export class InvalidFunctionalityListResultError extends TypeError {}
export class InvalidFunctionalityDiscoverResultError extends TypeError {}
export class InvalidFunctionalityMutationResultError extends TypeError {}
export class InvalidModelReadinessError extends TypeError {}
export class InvalidModelRouteError extends TypeError {}
export class InvalidAguiDiscoveryError extends TypeError {}
export class InvalidAguiClientConformanceError extends TypeError {}
export class InvalidAguiConformanceKitError extends TypeError {}
export class InvalidJsonSchemaInstanceError extends TypeError {}

export default class Validator {
    static #position = new CfValidator(positionSchema as Schema, "2020-12");
    static #lineMarker = new CfValidator(lineMarkerSchema as Schema, "2020-12");
    static #textLineMarker = new CfValidator(textLineMarkerSchema as Schema, "2020-12");
    static #parsedPath = new CfValidator(parsedPathSchema as Schema, "2020-12");
    static #matcherBody = new CfValidator(matcherBodySchema as Schema, "2020-12");
    static #sendBody = new CfValidator(sendBodySchema as Schema, "2020-12");
    static #acpPlan = new CfValidator(acpPlanSchema as Schema, "2020-12");
    static #plan = new CfValidator(planSchema as Schema, "2020-12");
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
            planSchema,
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
            planSchema,
        ],
    );
    static #notice = new CfValidator(noticeSchema as Schema, "2020-12");
    static #problemDetails = new CfValidator(problemDetailsSchema as Schema, "2020-12");
    static #problemProjection = new CfValidator(problemProjectionSchema as Schema, "2020-12");
    static #operationResult = Validator.#withRefs(operationResultSchema, [problemDetailsSchema, rangeExtentSchema]);
    static #entryReadResult = Validator.#withRefs(entryReadResultSchema, [problemDetailsSchema]);
    static #textRegion = new CfValidator(textRegionSchema as Schema, "2020-12");
    static #rangeExtent = new CfValidator(rangeExtentSchema as Schema, "2020-12");
    static #capabilityDescriptor = Validator.#withRefs(
        capabilityDescriptorSchema,
        [capabilitySelectorSchema],
    );
    static #capabilityPolicy = Validator.#withRefs(
        capabilityPolicySchema,
        [capabilitySelectorSchema],
    );
    static #loopPolicy = Validator.#withRefs(
        loopPolicySchema,
        [capabilityPolicySchema, capabilitySelectorSchema],
    );
    static #proposalProjection = Validator.#withRefs(
        proposalProjectionSchema,
        [proposalDispositionSchema, loopPolicySchema, capabilityPolicySchema, capabilitySelectorSchema],
    );
    static #clientDisplayCapabilities = new CfValidator(
        clientDisplayCapabilitiesSchema as Schema,
        "2020-12",
    );
    static #mcpServerDefinition = new CfValidator(
        mcpServerDefinitionSchema as unknown as Schema,
        "2020-12",
    );
    static #a2aAgentDefinition = new CfValidator(
        a2aAgentDefinitionSchema as unknown as Schema,
        "2020-12",
    );
    static #skillDefinition = new CfValidator(
        skillDefinitionSchema as unknown as Schema,
        "2020-12",
    );
    static #mcpServerOptions = Validator.#withRefs(
        mcpServerOptionsSchema,
        [mcpServerDefinitionSchema],
    );
    static #mcpConfigurationOverlay = new CfValidator(
        mcpConfigurationOverlaySchema as unknown as Schema,
        "2020-12",
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
    static #reasoningPolicy = new CfValidator(
        reasoningPolicySchema as unknown as Schema,
        "2020-12",
    );
    static #providerRequestAccounting = Validator.#withRefs(
        providerRequestAccountingSchema,
        [providerUsageSchema, providerCostSchema],
    );
    static #modelReadiness = new CfValidator(
        modelReadinessSchema as unknown as Schema,
        "2020-12",
    );
    static #modelCatalogPage = Validator.#withRefs(
        modelCatalogPageSchema,
        [modelReadinessSchema],
    );
    static #functionalityListResult = Validator.#withRefs(
        functionalityListResultSchema,
        [functionalityDefinitionStateSchema, problemDetailsSchema],
    );
    static #functionalityDiscoverResult = Validator.#withRefs(
        functionalityDiscoverResultSchema,
        [functionalityCandidateSchema],
    );
    static #functionalityMutationResult = Validator.#withRefs(
        functionalityMutationResultSchema,
        [functionalityDefinitionStateSchema, problemDetailsSchema],
    );
    static #modelCatalogQuery = new CfValidator(
        modelCatalogQuerySchema as unknown as Schema,
        "2020-12",
    );
    static #modelRoute = new CfValidator(
        modelRouteSchema as unknown as Schema,
        "2020-12",
    );
    static #aguiDiscovery = Validator.#withRefs(
        aguiDiscoverySchema,
        [clientDisplayCapabilitiesSchema],
    );
    static #aguiClientConformance = new CfValidator(
        aguiClientConformanceSchema as unknown as Schema,
        "2020-12",
    );
    static #aguiConformanceKit = new CfValidator(
        aguiConformanceKitSchema as unknown as Schema,
        "2020-12",
    );
    static #jsonSchemaValidators = new WeakMap<JsonSchema, CfValidator>();
    static #publicSchemas = [
        acpPlanSchema,
        aguiDiscoverySchema,
        aguiClientConformanceSchema,
        aguiConformanceKitSchema,
        clientDisplayCapabilitiesSchema,
        clientInteractionProjectionSchema,
        clientInteractionRequestSchema,
        clientInteractionResolutionSchema,
        entryReadResultSchema,
        functionalityCandidateSchema,
        functionalityDefinitionStateSchema,
        functionalityDiscoverQuerySchema,
        functionalityDiscoverResultSchema,
        functionalityListResultSchema,
        functionalityMutationResultSchema,
        mcpConfigurationOverlaySchema,
        mcpServerDefinitionSchema,
        mcpServerOptionsSchema,
        skillDefinitionSchema,
        a2aAgentDefinitionSchema,
        capabilityDescriptorSchema,
        capabilityPolicySchema,
        capabilityProjectionSchema,
        capabilitySelectorSchema,
        modelCatalogPageSchema,
        modelCatalogQuerySchema,
        modelReadinessSchema,
        modelRouteSchema,
        noticeSchema,
        operationResultSchema,
        planSchema,
        problemDetailsSchema,
        problemProjectionSchema,
        loopPolicySchema,
        proposalDispositionSchema,
        proposalProjectionSchema,
        providerAccountingSchema,
        providerRequestAccountingSchema,
        providerUsageSchema,
        providerCostSchema,
        rangeExtentSchema,
        reasoningPolicySchema,
    ];

    // The exact schema behind a `$ref` a Functionality family declares as its definition
    // schema — the source its generated document teaches the definition from.
    static schemaByRef(ref: string): object | null {
        const schema = Validator.#publicSchemas.find((candidate) => (candidate as { $id?: string }).$id === ref);
        return schema === undefined ? null : (schema as object);
    }

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

    static validateAcpPlan(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#acpPlan, value);
    }

    static validatePlan(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#plan, value);
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

    static validateProblemProjection(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#problemProjection, value);
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

    static validateCapabilityDescriptor(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#capabilityDescriptor, value);
    }

    static validateCapabilityPolicy(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#capabilityPolicy, value);
    }

    static validateLoopPolicy(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#loopPolicy, value);
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

    static validateA2aAgentDefinition(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#a2aAgentDefinition, value);
    }

    static validateSkillDefinition(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#skillDefinition, value);
    }

    static validateMcpServerOptions(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#mcpServerOptions, value);
    }

    static validateMcpConfigurationOverlay(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#mcpConfigurationOverlay, value);
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

    static validateReasoningPolicy(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#reasoningPolicy, value);
    }

    static validateProviderRequestAccounting(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#providerRequestAccounting, value);
    }

    static validateModelCatalogPage(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#modelCatalogPage, value);
    }

    static validateModelCatalogQuery(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#modelCatalogQuery, value);
    }

    static validateFunctionalityListResult(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#functionalityListResult, value);
    }

    static validateFunctionalityDiscoverResult(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#functionalityDiscoverResult, value);
    }

    static validateFunctionalityMutationResult(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#functionalityMutationResult, value);
    }

    static validateModelReadiness(value: unknown): ValidationResult {
        const result = Validator.#validate(Validator.#modelReadiness, value);
        if (!result.valid) return result;
        const readiness = value as ModelReadiness;
        if (readiness.ready !== (readiness.causes.length === 0)) {
            return {
                valid: false,
                errors: [{
                    keyword: "model-readiness",
                    instanceLocation: "",
                    keywordLocation: "#",
                    error: "ready must be true exactly when causes is empty",
                }],
            };
        }
        return result;
    }

    static validateModelRoute(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#modelRoute, value);
    }

    static validateAguiDiscovery(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#aguiDiscovery, value);
    }

    static validateAguiClientConformance(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#aguiClientConformance, value);
    }

    static validateAguiConformanceKit(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#aguiConformanceKit, value);
    }

    static validateJsonSchemaInstance(schema: JsonSchema, value: unknown): ValidationResult {
        let validator = Validator.#jsonSchemaValidators.get(schema);
        if (validator === undefined) {
            // @cfworker annotates a schema while dereferencing it. Dynamic wire
            // schemas are caller-owned discovery values and may be frozen; never
            // mutate the authority merely by compiling its executable projection.
            validator = Validator.#withRefs(structuredClone(schema), Validator.#publicSchemas);
            Validator.#jsonSchemaValidators.set(schema, validator);
        }
        return Validator.#validate(validator, value);
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

    static assertProblemProjection<T extends ProblemProjection>(value: T): T {
        const result = Validator.validateProblemProjection(value);
        if (!result.valid) {
            throw new InvalidProblemProjectionError(`invalid model Problem projection: ${JSON.stringify(result.errors)}`);
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

    static assertCapabilityDescriptor<T extends CapabilityDescriptor>(value: T): T {
        const result = Validator.validateCapabilityDescriptor(value);
        if (!result.valid) {
            throw new InvalidCapabilityDescriptorError(`invalid CapabilityDescriptor: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertCapabilityPolicy<T extends CapabilityPolicy>(value: T): T {
        const result = Validator.validateCapabilityPolicy(value);
        if (!result.valid) {
            throw new InvalidCapabilityPolicyError(`invalid CapabilityPolicy: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertLoopPolicy<T extends LoopPolicy>(value: T): T {
        const result = Validator.validateLoopPolicy(value);
        if (!result.valid) {
            throw new InvalidLoopPolicyError(`invalid LoopPolicy: ${JSON.stringify(result.errors)}`);
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

    static assertA2aAgentDefinition<T extends A2aAgentDefinition>(value: T): T {
        const result = Validator.validateA2aAgentDefinition(value);
        if (!result.valid) {
            throw new InvalidA2aAgentDefinitionError(
                `invalid A2A agent definition: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertSkillDefinition<T extends SkillDefinition>(value: T): T {
        const result = Validator.validateSkillDefinition(value);
        if (!result.valid) {
            throw new InvalidSkillDefinitionError(
                `invalid Skill definition: ${JSON.stringify(result.errors)}`,
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

    static assertMcpConfigurationOverlay<T extends McpConfigurationOverlay>(value: T): T {
        const result = Validator.validateMcpConfigurationOverlay(value);
        if (!result.valid) {
            throw new InvalidMcpConfigurationOverlayError(
                `invalid MCP configuration overlay: ${JSON.stringify(result.errors)}`,
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

    static assertReasoningPolicy(value: unknown): ReasoningPolicy {
        const result = Validator.validateReasoningPolicy(value);
        if (!result.valid) {
            throw new InvalidReasoningPolicyError(
                `invalid ReasoningPolicy: ${JSON.stringify(result.errors)}`,
            );
        }
        return value as ReasoningPolicy;
    }

    static assertModelCatalogPage(value: unknown): ModelCatalogPage {
        const result = Validator.validateModelCatalogPage(value);
        if (!result.valid) {
            throw new InvalidModelCatalogPageError(
                `invalid ModelCatalogPage: ${JSON.stringify(result.errors)}`,
            );
        }
        const page = value as ModelCatalogPage;
        const selectors = new Set<string>();
        for (const item of page.items) {
            Validator.assertModelReadiness(item.readiness);
            if (item.selector !== `${item.provider}/${item.model}`) {
                throw new InvalidModelCatalogPageError(
                    "ModelCatalogPage item selector must equal provider/model",
                );
            }
            if (selectors.has(item.selector)) {
                throw new InvalidModelCatalogPageError("ModelCatalogPage item selectors must be unique");
            }
            selectors.add(item.selector);
        }
        const pageEnd = page.offset + page.items.length;
        if (page.items.length > 0 && pageEnd > page.total) {
            throw new InvalidModelCatalogPageError("ModelCatalogPage items extend beyond total");
        }
        if (page.nextOffset !== undefined) {
            if (page.nextOffset !== pageEnd || page.nextOffset >= page.total) {
                throw new InvalidModelCatalogPageError(
                    "ModelCatalogPage nextOffset must equal the page end and leave remaining items",
                );
            }
        } else if (page.offset < page.total && pageEnd < page.total) {
            throw new InvalidModelCatalogPageError("ModelCatalogPage omits nextOffset before total");
        }
        return page;
    }

    static assertFunctionalityListResult(value: unknown): FunctionalityListResult {
        const result = Validator.validateFunctionalityListResult(value);
        if (!result.valid) {
            throw new InvalidFunctionalityListResultError(`invalid FunctionalityListResult: ${JSON.stringify(result.errors)}`);
        }
        return value as FunctionalityListResult;
    }

    static assertFunctionalityDiscoverResult(value: unknown): FunctionalityDiscoverResult {
        const result = Validator.validateFunctionalityDiscoverResult(value);
        if (!result.valid) {
            throw new InvalidFunctionalityDiscoverResultError(`invalid FunctionalityDiscoverResult: ${JSON.stringify(result.errors)}`);
        }
        return value as FunctionalityDiscoverResult;
    }

    static assertFunctionalityMutationResult(value: unknown): FunctionalityMutationResult {
        const result = Validator.validateFunctionalityMutationResult(value);
        if (!result.valid) {
            throw new InvalidFunctionalityMutationResultError(`invalid FunctionalityMutationResult: ${JSON.stringify(result.errors)}`);
        }
        return value as FunctionalityMutationResult;
    }

    static assertModelCatalogQuery(value: unknown): ModelCatalogQuery {
        const result = Validator.validateModelCatalogQuery(value);
        if (!result.valid) {
            throw new InvalidModelCatalogQueryError(
                `invalid ModelCatalogQuery: ${JSON.stringify(result.errors)}`,
            );
        }
        return value as ModelCatalogQuery;
    }

    static assertModelReadiness(value: unknown): ModelReadiness {
        const result = Validator.validateModelReadiness(value);
        if (!result.valid) {
            throw new InvalidModelReadinessError(
                `invalid ModelReadiness: ${JSON.stringify(result.errors)}`,
            );
        }
        return value as ModelReadiness;
    }

    static assertModelRoute(value: unknown): ModelRoute {
        const result = Validator.validateModelRoute(value);
        if (!result.valid) {
            throw new InvalidModelRouteError(`invalid ModelRoute: ${JSON.stringify(result.errors)}`);
        }
        return value as ModelRoute;
    }

    static assertAguiDiscovery(value: unknown): AguiDiscovery {
        const result = Validator.validateAguiDiscovery(value);
        if (!result.valid) {
            throw new InvalidAguiDiscoveryError(
                `invalid AG-UI discovery manifest: ${JSON.stringify(result.errors)}`,
            );
        }
        return value as AguiDiscovery;
    }

    static assertAguiClientConformance(
        discoveryValue: unknown,
        conformanceValue: unknown,
    ): AguiClientConformance {
        const discovery = Validator.assertAguiDiscovery(discoveryValue);
        const result = Validator.validateAguiClientConformance(conformanceValue);
        if (!result.valid) {
            throw new InvalidAguiClientConformanceError(
                `invalid AG-UI client conformance: ${JSON.stringify(result.errors)}`,
            );
        }
        const conformance = conformanceValue as AguiClientConformance;
        const mismatch = (kind: "actions" | "notifications"): string[] => {
            const installed = Object.keys(discovery[kind]).toSorted();
            const accounted = Object.keys(conformance[kind]).toSorted();
            return installed.length === accounted.length
                && installed.every((name, index) => name === accounted[index])
                ? []
                : [
                    ...installed.filter((name) => !Object.hasOwn(conformance[kind], name)).map((name) => `missing ${kind.slice(0, -1)} '${name}'`),
                    ...accounted.filter((name) => !Object.hasOwn(discovery[kind], name)).map((name) => `unknown ${kind.slice(0, -1)} '${name}'`),
                ];
        };
        const mismatches = [...mismatch("actions"), ...mismatch("notifications")];
        if (mismatches.length > 0) {
            throw new InvalidAguiClientConformanceError(
                `AG-UI client conformance does not account for the installed surface: ${mismatches.join(", ")}`,
            );
        }
        const missingDimensions: string[] = [];
        for (const kind of ["actions", "notifications"] as const) {
            const baseline = kind === "actions"
                ? ["projection", "success", "failure"]
                : ["framing", "projection"];
            for (const [name, disposition] of Object.entries(conformance[kind])) {
                const required = disposition.posture === "native"
                    ? [...baseline, "admission", "presentation"]
                    : disposition.posture === "generic"
                        ? baseline
                        : ["failure"];
                for (const dimension of required) {
                    if (!disposition.dimensions.includes(dimension as never)) {
                        missingDimensions.push(`${kind.slice(0, -1)} '${name}' lacks ${dimension}`);
                    }
                }
            }
        }
        if (missingDimensions.length > 0) {
            throw new InvalidAguiClientConformanceError(
                `AG-UI client conformance omits required dimensions: ${missingDimensions.join(", ")}`,
            );
        }
        return conformance;
    }

    static assertAguiConformanceKit(value: unknown): AguiConformanceKit {
        const result = Validator.validateAguiConformanceKit(value);
        if (!result.valid) {
            throw new InvalidAguiConformanceKitError(
                `invalid AG-UI conformance kit: ${JSON.stringify(result.errors)}`,
            );
        }
        const kit = value as AguiConformanceKit;
        for (const specimens of [kit.transport, kit.lifecycles]) {
            const names = specimens.map(({ name }) => name);
            if (new Set(names).size !== names.length) {
                throw new InvalidAguiConformanceKitError(
                    "AG-UI conformance specimen names must be unique within their family",
                );
            }
        }
        return kit;
    }

    static assertJsonSchemaInstance<T>(label: string, schema: JsonSchema, value: T): T {
        const result = Validator.validateJsonSchemaInstance(schema, value);
        if (!result.valid) {
            throw new InvalidJsonSchemaInstanceError(
                `${label} does not satisfy its JSON Schema: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static #validate(validator: CfValidator, value: unknown): ValidationResult {
        const result = validator.validate(value);
        return { valid: result.valid, errors: result.errors };
    }
}
