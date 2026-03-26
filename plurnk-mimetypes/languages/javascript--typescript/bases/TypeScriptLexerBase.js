import antlr4 from "antlr4";
import TypeScriptLexer from "./TypeScriptLexer.js";

export default class TypeScriptLexerBase extends antlr4.Lexer {
	constructor(input) {
		super(input);
		this.scopeStrictModes = [];
		this.lastToken = null;
		this.useStrictDefault = false;
		this.useStrictCurrent = false;
		this.templateDepth = 0;
		this.bracesDepth = 0;
	}

	get UseStrictDefault() {
		return this.useStrictDefault;
	}

	set UseStrictDefault(value) {
		this.useStrictDefault = value;
		this.useStrictCurrent = value;
	}

	IsStartOfFile() {
		return this.lastToken == null;
	}

	IsStrictMode() {
		return this.useStrictCurrent;
	}

	StartTemplateString() {
		this.bracesDepth = 0;
	}

	IsInTemplateString() {
		return this.templateDepth > 0 && this.bracesDepth == 0;
	}

	nextToken() {
		const next = super.nextToken();
		if (next.channel == antlr4.Token.DEFAULT_CHANNEL) {
			this.lastToken = next;
		}
		return next;
	}

	ProcessOpenBrace() {
		this.bracesDepth++;
		this.useStrictCurrent = (this.scopeStrictModes.length > 0 && this.scopeStrictModes[this.scopeStrictModes.length - 1]) || this.UseStrictDefault;
		this.scopeStrictModes.push(this.useStrictCurrent);
	}

	ProcessCloseBrace() {
		this.bracesDepth--;
		this.useStrictCurrent = this.scopeStrictModes.length > 0 ? this.scopeStrictModes.pop() : this.UseStrictDefault;
	}

	ProcessStringLiteral() {
		if (this.lastToken == null || this.lastToken.type == TypeScriptLexer.OpenBrace) {
			const text = this.text;
			if (text === '"use strict"' || text === "'use strict'") {
				if (this.scopeStrictModes.length > 0) {
					this.scopeStrictModes.pop();
				}
				this.useStrictCurrent = true;
				this.scopeStrictModes.push(this.useStrictCurrent);
			}
		}
	}

	IncreaseTemplateDepth() {
		this.templateDepth++;
	}

	DecreaseTemplateDepth() {
		this.templateDepth--;
	}

	IsRegexPossible() {
		if (this.lastToken == null) return true;
		switch (this.lastToken.type) {
			case TypeScriptLexer.Identifier:
			case TypeScriptLexer.NullLiteral:
			case TypeScriptLexer.BooleanLiteral:
			case TypeScriptLexer.This:
			case TypeScriptLexer.CloseBracket:
			case TypeScriptLexer.CloseParen:
			case TypeScriptLexer.OctalIntegerLiteral:
			case TypeScriptLexer.DecimalLiteral:
			case TypeScriptLexer.HexIntegerLiteral:
			case TypeScriptLexer.StringLiteral:
			case TypeScriptLexer.PlusPlus:
			case TypeScriptLexer.MinusMinus:
				return false;
			default:
				return true;
		}
	}

	reset() {
		this.scopeStrictModes = [];
		this.lastToken = null;
		this.useStrictDefault = false;
		this.useStrictCurrent = false;
		this.templateDepth = 0;
		this.bracesDepth = 0;
		super.reset();
	}
}
