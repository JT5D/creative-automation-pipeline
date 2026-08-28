import "dotenv/config";
import path from "node:path";
import { loadBriefFile, runCampaign } from "./pipeline.js";

/**
 * Thin wrapper over the exact same runCampaign() the server calls.
 * There is no second implementation of the pipeline.
 *
 *   npm run campaign -- samples/campaign.yaml
 */
const file = process.argv[2] ?? "samples/campaign.yaml";

const brief = await loadBriefFile(path.resolve(file));

const report = await runCampaign(brief, {
  onEvent: (e) => {
    const detail = e.detail ? ` ${JSON.stringify(e.detail)}` : "";
    console.log(`  ${e.event}${detail}`);
  },
}).catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const m = report.metrics;
console.log(`
CAMPAIGN COMPLETE  ${report.campaignName}

  Products processed          ${m.productsProcessed}
  Approved heroes reused      ${m.approvedAssetsReused}
  Heroes generated            ${m.heroesGenerated}${m.heroesFromCache ? `  (+${m.heroesFromCache} from cache)` : ""}${m.heroesPlaceholder ? `\n  Offline placeholders        ${m.heroesPlaceholder}  (no model called — set GEMINI_API_KEY for real generation)` : ""}
  Channel variants created    ${m.variantsCreated}
  Validation passed           ${m.validationPassed} / ${m.variantsCreated}
  Paid generation calls       ${m.generationRequests}
  Elapsed                     ${(report.durationMs / 1000).toFixed(1)}s
  Provider                    ${report.provider.provider} · ${report.provider.model}

  Outputs → outputs/${report.campaignId}/
`);
