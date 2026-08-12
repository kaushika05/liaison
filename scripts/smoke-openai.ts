import { ModelService } from "../src/server/agent/model-service.js";
import { loadConfig } from "../src/server/config.js";
import { defaultAuthority } from "../src/shared/domain.js";

const service = new ModelService(loadConfig());
const brief = await service.plan("release-smoke", "+13045550101", {
  userFirstName: "Release",
  companyName: "Example Support",
  phoneNumber: "+13045550101",
  issueDescription: "A recent support request remains unresolved after two contacts.",
  chronologyText: "Called twice and received no case number.",
  desiredOutcome: "Obtain a case number and a clear follow-up date.",
  acceptableAlternativesText: "Written confirmation",
  unacceptableOutcomesText: "Any fee or account change",
  knownFactsText: "No payment is authorized.",
  disclosures: [],
  authority: defaultAuthority,
  officialNumberConfirmed: true,
  authorizedAccountConfirmed: true,
  lowRiskConfirmed: true,
});
const telemetry = service.drainTelemetry()[0];

process.stdout.write(`${JSON.stringify({
  ok: Boolean(brief.title && brief.strategySteps.length),
  modelRequestId: Boolean(telemetry?.requestId),
  responseId: Boolean(telemetry?.responseId),
  tokens: telemetry?.totalTokens ?? 0,
})}\n`);
