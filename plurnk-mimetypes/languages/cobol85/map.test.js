import { testLanguage } from "../../lib/testutil.js";

await testLanguage("cobol85", {
	examplesDir: "vendor/grammars-v4/cobol85/examples",
	extensions: [".cbl", ".cob", ".cpy", ".txt"],
});
