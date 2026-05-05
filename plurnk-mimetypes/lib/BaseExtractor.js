export function withExtractor(VisitorClass) {
	return class extends VisitorClass {
		_symbols = [];
		_inBody = false;

		get symbols() {
			return this._symbols;
		}

		_add(kind, name, ctx, params, extra) {
			const symbol = {
				name,
				kind,
				line: ctx.start.line,
				endLine: this._endLine(ctx),
			};
			if (params) symbol.params = params;
			if (extra) Object.assign(symbol, extra);
			this._symbols.push(symbol);
		}

		_endLine(ctx) {
			return ctx.stop?.line ?? ctx.start.line;
		}

		_gateBody(ctx) {
			const was = this._inBody;
			this._inBody = true;
			this.visitChildren(ctx);
			this._inBody = was;
			return null;
		}
	};
}

export function createMap({ ExtractorClass, entryRule, extensions }) {
	return class {
		static status = "done";
		static entryRule = entryRule;
		static extensions = extensions;

		static extract(tree) {
			const visitor = new ExtractorClass();
			visitor.visit(tree);
			return visitor.symbols;
		}
	};
}
