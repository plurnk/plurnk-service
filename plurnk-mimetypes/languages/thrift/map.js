import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import ThriftVisitor from "./generated/ThriftVisitor.js";

class Extractor extends withExtractor(ThriftVisitor) {
	visitNamespace_(ctx) {
		const ids = ctx.IDENTIFIER();
		if (ids.length >= 2) this._add("module", ids[1].getText(), ctx);
		else if (ids.length === 1) this._add("module", ids[0].getText(), ctx);
		return null;
	}

	visitService(ctx) {
		const name = ctx.IDENTIFIER(0);
		if (name) this._add("class", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitStruct_(ctx) {
		const name = ctx.IDENTIFIER();
		if (name) this._add("class", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitUnion_(ctx) {
		const name = ctx.IDENTIFIER();
		if (name) this._add("class", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitException(ctx) {
		const name = ctx.IDENTIFIER();
		if (name) this._add("class", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitEnum_rule(ctx) {
		const name = ctx.IDENTIFIER();
		if (name) this._add("enum", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitTypedef_(ctx) {
		const name = ctx.IDENTIFIER();
		if (name) this._add("type", name.getText(), ctx);
		return null;
	}

	visitConst_rule(ctx) {
		const name = ctx.IDENTIFIER();
		if (name) this._add("constant", name.getText(), ctx);
		return null;
	}

	visitFunction_(ctx) {
		const name = ctx.IDENTIFIER();
		if (name) {
			const fields = ctx.field?.() ?? [];
			const params = fields
				.map((f) => f.IDENTIFIER()?.getText())
				.filter(Boolean);
			this._add("method", name.getText(), ctx, params);
		}
		return null;
	}

	visitField(ctx) {
		const name = ctx.IDENTIFIER();
		if (name) this._add("field", name.getText(), ctx);
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "document",
	extensions: [".thrift"],
});
