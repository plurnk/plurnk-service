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
import type { SessionOwner, RollbackReport, AcpDiscovery, CapabilityDescriptor, CapabilityPolicy, ClientDisplayCapabilities, ClientInteractionProjection, ClientInteractionRequest, ClientInteractionResolution, EntryReadResult, FunctionalityDiscoverResult, FunctionalityListResult, FunctionalityMutationResult, McpOAuth, McpServerDefinition, ModelCatalogPage, ModelCatalogQuery, ModelReadiness, ModelRoute, Notice, OperationResult, ProblemDetails, ProblemProjection, ProposalProjection, RangeExtent, Effort, SkillDefinition, TextRegion, JsonSchema, ParsedPath, PlurnkStatement } from "./types.generated.ts";
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
import providerAccountingSchema from "../schema/ProviderAccounting.json" with { type: "json" };
import providerRequestAccountingSchema from "../schema/ProviderRequestAccounting.json" with { type: "json" };
import providerUsageSchema from "../schema/ProviderUsage.json" with { type: "json" };
import providerCostSchema from "../schema/ProviderCost.json" with { type: "json" };

export type ValidationResult = { valid: boolean; errors: OutputUnit[] };

export class InvalidProblemDetailsError extends TypeError {}
export class InvalidOperationResultError extends TypeError {}

