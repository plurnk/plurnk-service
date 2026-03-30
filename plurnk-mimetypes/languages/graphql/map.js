import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import GraphQLVisitor from "./generated/GraphQLVisitor.js";

class Extractor extends withExtractor(GraphQLVisitor) {
	visitSchemaDefinition(ctx) {
		this._add("module", "schema", ctx);
		return this.visitChildren(ctx);
	}

	visitObjectTypeDefinition(ctx) {
		const name = ctx.name?.();
		if (name) this._add("class", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitInterfaceTypeDefinition(ctx) {
		const name = ctx.name?.();
		if (name) this._add("interface", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitEnumTypeDefinition(ctx) {
		const name = ctx.name?.();
		if (name) this._add("enum", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitInputObjectTypeDefinition(ctx) {
		const name = ctx.name?.();
		if (name) this._add("class", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitUnionTypeDefinition(ctx) {
		const name = ctx.name?.();
		if (name) this._add("type", name.getText(), ctx);
		return null;
	}

	visitScalarTypeDefinition(ctx) {
		const name = ctx.name?.();
		if (name) this._add("type", name.getText(), ctx);
		return null;
	}

	visitDirectiveDefinition(ctx) {
		const name = ctx.name?.();
		if (name) this._add("directive", name.getText(), ctx);
		return null;
	}

	visitFieldDefinition(ctx) {
		const name = ctx.name?.();
		if (name) this._add("field", name.getText(), ctx);
		return null;
	}

	visitSelectionSet() {
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "document",
	extensions: [".graphql", ".gql"],
});
