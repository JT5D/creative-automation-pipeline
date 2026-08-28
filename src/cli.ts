import "dotenv/config";
import path from "node:path";
import { estimateCampaign } from "./estimate.js";
import { loadBriefFile, runCampaign } from "./pipeline.js";

/**
 * Thin wrapper over the exact same runCampaign() the server calls.
 * There is no second implementation of the pipeline.
 *
 *   npm run campaign -- samples/campaign.yaml
 */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--")) ?? "samples/campaign.yaml";

const brief = await loadBriefFile(path.resolve(file));

// --dry-run answers "what will this cost" without calling a provider.
if (dryRun) {
  const e = await estimateCampaign(brief);
  console.log(`
DRY RUN  ${e.campaignName}

  Preflight                   ${e.preflight.status.toUpperCase()}${e.blocked ? "  — blocked, nothing would be generated" : ""}
  Formats × markets           ${e.ratios.length} × ${e.locales.length}  (${e.locales.join(", ")})
  Creatives to produce        ${e.variants}
  Heroes to generate          ${e.generations}${e.generations ? `  · ${e.model}` : "  — everything is already approved"}
  Estimated spend             ${e.estimatedCostUsd ? `$${e.estimatedCostUsd.totalUsd.toFixed(3)}` : "unknown — no published price for this model"}${e.estimatedTimeSaved ? `\n  Estimated time saved        ${Math.round(e.estimatedTimeSaved.savedMinutes)} min  (illustrative, vs ${e.estimatedTimeSaved.baselineMinutesPerCreative} min/creative baseline)` : ""}
`);
  for (const p of e.products) {
    const how =
      p.action === "reuse"
        ? `REUSE     ${p.sourceAssetPath?.split("/").pop()}`
        : `GENERATE  ${p.usingReference ? "from packshot reference" : "text-to-image"}`;
    console.log(`  ${p.productName.padEnd(30)} ${how}`);
  }
  console.log(e.blocked ? `\n  ✗ ${e.preflight.checks.filter((c) => c.status === "fail").map((c) => c.message).join("; ")}\n` : "\n  Nothing was generated. Re-run without --dry-run to produce these.\n");
  process.exit(e.blocked ? 2 : 0);
}

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
