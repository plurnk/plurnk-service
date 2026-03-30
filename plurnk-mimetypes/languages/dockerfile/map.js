import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import DockerfileParserVisitor from "./generated/DockerfileParserVisitor.js";

class Extractor extends withExtractor(DockerfileParserVisitor) {
	visitFromInstruction(ctx) {
		const image = ctx.imageName?.()?.getText();
		const stage = ctx.stageName?.()?.getText();
		const name = stage ? `${stage} (${image})` : image;
		if (name) this._add("module", name, ctx);
		return null;
	}

	visitArgInstruction(ctx) {
		const args = ctx.argument?.() ?? [];
		if (args.length > 0) this._add("variable", args[0].getText(), ctx);
		return null;
	}

	visitEnvInstruction(ctx) {
		const pairs = ctx.envPair?.() ?? [];
		for (const pair of pairs) {
			const args = pair.argument?.() ?? [];
			if (args.length > 0) this._add("variable", args[0].getText(), ctx);
		}
		return null;
	}

	visitLabelInstruction(ctx) {
		const pairs = ctx.labelPair?.() ?? [];
		for (const pair of pairs) {
			const args = pair.argument?.() ?? [];
			if (args.length > 0) this._add("field", args[0].getText(), ctx);
		}
		return null;
	}

	visitExposeInstruction(ctx) {
		this._add("field", ctx.arguments?.()?.getText(), ctx);
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "dockerfile",
	extensions: [".dockerfile"],
});
