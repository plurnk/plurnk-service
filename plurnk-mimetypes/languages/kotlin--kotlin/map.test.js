import { testLanguage } from "../../lib/testutil.js";

await testLanguage("kotlin--kotlin", {
	examplesDir: "vendor/grammars-v4/kotlin/kotlin/examples",
	extensions: [".kt", ".kts"],
});