export default class Validator {
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
        sessionOwnerSchema,
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
        textRegionSchema,
        effortSchema,
    ];

    // The exact schema behind a `$ref` a Functionality family declares as its definition
    // schema — the source its generated document teaches the definition from.
    static schemaByRef(ref: string): object | null {
        const schema = Validator.#publicSchemas.find((candidate) => Validator.#schemaId(candidate) === ref);
        return schema === undefined ? null : schema;
    }

    // {§text-region} A schema document is an object, naming its dialect in `$schema` or taking the validator's
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

    // {§text-region} The schema's acceptance is the proof a value has its wire type: a guard over the result of
    // validating that value, the one place a validated `unknown` takes its type. The caller names the type the
    // schema it validated against generates; the predicate is where it appears.
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a type predicate's parameter appears once by nature
    static #accepted<T>(value: unknown, result: ValidationResult): value is T {
        return result.valid;
    }

    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- schema assertion returns the type the validated schema generates
    static #assert<T>(
        schema: JsonSchema,
        label: string,
        value: unknown,
        ErrorClass: new (message: string) => Error = TypeError,
    ): T {
        const result = Validator.validateJsonSchemaInstance(schema, value);
        if (!Validator.#accepted<T>(value, result)) {
            throw new ErrorClass(`invalid ${label}: ${JSON.stringify(result.errors)}`);
        }
        return value;
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
        const result = validator.validate(value);
        return { valid: result.valid, errors: result.errors };
    }

    static assertJsonSchemaInstance<T>(label: string, schema: JsonSchema, value: T): T {
        const result = Validator.validateJsonSchemaInstance(schema, value);
        if (!result.valid) {
            throw new TypeError(`${label} does not satisfy its JSON Schema: ${JSON.stringify(result.errors)}`);
        }
        return value;
    }

    static validateParsedPath(value: unknown): ValidationResult {
        return Validator.validateJsonSchemaInstance(parsedPathSchema, value);
    }

    static validatePlurnkStatement(value: unknown): ValidationResult {
        return Validator.validateJsonSchemaInstance(plurnkStatementSchema, value);
    }

    static validateEffort(value: unknown): ValidationResult {
        return Validator.validateJsonSchemaInstance(effortSchema, value);
    }

    static assertSessionOwner(value: unknown): SessionOwner {
        return Validator.#assert<SessionOwner>(sessionOwnerSchema, "SessionOwner", value);
    }

    static assertRollbackReport(value: unknown): RollbackReport {
        return Validator.#assert<RollbackReport>(rollbackReportSchema, "RollbackReport", value);
    }

    static assertNotice(value: unknown): Notice {
        return Validator.#assert<Notice>(noticeSchema, "Notice", value);
    }

    static assertProblemDetails(value: unknown): ProblemDetails {
        return Validator.#assert<ProblemDetails>(
            problemDetailsSchema,
            "RFC 9457 Problem Details",
            value,
            InvalidProblemDetailsError,
        );
    }

    static assertProblemProjection(value: unknown): ProblemProjection {
        return Validator.#assert<ProblemProjection>(problemProjectionSchema, "model Problem projection", value);
    }

    static assertOperationResult(value: unknown): OperationResult {
        const exact = Validator.#assert<OperationResult>(
            operationResultSchema,
            "operation result",
            value,
            InvalidOperationResultError,
        );
        if (exact.problem !== undefined && exact.problem.status !== exact.status) {
            throw new InvalidOperationResultError(
                `operation result status ${exact.status} does not match problem status ${exact.problem.status}`,
            );
        }
        if (exact.range !== undefined) {
            try {
                Validator.assertRangeExtent(exact.range);
            } catch (cause) {
                throw new InvalidOperationResultError("operation result contains an invalid RangeExtent", { cause });
            }
        }
        return exact;
    }

    static assertEntryReadResult(value: unknown): EntryReadResult {
        const exact = Validator.#assert<EntryReadResult>(entryReadResultSchema, "EntryReadResult", value);
        if ("problem" in exact && exact.problem.status !== exact.status) {
            throw new TypeError(`EntryReadResult status ${exact.status} does not match problem status ${exact.problem.status}`);
        }
        if (exact.entry !== null) {
            for (const [name, channel] of Object.entries(exact.entry.channels)) {
                const returnedLength = Array.from(channel.content).length;
                if (channel.contentOffset + returnedLength !== channel.contentLength) {
                    throw new TypeError(
                        `invalid EntryReadResult: /entry/channels/${name} contentOffset plus the returned Unicode-code-point length must equal contentLength`,
                    );
                }
            }
        }
        return exact;
    }

    static assertTextRegion(value: unknown): TextRegion {
        const exact = Validator.#assert<TextRegion>(textRegionSchema, "TextRegion", value);
        if (
            exact.endLine < exact.startLine
            || (exact.endLine === exact.startLine && exact.endColumn < exact.startColumn)
        ) {
            throw new TypeError("TextRegion ends before it starts");
        }
        return exact;
    }

    static assertRangeExtent(value: unknown): RangeExtent {
        const exact = Validator.#assert<RangeExtent>(rangeExtentSchema, "RangeExtent", value);
        if (exact.returned !== undefined) {
            const [first, last] = exact.returned;
            if (first > last || last > exact.total) {
                throw new TypeError("RangeExtent returned positions must be ordered within total");
            }
        }
        return exact;
    }

    static assertCapabilityDescriptor(value: unknown): CapabilityDescriptor {
        return Validator.#assert<CapabilityDescriptor>(capabilityDescriptorSchema, "CapabilityDescriptor", value);
    }

    static assertCapabilityPolicy(value: unknown): CapabilityPolicy {
        return Validator.#assert<CapabilityPolicy>(capabilityPolicySchema, "CapabilityPolicy", value);
    }

    static assertProposalProjection(value: unknown): ProposalProjection {
        return Validator.#assert<ProposalProjection>(proposalProjectionSchema, "ProposalProjection", value);
    }

    static assertClientDisplayCapabilities(value: unknown): ClientDisplayCapabilities {
        return Validator.#assert<ClientDisplayCapabilities>(clientDisplayCapabilitiesSchema, "ClientDisplayCapabilities", value);
    }

    static assertMcpServerDefinition(value: unknown): McpServerDefinition {
        return Validator.#assert<McpServerDefinition>(mcpServerDefinitionSchema, "MCP server definition", value);
    }

    static assertSkillDefinition(value: unknown): SkillDefinition {
        return Validator.#assert<SkillDefinition>(skillDefinitionSchema, "Skill definition", value);
    }

    static assertMcpOAuth(value: unknown): McpOAuth {
        return Validator.#assert<McpOAuth>(mcpOAuthSchema, "MCP OAuth settings", value);
    }

    static assertClientInteractionRequest(value: unknown): ClientInteractionRequest {
        return Validator.#assert<ClientInteractionRequest>(clientInteractionRequestSchema, "ClientInteractionRequest", value);
    }

    static assertClientInteractionProjection(value: unknown): ClientInteractionProjection {
        return Validator.#assert<ClientInteractionProjection>(clientInteractionProjectionSchema, "ClientInteractionProjection", value);
    }

    static assertClientInteractionResolution(value: unknown): ClientInteractionResolution {
        return Validator.#assert<ClientInteractionResolution>(clientInteractionResolutionSchema, "ClientInteractionResolution", value);
    }

    static assertParsedPath(value: unknown): ParsedPath {
        return Validator.#assert<ParsedPath>(parsedPathSchema, "ParsedPath", value);
    }

    static assertPlurnkStatement(value: unknown): PlurnkStatement {
        return Validator.#assert<PlurnkStatement>(plurnkStatementSchema, "PlurnkStatement", value);
    }

    static assertEffort(value: unknown): Effort {
        return Validator.#assert<Effort>(effortSchema, "Effort", value);
    }

    static assertModelCatalogPage(value: unknown): ModelCatalogPage {
        const page = Validator.#assert<ModelCatalogPage>(modelCatalogPageSchema, "ModelCatalogPage", value);
        const selectors = new Set<string>();
        for (const item of page.items) {
            Validator.assertModelReadiness(item.readiness);
            if (item.selector !== `${item.provider}/${item.model}`) {
                throw new TypeError("ModelCatalogPage item selector must equal provider/model");
            }
            if (selectors.has(item.selector)) {
                throw new TypeError("ModelCatalogPage item selectors must be unique");
            }
            selectors.add(item.selector);
        }
        const pageEnd = page.offset + page.items.length;
        if (page.items.length > 0 && pageEnd > page.total) {
            throw new TypeError("ModelCatalogPage items extend beyond total");
        }
        if (page.nextOffset !== undefined) {
            if (page.nextOffset !== pageEnd || page.nextOffset >= page.total) {
                throw new TypeError("ModelCatalogPage nextOffset must equal the page end and leave remaining items");
            }
        } else if (page.offset < page.total && pageEnd < page.total) {
            throw new TypeError("ModelCatalogPage omits nextOffset before total");
        }
        return page;
    }

    static assertFunctionalityListResult(value: unknown): FunctionalityListResult {
        return Validator.#assert<FunctionalityListResult>(functionalityListResultSchema, "FunctionalityListResult", value);
    }

    static assertFunctionalityDiscoverResult(value: unknown): FunctionalityDiscoverResult {
        return Validator.#assert<FunctionalityDiscoverResult>(functionalityDiscoverResultSchema, "FunctionalityDiscoverResult", value);
    }

    static assertFunctionalityMutationResult(value: unknown): FunctionalityMutationResult {
        return Validator.#assert<FunctionalityMutationResult>(functionalityMutationResultSchema, "FunctionalityMutationResult", value);
    }

    static assertModelCatalogQuery(value: unknown): ModelCatalogQuery {
        return Validator.#assert<ModelCatalogQuery>(modelCatalogQuerySchema, "ModelCatalogQuery", value);
    }

    static assertModelReadiness(value: unknown): ModelReadiness {
        const readiness = Validator.#assert<ModelReadiness>(modelReadinessSchema, "ModelReadiness", value);
        if (readiness.ready !== (readiness.causes.length === 0)) {
            throw new TypeError("invalid ModelReadiness: ready must be true exactly when causes is empty");
        }
        return readiness;
    }

    static assertModelRoute(value: unknown): ModelRoute {
        return Validator.#assert<ModelRoute>(modelRouteSchema, "ModelRoute", value);
    }

    static assertAcpDiscovery(value: unknown): AcpDiscovery {
        return Validator.#assert<AcpDiscovery>(acpDiscoverySchema, "ACP discovery manifest", value);
    }
}
