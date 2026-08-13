import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toJSONSchema, type ZodType } from "zod";
import {
  attentionRequestSchema,
  authorityEnvelopeSchema,
  commitmentSchema,
  disclosureEventSchema,
  executionPlanSchema,
  outcomeReportSchema,
  supportIntentSchema,
} from "../src/shared/protocol.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolDirectory = path.join(repositoryRoot, "protocol", "v1");

const schemas: ReadonlyArray<readonly [string, string, ZodType]> = [
  ["support-intent.schema.json", "SupportIntent", supportIntentSchema],
  ["authority-envelope.schema.json", "AuthorityEnvelope", authorityEnvelopeSchema],
  ["execution-plan.schema.json", "ExecutionPlan", executionPlanSchema],
  ["attention-request.schema.json", "AttentionRequest", attentionRequestSchema],
  ["commitment.schema.json", "Commitment", commitmentSchema],
  ["disclosure-event.schema.json", "DisclosureEvent", disclosureEventSchema],
  ["outcome-report.schema.json", "OutcomeReport", outcomeReportSchema],
];

await mkdir(protocolDirectory, { recursive: true });

for (const [fileName, title, schema] of schemas) {
  const jsonSchema = toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    cycles: "ref",
    reused: "ref",
  });
  const { "~standard": _standardMetadata, ...serializableSchema } = jsonSchema;
  void _standardMetadata;
  const document = {
    ...serializableSchema,
    $id: `https://liaison-protocol.invalid/v1/${fileName}`,
    title,
  };
  await writeFile(path.join(protocolDirectory, fileName), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

const exampleFiles = [
  ["support-intent.json", supportIntentSchema],
  ["attention-request.json", attentionRequestSchema],
  ["commitment.json", commitmentSchema],
  ["disclosure-event.json", disclosureEventSchema],
  ["outcome-report.json", outcomeReportSchema],
] as const;

for (const [fileName, schema] of exampleFiles) {
  const examplePath = path.join(protocolDirectory, "examples", fileName);
  schema.parse(JSON.parse(await readFile(examplePath, "utf8")));
}

console.log(`Generated ${schemas.length} protocol v1 schemas and validated ${exampleFiles.length} examples in ${protocolDirectory}`);
