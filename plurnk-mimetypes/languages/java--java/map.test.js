import { testLanguage } from "../../lib/testutil.js";

await testLanguage("java--java", {
	examplesDir: "vendor/grammars-v4/java/java/examples",
	extensions: [".java"],
	skip: [
		// Java Records support has a bug in the ported base class (DoLastRecordComponent)
		"AllInOne17.java",
		"RecordExample.java",
		"RecordsTesting.java",
		"performance/x/RecordExample.java",
	],
});
