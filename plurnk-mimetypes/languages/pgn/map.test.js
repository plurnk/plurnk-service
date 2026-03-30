import { testLanguage } from "../../lib/testutil.js";

await testLanguage("pgn", {
	examplesDir: "vendor/grammars-v4/pgn/examples",
	extensions: [".pgn"],
	skip: [
		// PGN grammar uses getCharPositionInLine in a semantic predicate
		// which doesn't exist in the antlr4 JS runtime
		"Adams - OK.pgn",
		"Alekhine.pgn",
		"Anand - OK.pgn",
		"Ivanchuk.pgn",
		"Karpov.pgn",
		"Kasparov - OK 2.pgn",
		"Kasparov - OK 3.pgn",
		"Kasparov - OK.pgn",
		"Kosteniuk.pgn",
		"Morozevich.pgn",
		"Shirov - OK.pgn",
		"Topalov.pgn",
	],
});
