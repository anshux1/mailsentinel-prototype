import { readFileSync, writeFileSync } from "node:fs";
const openapi = JSON.parse(readFileSync("../../apps/analyzer/openapi.json", "utf8"));
writeFileSync("generated/analyzer-openapi.json", `${JSON.stringify(openapi, null, 2)}\n`);
