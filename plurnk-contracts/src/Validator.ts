import { Validator as CfValidator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import positionSchema from "../schema/Position.json" with { type: "json" };
import lineMarkerSchema from "../schema/LineMarker.json" with { type: "json" };
import textLineMarkerSchema from "../schema/TextLineMarker.json" with { type: "json" };
import parsedPathSchema from "../schema/ParsedPath.json" with { type: "json" };
import matcherBodySchema from "../schema/MatcherBody.json" with { type: "json" };
import sendBodySchema from "../schema/SendBody.json" with { type: "json" };
import resourceSelectionSchema from "../schema/ResourceSelection.json" with { type: "json" };
import plurnkStatementSchema from "../schema/PlurnkStatement.json" with { type: "json" };
import applicationOperationEventSchema from "../schema/ApplicationOperationEvent.json" with { type: "json" };
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
import sessionOwnerSchema from "../schema/SessionOwner.json" with { type: "json" };
import type { SessionOwner, RollbackReport, AcpClientConformance, AcpConformanceKit, AcpDiscovery, CapabilityDescriptor, CapabilityPolicy, ClientDisplayCapabilities, ClientInteractionProjection, ClientInteractionRequest, ClientInteractionResolution, EntryReadResult, FunctionalityDiscoverResult, FunctionalityListResult, FunctionalityMutationResult, McpOAuth, McpServerDefinition, ModelCatalogPage, ModelCatalogQuery, ModelReadiness, ModelRoute, Notice, OperationResult, ProblemDetails, ProblemProjection, ProposalProjection, RangeExtent, Effort, SkillDefinition, TextRegion, JsonSchema, ParsedPath, PlurnkStatement } from "./types.generated.ts";
import clientDisplayCapabilitiesSchema from "../schema/ClientDisplayCapabilities.json" with { type: "json" };
import mcpServerDefinitionSchema from "../schema/McpServerDefinition.json" with { type: "json" };
import skillDefinitionSchema from "../schema/SkillDefinition.json" with { type: "json" };
import mcpOAuthSchema from "../schema/McpOAuth.json" with { type: "json" };
import clientInteractionRequestSchema from "../schema/ClientInteractionRequest.json" with { type: "json" };
import clientInteractionProjectionSchema from "../schema/ClientInteractionProjection.json" with { type: "json" };
import clientInteractionResolutionSchema from "../schema/ClientInteractionResolution.json" with { type: "json" };
import effortSchema from "../schema/Effort.json" with { type: "json" };
import modelCatalogPageSchema from "../schema/ModelCatalogPage.json" with { type: "json" };
import modelCatalogQuerySchema from "../schema/ModelCatalogQuery.json" with { type: "json" };
import functionalityCandidateSchema from "../schema/FunctionalityCandidate.json" with { type: "json" };
import functionalityProvenanceSchema from "../schema/FunctionalityProvenance.json" with { type: "json" };
import functionalityDiscoverQuerySchema from "../schema/FunctionalityDiscoverQuery.json" with { type: "json" };
import functionalityDiscoverResultSchema from "../schema/FunctionalityDiscoverResult.json" with { type: "json" };
import functionalityDefinitionStateSchema from "../schema/FunctionalityDefinitionState.json" with { type: "json" };
import functionalityListResultSchema from "../schema/FunctionalityListResult.json" with { type: "json" };
import functionalityMutationResultSchema from "../schema/FunctionalityMutationResult.json" with { type: "json" };
import rollbackReportSchema from "../schema/RollbackReport.json" with { type: "json" };
import mcpOAuthCompletionResultSchema from "../schema/McpOAuthCompletionResult.json" with { type: "json" };
import mcpOAuthBeginResultSchema from "../schema/McpOAuthBeginResult.json" with { type: "json" };
import functionalityPreparationActivitySchema from "../schema/FunctionalityPreparationActivity.json" with { type: "json" };
import modelReadinessSchema from "../schema/ModelReadiness.json" with { type: "json" };
import modelRouteSchema from "../schema/ModelRoute.json" with { type: "json" };
import acpDiscoverySchema from "../schema/AcpDiscovery.json" with { type: "json" };
import acpClientConformanceSchema from "../schema/AcpClientConformance.json" with { type: "json" };
import acpConformanceKitSchema from "../schema/AcpConformanceKit.json" with { type: "json" };
import providerAccountingSchema from "../schema/ProviderAccounting.json" with { type: "json" };
import providerRequestAccountingSchema from "../schema/ProviderRequestAccounting.json" with { type: "json" };
import providerUsageSchema from "../schema/ProviderUsage.json" with { type: "json" };
import providerCostSchema from "../schema/ProviderCost.json" with { type: "json" };

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
export class InvalidSessionOwnerError extends TypeError {}
export class InvalidProposalProjectionError extends TypeError {}
export class InvalidClientDisplayCapabilitiesError extends TypeError {}
export class InvalidMcpServerDefinitionError extends TypeError {}
export class InvalidSkillDefinitionError extends TypeError {}
export class InvalidMcpOAuthError extends TypeError {}
export class InvalidClientInteractionRequestError extends TypeError {}
export class InvalidClientInteractionProjectionError extends TypeError {}
export class InvalidClientInteractionResolutionError extends TypeError {}
export class InvalidEffortError extends TypeError {}
export class InvalidModelCatalogPageError extends TypeError {}
export class InvalidModelCatalogQueryError extends TypeError {}
export class InvalidFunctionalityListResultError extends TypeError {}
export class InvalidFunctionalityDiscoverResultError extends TypeError {}
export class InvalidFunctionalityMutationResultError extends TypeError {}
export class InvalidRollbackReportError extends TypeError {}
export class InvalidModelReadinessError extends TypeError {}
export class InvalidModelRouteError extends TypeError {}
export class InvalidAcpDiscoveryError extends TypeError {}
export class InvalidAcpClientConformanceError extends TypeError {}
export class InvalidAcpConformanceKitError extends TypeError {}
export class InvalidJsonSchemaInstanceError extends TypeError {}
export class InvalidParsedPathError extends TypeError {}
export class InvalidPlurnkStatementError extends TypeError {}

export default class Validator {
    static #position = Validator.#compile(positionSchema);
    static #lineMarker = Validator.#compile(lineMarkerSchema);
    static #textLineMarker = Validator.#compile(textLineMarkerSchema);
    static #parsedPath = Validator.#compile(parsedPathSchema);
    static #matcherBody = Validator.#compile(matcherBodySchema);
    static #sendBody = Validator.#compile(sendBodySchema);
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
    static #notice = Validator.#compile(noticeSchema);
    static #problemDetails = Validator.#compile(problemDetailsSchema);
    static #problemProjection = Validator.#compile(problemProjectionSchema);
    static #operationResult = Validator.#withRefs(operationResultSchema, [problemDetailsSchema, rangeExtentSchema]);
    static #entryReadResult = Validator.#withRefs(entryReadResultSchema, [problemDetailsSchema]);
    static #textRegion = Validator.#compile(textRegionSchema);
    static #rangeExtent = Validator.#compile(rangeExtentSchema);
    static #capabilityDescriptor = Validator.#withRefs(
        capabilityDescriptorSchema,
        [capabilitySelectorSchema],
    );
    static #capabilityPolicy = Validator.#withRefs(
        capabilityPolicySchema,
        [capabilitySelectorSchema],
    );
    static #sessionOwner = Validator.#compile(sessionOwnerSchema);
    static #proposalProjection = Validator.#withRefs(
        proposalProjectionSchema,
        [proposalDispositionSchema, capabilityPolicySchema, capabilitySelectorSchema],
    );
    static #clientDisplayCapabilities = Validator.#compile(clientDisplayCapabilitiesSchema);
    static #mcpServerDefinition = Validator.#withRefs(mcpServerDefinitionSchema, [mcpOAuthSchema]);
    static #skillDefinition = Validator.#compile(skillDefinitionSchema);
    static #mcpOAuth = Validator.#compile(mcpOAuthSchema);
    static #clientInteractionRequest = Validator.#compile(clientInteractionRequestSchema);
    static #clientInteractionProjection = Validator.#withRefs(
        clientInteractionProjectionSchema,
        [clientInteractionRequestSchema],
    );
    static #clientInteractionResolution = Validator.#compile(clientInteractionResolutionSchema);
    static #effort = Validator.#compile(effortSchema);
    static #providerRequestAccounting = Validator.#withRefs(
        providerRequestAccountingSchema,
        [providerUsageSchema, providerCostSchema],
    );
    static #modelReadiness = Validator.#compile(modelReadinessSchema);
    static #modelCatalogPage = Validator.#withRefs(
        modelCatalogPageSchema,
        [modelReadinessSchema, effortSchema],
    );
    static #functionalityListResult = Validator.#withRefs(
        functionalityListResultSchema,
        [functionalityDefinitionStateSchema, functionalityProvenanceSchema, problemDetailsSchema],
    );
    static #functionalityDiscoverResult = Validator.#withRefs(
        functionalityDiscoverResultSchema,
        [functionalityCandidateSchema, functionalityProvenanceSchema],
    );
    static #functionalityMutationResult = Validator.#withRefs(
        functionalityMutationResultSchema,
        [functionalityDefinitionStateSchema, functionalityProvenanceSchema, problemDetailsSchema],
    );
    static #rollbackReport = Validator.#compile(rollbackReportSchema);
    static #modelCatalogQuery = Validator.#compile(modelCatalogQuerySchema);
    static #modelRoute = Validator.#withRefs(
        modelRouteSchema,
        [effortSchema],
    );
    static #acpDiscovery = Validator.#withRefs(
        acpDiscoverySchema,
        [clientDisplayCapabilitiesSchema],
    );
    static #acpClientConformance = Validator.#compile(acpClientConformanceSchema);
    static #acpConformanceKit = Validator.#compile(acpConformanceKitSchema);
    static #jsonSchemaValidators = new WeakMap<JsonSchema, CfValidator>();
    static #publicSchemas = [
        applicationOperationEventSchema,
        plurnkStatementSchema,
        positionSchema,
        lineMarkerSchema,
        textLineMarkerSchema,
        parsedPathSchema,
        matcherBodySchema,
        sendBodySchema,
        resourceSelectionSchema,
        acpDiscoverySchema,
        acpClientConformanceSchema,
        acpConformanceKitSchema,
        clientDisplayCapabilitiesSchema,
        clientInteractionProjectionSchema,
        clientInteractionRequestSchema,
        clientInteractionResolutionSchema,
        entryReadResultSchema,
        functionalityCandidateSchema,
        functionalityProvenanceSchema,
        functionalityDefinitionStateSchema,
        functionalityDiscoverQuerySchema,
        functionalityDiscoverResultSchema,
        functionalityListResultSchema,
        functionalityMutationResultSchema,
        functionalityPreparationActivitySchema,
        rollbackReportSchema,
        mcpOAuthCompletionResultSchema,
        mcpOAuthBeginResultSchema,
        mcpOAuthSchema,
        mcpServerDefinitionSchema,
        skillDefinitionSchema,
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
        problemDetailsSchema,
        problemProjectionSchema,
        proposalDispositionSchema,
        proposalProjectionSchema,
        providerAccountingSchema,
        providerRequestAccountingSchema,
        providerUsageSchema,
        providerCostSchema,
        rangeExtentSchema,
        effortSchema,
    ];

    // The exact schema behind a `$ref` a Functionality family declares as its definition
    // schema — the source its generated document teaches the definition from.
    static schemaByRef(ref: string): object | null {
        const schema = Validator.#publicSchemas.find((candidate) => Validator.#schemaId(candidate) === ref);
        return schema === undefined ? null : schema;
    }

    // {§wire-entrypoint} A schema document is an object, naming its dialect in `$schema` or taking the validator's
    // default; every validator compiles one, the checked-in documents and the dynamic ones callers own alike. What
    // the document then means is the validator's to read, its declared dialect included.
    static #schemaDocument(value: unknown): value is Schema {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        return !("$schema" in value) || typeof value.$schema === "string";
    }

    static #schemaId(document: unknown): string | undefined {
        return typeof document === "object" && document !== null && "$id" in document && typeof document.$id === "string"
            ? document.$id
            : undefined;
    }

    static #compile(document: unknown): CfValidator {
        if (!Validator.#schemaDocument(document)) {
            throw new TypeError("a JSON Schema document is an object declaring draft 2020-12, or no draft");
        }
        return new CfValidator(document, "2020-12");
    }

    static #withRefs(mainSchema: unknown, refSchemas: unknown[]): CfValidator {
        const validator = Validator.#compile(mainSchema);
        const mainId = Validator.#schemaId(mainSchema);
        for (const ref of refSchemas) {
            if (Validator.#schemaId(ref) === mainId) continue;
            if (!Validator.#schemaDocument(ref)) {
                throw new TypeError("a referenced JSON Schema document is an object declaring draft 2020-12, or no draft");
            }
            validator.addSchema(ref);
        }
        return validator;
    }

    // {§wire-entrypoint} The schema's acceptance is the proof a value has its wire type: a guard over the result of
    // validating that value, the one place a validated `unknown` takes its type. The caller names the type the
    // schema it validated against generates; the predicate is where it appears.
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a type predicate's parameter appears once by nature
    static #accepted<T>(value: unknown, result: ValidationResult): value is T {
        return result.valid;
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
        if (!Validator.#accepted<EntryReadResult>(value, result)) return result;
        const entry = value.entry;
        if (entry === null) return result;
        for (const [name, channel] of Object.entries(entry.channels)) {
            const returnedLength = Array.from(channel.content).length;
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

    static validateSessionOwner(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#sessionOwner, value);
    }

    static assertSessionOwner(value: unknown): SessionOwner {
        const result = Validator.validateSessionOwner(value);
        if (!Validator.#accepted<SessionOwner>(value, result)) throw new InvalidSessionOwnerError(`invalid SessionOwner: ${JSON.stringify(result.errors)}`);
        return value;
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

    static validateSkillDefinition(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#skillDefinition, value);
    }

    static validateMcpOAuth(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#mcpOAuth, value);
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

    static validateEffort(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#effort, value);
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

    static validateRollbackReport(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#rollbackReport, value);
    }

    static assertRollbackReport(value: unknown): RollbackReport {
        const result = Validator.validateRollbackReport(value);
        if (!Validator.#accepted<RollbackReport>(value, result)) {
            throw new InvalidRollbackReportError(`invalid RollbackReport: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static validateModelReadiness(value: unknown): ValidationResult {
        const result = Validator.#validate(Validator.#modelReadiness, value);
        if (!Validator.#accepted<ModelReadiness>(value, result)) return result;
        const readiness = value;
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

    static validateAcpDiscovery(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#acpDiscovery, value);
    }

    static validateAcpClientConformance(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#acpClientConformance, value);
    }

    static validateAcpConformanceKit(value: unknown): ValidationResult {
        return Validator.#validate(Validator.#acpConformanceKit, value);
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

    static assertNotice(value: unknown): Notice {
        const result = Validator.validateNotice(value);
        if (!Validator.#accepted<Notice>(value, result)) throw new InvalidNoticeError(`invalid Notice: ${JSON.stringify(result.errors)}`);
        return value;
    }

    static assertProblemDetails(value: unknown): ProblemDetails {
        const result = Validator.validateProblemDetails(value);
        if (!Validator.#accepted<ProblemDetails>(value, result)) {
            throw new InvalidProblemDetailsError(`invalid RFC 9457 Problem Details: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertProblemProjection(value: unknown): ProblemProjection {
        const result = Validator.validateProblemProjection(value);
        if (!Validator.#accepted<ProblemProjection>(value, result)) {
            throw new InvalidProblemProjectionError(`invalid model Problem projection: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertOperationResult(value: unknown): OperationResult {
        const result = Validator.validateOperationResult(value);
        if (!Validator.#accepted<OperationResult>(value, result)) {
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

    static assertEntryReadResult(value: unknown): EntryReadResult {
        const result = Validator.validateEntryReadResult(value);
        if (!Validator.#accepted<EntryReadResult>(value, result)) {
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

    static assertTextRegion(value: unknown): TextRegion {
        const result = Validator.validateTextRegion(value);
        if (!Validator.#accepted<TextRegion>(value, result)) {
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

    static assertRangeExtent(value: unknown): RangeExtent {
        const result = Validator.validateRangeExtent(value);
        if (!Validator.#accepted<RangeExtent>(value, result)) {
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

    static assertCapabilityDescriptor(value: unknown): CapabilityDescriptor {
        const result = Validator.validateCapabilityDescriptor(value);
        if (!Validator.#accepted<CapabilityDescriptor>(value, result)) {
            throw new InvalidCapabilityDescriptorError(`invalid CapabilityDescriptor: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertCapabilityPolicy(value: unknown): CapabilityPolicy {
        const result = Validator.validateCapabilityPolicy(value);
        if (!Validator.#accepted<CapabilityPolicy>(value, result)) {
            throw new InvalidCapabilityPolicyError(`invalid CapabilityPolicy: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertProposalProjection(value: unknown): ProposalProjection {
        const result = Validator.validateProposalProjection(value);
        if (!Validator.#accepted<ProposalProjection>(value, result)) {
            throw new InvalidProposalProjectionError(
                `invalid ProposalProjection: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertClientDisplayCapabilities(value: unknown): ClientDisplayCapabilities {
        const result = Validator.validateClientDisplayCapabilities(value);
        if (!Validator.#accepted<ClientDisplayCapabilities>(value, result)) {
            throw new InvalidClientDisplayCapabilitiesError(
                `invalid ClientDisplayCapabilities: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertMcpServerDefinition(value: unknown): McpServerDefinition {
        const result = Validator.validateMcpServerDefinition(value);
        if (!Validator.#accepted<McpServerDefinition>(value, result)) {
            throw new InvalidMcpServerDefinitionError(
                `invalid MCP server definition: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertSkillDefinition(value: unknown): SkillDefinition {
        const result = Validator.validateSkillDefinition(value);
        if (!Validator.#accepted<SkillDefinition>(value, result)) {
            throw new InvalidSkillDefinitionError(
                `invalid Skill definition: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertMcpOAuth(value: unknown): McpOAuth {
        const result = Validator.validateMcpOAuth(value);
        if (!Validator.#accepted<McpOAuth>(value, result)) {
            throw new InvalidMcpOAuthError(
                `invalid MCP OAuth settings: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertClientInteractionRequest(value: unknown): ClientInteractionRequest {
        const result = Validator.validateClientInteractionRequest(value);
        if (!Validator.#accepted<ClientInteractionRequest>(value, result)) {
            throw new InvalidClientInteractionRequestError(
                `invalid ClientInteractionRequest: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertClientInteractionProjection(value: unknown): ClientInteractionProjection {
        const result = Validator.validateClientInteractionProjection(value);
        if (!Validator.#accepted<ClientInteractionProjection>(value, result)) {
            throw new InvalidClientInteractionProjectionError(
                `invalid ClientInteractionProjection: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertClientInteractionResolution(value: unknown): ClientInteractionResolution {
        const result = Validator.validateClientInteractionResolution(value);
        if (!Validator.#accepted<ClientInteractionResolution>(value, result)) {
            throw new InvalidClientInteractionResolutionError(
                `invalid ClientInteractionResolution: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertParsedPath(value: unknown): ParsedPath {
        const result = Validator.validateParsedPath(value);
        if (!Validator.#accepted<ParsedPath>(value, result)) {
            throw new InvalidParsedPathError(`invalid ParsedPath: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertPlurnkStatement(value: unknown): PlurnkStatement {
        const result = Validator.validatePlurnkStatement(value);
        if (!Validator.#accepted<PlurnkStatement>(value, result)) {
            throw new InvalidPlurnkStatementError(`invalid PlurnkStatement: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertEffort(value: unknown): Effort {
        const result = Validator.validateEffort(value);
        if (!Validator.#accepted<Effort>(value, result)) {
            throw new InvalidEffortError(
                `invalid Effort: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertModelCatalogPage(value: unknown): ModelCatalogPage {
        const result = Validator.validateModelCatalogPage(value);
        if (!Validator.#accepted<ModelCatalogPage>(value, result)) {
            throw new InvalidModelCatalogPageError(
                `invalid ModelCatalogPage: ${JSON.stringify(result.errors)}`,
            );
        }
        const page = value;
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
        if (!Validator.#accepted<FunctionalityListResult>(value, result)) {
            throw new InvalidFunctionalityListResultError(`invalid FunctionalityListResult: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertFunctionalityDiscoverResult(value: unknown): FunctionalityDiscoverResult {
        const result = Validator.validateFunctionalityDiscoverResult(value);
        if (!Validator.#accepted<FunctionalityDiscoverResult>(value, result)) {
            throw new InvalidFunctionalityDiscoverResultError(`invalid FunctionalityDiscoverResult: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertFunctionalityMutationResult(value: unknown): FunctionalityMutationResult {
        const result = Validator.validateFunctionalityMutationResult(value);
        if (!Validator.#accepted<FunctionalityMutationResult>(value, result)) {
            throw new InvalidFunctionalityMutationResultError(`invalid FunctionalityMutationResult: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertModelCatalogQuery(value: unknown): ModelCatalogQuery {
        const result = Validator.validateModelCatalogQuery(value);
        if (!Validator.#accepted<ModelCatalogQuery>(value, result)) {
            throw new InvalidModelCatalogQueryError(
                `invalid ModelCatalogQuery: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertModelReadiness(value: unknown): ModelReadiness {
        const result = Validator.validateModelReadiness(value);
        if (!Validator.#accepted<ModelReadiness>(value, result)) {
            throw new InvalidModelReadinessError(
                `invalid ModelReadiness: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertModelRoute(value: unknown): ModelRoute {
        const result = Validator.validateModelRoute(value);
        if (!Validator.#accepted<ModelRoute>(value, result)) {
            throw new InvalidModelRouteError(`invalid ModelRoute: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static assertAcpDiscovery(value: unknown): AcpDiscovery {
        const result = Validator.validateAcpDiscovery(value);
        if (!Validator.#accepted<AcpDiscovery>(value, result)) {
            throw new InvalidAcpDiscoveryError(
                `invalid ACP discovery manifest: ${JSON.stringify(result.errors)}`,
            );
        }
        return value;
    }

    static assertAcpClientConformance(
        discoveryValue: unknown,
        conformanceValue: unknown,
    ): AcpClientConformance {
        const discovery = Validator.assertAcpDiscovery(discoveryValue);
        const result = Validator.validateAcpClientConformance(conformanceValue);
        if (!Validator.#accepted<AcpClientConformance>(conformanceValue, result)) {
            throw new InvalidAcpClientConformanceError(
                `invalid ACP client conformance: ${JSON.stringify(result.errors)}`,
            );
        }
        const conformance = conformanceValue;
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
            throw new InvalidAcpClientConformanceError(
                `ACP client conformance does not account for the installed surface: ${mismatches.join(", ")}`,
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
                    if (!disposition.dimensions.some((declared) => declared === dimension)) {
                        missingDimensions.push(`${kind.slice(0, -1)} '${name}' lacks ${dimension}`);
                    }
                }
            }
        }
        if (missingDimensions.length > 0) {
            throw new InvalidAcpClientConformanceError(
                `ACP client conformance omits required dimensions: ${missingDimensions.join(", ")}`,
            );
        }
        return conformance;
    }

    static assertAcpConformanceKit(value: unknown): AcpConformanceKit {
        const result = Validator.validateAcpConformanceKit(value);
        if (!Validator.#accepted<AcpConformanceKit>(value, result)) {
            throw new InvalidAcpConformanceKitError(
                `invalid ACP conformance kit: ${JSON.stringify(result.errors)}`,
            );
        }
        const kit = value;
        for (const specimens of [kit.transport, kit.lifecycles]) {
            const names = specimens.map(({ name }) => name);
            if (new Set(names).size !== names.length) {
                throw new InvalidAcpConformanceKitError(
                    "ACP conformance specimen names must be unique within their family",
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
