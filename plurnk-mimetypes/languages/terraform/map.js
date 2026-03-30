import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import terraformVisitor from "./generated/terraformVisitor.js";

class Extractor extends withExtractor(terraformVisitor) {
	visitResource(ctx) {
		const type = ctx.resourcetype?.()?.getText()?.replace(/"/g, "") ?? "";
		const name = ctx.name?.()?.getText()?.replace(/"/g, "") ?? "";
		if (type || name) this._add("class", `${type}.${name}`, ctx);
		return null;
	}

	visitData(ctx) {
		const type = ctx.resourcetype?.()?.getText()?.replace(/"/g, "") ?? "";
		const name = ctx.name?.()?.getText()?.replace(/"/g, "") ?? "";
		if (type || name) this._add("class", `data.${type}.${name}`, ctx);
		return null;
	}

	visitVariable(ctx) {
		const name = ctx.name?.()?.getText()?.replace(/"/g, "");
		if (name) this._add("variable", name, ctx);
		return null;
	}

	visitOutput(ctx) {
		const name = ctx.name?.()?.getText()?.replace(/"/g, "");
		if (name) this._add("variable", name, ctx);
		return null;
	}

	visitModule(ctx) {
		const name = ctx.name?.()?.getText()?.replace(/"/g, "");
		if (name) this._add("module", name, ctx);
		return null;
	}

	visitLocal(ctx) {
		this._add("variable", "locals", ctx);
		return null;
	}

	visitProvider(ctx) {
		const type = ctx.resourcetype?.()?.getText()?.replace(/"/g, "");
		if (type) this._add("variable", `provider.${type}`, ctx);
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "file_",
	extensions: [".tf"],
});
