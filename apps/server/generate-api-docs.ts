import { writeFileSync } from "node:fs";
import { apiDocumentText } from "./src/http/openapi.ts";

// Writes the API's OpenAPI document to the file given, which
// scripts/generate-api-docs.sh names: docs/api/openapi.json.
const [file] = process.argv.slice(2);
if (file === undefined) {
  process.stderr.write("Usage: node generate-api-docs.ts FILE\n");
  process.exit(2);
}
writeFileSync(file, apiDocumentText());
