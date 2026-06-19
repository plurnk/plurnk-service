import { Validator as CfValidator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import positionSchema from "../schema/Position.json" with { type: "json" };
import lineMarkerSchema from "../schema/LineMarker.json" with { type: "json" };
import paramsSchema from "../schema/Params.json" with { type: "json" };
import channelContentSchema from "../schema/ChannelContent.json" with { type: "json" };
import parsedPathSchema from "../schema/ParsedPath.json" with { type: "json" };
import matcherBodySchema from "../schema/MatcherBody.json" with { type: "json" };
import sendBodySchema from "../schema/SendBody.json" with { type: "json" };
import entrySchema from "../schema/Entry.json" with { type: "json" };
import schemeRegistrationSchema from "../schema/SchemeRegistration.json" with { type: "json" };
import providerDeclarationSchema from "../schema/ProviderDeclaration.json" with { type: "json" };
import plurnkStatementSchema from "../schema/PlurnkStatement.json" with { type: "json" };
import loopSchema from "../schema/Loop.json" with { type: "json" };
import telemetryEventSchema from "../schema/TelemetryEvent.json" with { type: "json" };

export type ValidationResult = { valid: boolean; errors: OutputUnit[] };

export default class Validator {
    static #position = new CfValidator(positionSchema as Schema, "2020-12");
    static #lineMarker = new CfValidator(lineMarkerSchema as Schema, "2020-12");
    static #params = new CfValidator(paramsSchema as Schema, "2020-12");
    static #channelContent = new CfValidator(channelContentSchema as Schema, "2020-12");
    static #parsedPath = Validator.#buildWithRefs(parsedPathSchema, [paramsSchema]);
    static #matcherBody = new CfValidator(matcherBodySchema as Schema, "2020-12");
    static #sendBody = new CfValidator(sendBodySchema as Schema, "2020-12");
    static #entry = Validator.#buildWithRefs(entrySchema, [paramsSchema, channelContentSchema]);
    static #schemeRegistration = new CfValidator(schemeRegistrationSchema as Schema, "2020-12");
    static #providerDeclaration = new CfValidator(providerDeclarationSchema as Schema, "2020-12");
    static #plurnkStatement = Validator.#buildWithRefs(
        plurnkStatementSchema,
        [positionSchema, lineMarkerSchema, paramsSchema, parsedPathSchema, matcherBodySchema, sendBodySchema],
    );
    static #loop = new CfValidator(loopSchema as Schema, "2020-12");
    static #telemetryEvent = new CfValidator(telemetryEventSchema as Schema, "2020-12");

    static #buildWithRefs(mainSchema: unknown, refSchemas: unknown[]): CfValidator {
        const validator = new CfValidator(mainSchema as Schema, "2020-12");
        const mainId = (mainSchema as { $id?: string }).$id;
        for (const ref of refSchemas) {
            const refId = (ref as { $id?: string }).$id;
            if (refId && refId === mainId) continue;
            validator.addSchema(ref as Schema);
        }
        return validator;
    }

    static validatePosition(obj: unknown): ValidationResult { return Validator.#run_(Validator.#position, obj); }
    static validateLineMarker(obj: unknown): ValidationResult { return Validator.#run_(Validator.#lineMarker, obj); }
    static validateParams(obj: unknown): ValidationResult { return Validator.#run_(Validator.#params, obj); }
    static validateChannelContent(obj: unknown): ValidationResult { return Validator.#run_(Validator.#channelContent, obj); }
    static validateParsedPath(obj: unknown): ValidationResult { return Validator.#run_(Validator.#parsedPath, obj); }
    static validateMatcherBody(obj: unknown): ValidationResult { return Validator.#run_(Validator.#matcherBody, obj); }
    static validateSendBody(obj: unknown): ValidationResult { return Validator.#run_(Validator.#sendBody, obj); }
    static validateEntry(obj: unknown): ValidationResult { return Validator.#run_(Validator.#entry, obj); }
    static validateSchemeRegistration(obj: unknown): ValidationResult { return Validator.#run_(Validator.#schemeRegistration, obj); }
    static validateProviderDeclaration(obj: unknown): ValidationResult { return Validator.#run_(Validator.#providerDeclaration, obj); }
    static validatePlurnkStatement(obj: unknown): ValidationResult { return Validator.#run_(Validator.#plurnkStatement, obj); }
    static validateLoop(obj: unknown): ValidationResult { return Validator.#run_(Validator.#loop, obj); }
    static validateTelemetryEvent(obj: unknown): ValidationResult { return Validator.#run_(Validator.#telemetryEvent, obj); }

    static #run_(validator: CfValidator, obj: unknown): ValidationResult {
        const result = validator.validate(obj);
        return { valid: result.valid, errors: result.errors };
    }
}
