import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveArtDirection, SLOTS } from "./artDirection.js";
import { estimateCampaign } from "./estimate.js";
import { loadBriefFile, runCampaign } from "./pipeline.js";
import { PREVIEW_MODEL } from "./pricing.js";
import type { CampaignReport } from "./report.js";

/**
 * Thin wrapper over the exact same runCampaign() the server calls.
 * There is no second implementation of the pipeline.
 *
 *   npm run campaign -- samples/campaign.yaml
 */
const args = process.argv.slice(2);

// An unrecognised flag must not fall through to a full campaign against the live
// key, so `--help` spent real money. Anything this does not understand stops
// here instead. `--help` is itself a documented flag and belongs in the set:
// left out, asking for help printed the help, then reported "Unrecognised:
// --help", then exited 2, telling a script that reading the manual was an error.
const KNOWN = new Set(["--all", "--dry-run", "--prompts", "--preview", "--help"]);
const unknown = args.filter((a) => a.startsWith("--") && !KNOWN.has(a));
if (unknown.length || args.includes("--help")) {
  console.log(`
  npm run campaign -- <brief>              produce a campaign
  npm run campaign -- <brief> --preview    the whole campaign for about 3 cents
  npm run campaign -- <brief> --dry-run    what it would cost, spending nothing
  npm run campaign -- <brief> --dry-run --prompts   ...and the exact prompts
  npm run portfolio                        every brief in samples/briefs.json
${unknown.length ? `\n  Unrecognised: ${unknown.join(", ")}\n` : ""}`);
  process.exit(unknown.length ? 2 : 0);
}

const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--")) ?? "samples/campaign.yaml";

// --all runs every brief in samples/briefs.json back to back.
//
// The customer in the exercise launches hundreds of localized campaigns a
// month, and a single-campaign demo does not show that shape. Nothing new is
// built for it: it is the same runCampaign() in a loop, which is the point --
// scale here is a loop, not an architecture. Heroes already approved cost
// nothing, so the marginal campaign is usually free.
if (args.includes("--all")) {
  // Same contract as a single run: a refused brief or a failed product is a
  // non-zero exit, so this is usable in a pipeline rather than always green.
  process.exit(await runPortfolio());
}

// A brief that fails the contract is a normal outcome, not a crash. Without
// this it threw before reaching the handler below and a marketer got a Node
// stack trace pointing at parseBrief.
const brief = await loadBriefFile(path.resolve(file)).catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});

// --dry-run answers "what will this cost" without calling a provider.
if (dryRun) {
  const e = await estimateCampaign(brief);
  console.log(`
DRY RUN  ${e.campaignName}

  Preflight                   ${e.preflight.status.toUpperCase()}${e.blocked ? " - blocked, nothing would be generated" : ""}
  Formats × markets           ${e.ratios.length} × ${e.locales.length}  (${e.locales.join(", ")})
  Creatives to produce        ${e.variants}
  Heroes to generate          ${e.generations}${e.generations ? `  · ${e.model}` : " - everything is already approved"}
  Estimated spend             ${e.estimatedCostUsd ? `$${e.estimatedCostUsd.totalUsd.toFixed(3)}` : "unknown - no published price for this model"}${e.estimatedTimeSaved ? `\n  Estimated time saved        ${Math.round(e.estimatedTimeSaved.savedMinutes)} min  (illustrative, vs ${e.estimatedTimeSaved.baselineMinutesPerCreative} min/creative baseline)` : ""}
`);
  for (const p of e.products) {
    const how =
      p.action === "reuse"
        ? `REUSE     ${p.sourceAssetPath?.split("/").pop()}`
        : `GENERATE  ${p.usingReference ? "from packshot reference" : "text-to-image"}`;
    console.log(`  ${p.productName.padEnd(30)} ${how}`);
  }
  // --prompts prints what each paid generation would actually be asked for.
  // Off by default: the summary answers "what will this cost", and the full
  // art direction is a paragraph per product that would bury it.
  if (args.includes("--prompts")) {
    // What this brief actually changed, before any of the paragraph. Most
    // art-direction questions are "did my override land" and "what am I
    // inheriting", and both are answerable here for nothing.
    const art = resolveArtDirection(brief);
    console.log(`\n  LOOK  ${art.look}${art.overridden.length ? "" : "  (nothing overridden)"}`);
    for (const slot of SLOTS) {
      const changed = art.overridden.includes(slot);
      console.log(
        `  ${changed ? "→" : " "} ${slot.padEnd(10)} ${changed ? "" : "inherited  "}${art.slots[slot].slice(0, changed ? 96 : 60)}${art.slots[slot].length > 60 ? "…" : ""}`,
      );
    }
    console.log("    composition  LOCKED - derived from the crop arithmetic");
    console.log("    typography   LOCKED - stops invented claims on the product");

    for (const p of e.products.filter((x) => x.prompt)) {
      console.log(`\n  ── ${p.productName} ─────────────────────────────────────────`);
      console.log(
        p.prompt
          ?.split(". ")
          .map((line) => `  ${line.trim()}${line.endsWith(".") ? "" : "."}`)
          .join("\n"),
      );
    }
    console.log("");
  }

  console.log(
    e.blocked
      ? `\n  ✗ ${e.preflight.checks
          .filter((c) => c.status === "fail")
          .map((c) => c.message)
          .join("; ")}\n`
      : "\n  Nothing was generated. Re-run without --dry-run to produce these.\n",
  );
  process.exit(e.blocked ? 2 : 0);
}

const preview = args.includes("--preview");
if (preview) {
  console.log(
    `\n  PREVIEW  hero at 1K on ${PREVIEW_MODEL.id} - $${PREVIEW_MODEL.usdPer2K.toFixed(4)} per` +
      " generation instead of $0.134.\n  Exports are upscaled from a 1K source, so this is for" +
      " judging the look, not for shipping.\n",
  );
}

const report = await runCampaign(brief, {
  preview,
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
  Heroes generated            ${m.heroesGenerated}${m.heroesFromCache ? `  (+${m.heroesFromCache} from cache)` : ""}${m.heroesPlaceholder ? `\n  Offline placeholders        ${m.heroesPlaceholder}  (no model called - set GEMINI_API_KEY for real generation)` : ""}
  Channel variants created    ${m.variantsCreated}
  Validation passed           ${m.validationPassed} / ${m.variantsCreated}
  Live hero generations       ${m.liveHeroGenerations}
  Elapsed                     ${(report.durationMs / 1000).toFixed(1)}s
  Provider                    ${report.provider.provider} · ${report.provider.model}

  Outputs → outputs/${report.campaignId}/
`);

if (report.failures.length > 0) {
  console.log("  Products that failed:");
  for (const f of report.failures) {
    console.log(`    ✗ ${f.productName} (${f.stage}) - ${f.message.slice(0, 100)}`);
  }
  console.log("");
}

/**
 * Exit codes carry the outcome, so this composes into a batch script.
 *   0  every product produced every creative
 *   2  partial success -- some creatives shipped, some products failed
 *   1  the run could not start (thrown above)
 */
process.exit(report.failures.length > 0 ? 2 : 0);

/** Sums one field across every campaign that completed. */
function total<T>(rows: T[], pick: (row: T) => number | undefined): number {
  return rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);
}

/**
 * Every brief in the library, back to back.
 *
 * The manifest deliberately contains briefs whose purpose is to be refused, so
 * counting any refusal as a failure would mean this could never return 0. A
 * status that cannot report success is as useless as one that cannot report
 * failure: nobody looks at it, and a real failure is indistinguishable from the
 * one that was always there.
 *
 * Each entry already declares what it expects, so that is what gets checked. A
 * brief that should be refused and is refused passes. One that should be
 * refused and RUNS fails, which is the case actually worth catching.
 */
async function runPortfolio(): Promise<number> {
  const manifest: { file: string; label: string; expect: string }[] = JSON.parse(
    await readFile(path.resolve("samples/briefs.json"), "utf8"),
  );

  const done: CampaignReport[] = [];
  const blocked: { label: string; why: string }[] = [];
  const wrong: string[] = [];
  const startedAt = Date.now();

  console.log(`\nPORTFOLIO RUN  ${manifest.length} briefs\n`);

  for (const entry of manifest) {
    const shouldBlock = entry.expect.includes("blocked");
    try {
      const report = await runCampaign(await loadBriefFile(path.resolve("samples", entry.file)));
      done.push(report);
      const m = report.metrics;
      console.log(
        `  ✓ ${entry.label.padEnd(26)} ${String(m.variantsCreated).padStart(3)} creatives · ` +
          `${m.approvedAssetsReused} reused · ${m.liveHeroGenerations} generated`,
      );
      if (shouldBlock) {
        wrong.push(`${entry.label} was expected to be refused and produced creatives`);
      }
    } catch (error) {
      // A brief that fails preflight is a correct outcome, not a crash: the
      // legal-fail sample is in the manifest precisely to be refused.
      const why = error instanceof Error ? error.message : String(error);
      blocked.push({ label: entry.label, why });
      console.log(
        `  ${shouldBlock ? "✓" : "✗"} ${entry.label.padEnd(26)} refused - ${why.split("\n")[0]}`,
      );
      if (!shouldBlock) wrong.push(`${entry.label} was refused: ${why.split("\n")[0]}`);
    }
  }

  // campaign.json and campaign.yaml are the same campaign in two formats and
  // write to the same id. Summing both counted it twice.
  const unique = [...new Map(done.map((r) => [r.campaignId, r])).values()];
  const creatives = total(unique, (r) => r.metrics.variantsCreated);
  const generations = total(unique, (r) => r.metrics.liveHeroGenerations);
  const reused = total(unique, (r) => r.metrics.approvedAssetsReused);
  const spend = total(unique, (r) => r.estimatedCostUsd?.totalUsd);
  // Hours and dollars must come from the same campaigns, or the sentence
  // implies an hourly rate no brief ever stated.
  const priced = unique.filter((r) => r.successMetrics.timeSaved?.usd !== undefined);
  const savedMin = total(priced, (r) => r.successMetrics.timeSaved?.minutes);
  const savedUsd = total(priced, (r) => r.successMetrics.timeSaved?.usd);

  console.log(`
PORTFOLIO COMPLETE

  Campaigns produced          ${unique.length}${blocked.length ? `  (${blocked.length} refused at preflight, as the library says they should be)` : ""}
  Creatives exported          ${creatives}
  Approved heroes reused      ${reused}
  Live hero generations       ${generations}
  Model spend                 $${spend.toFixed(3)}
  Elapsed                     ${((Date.now() - startedAt) / 1000).toFixed(1)}s
`);

  // The cost objection, answered with the run's own two numbers. A campaign
  // costs cents because the model is called once per missing hero; the labour
  // it displaces is the figure that matters, and only appears when a brief
  // states its rate.
  const failed = unique.some((r) => r.failures.length > 0);
  if (wrong.length > 0) {
    console.log("  Briefs that did not do what the library says they do:");
    for (const line of wrong) console.log(`    ✗ ${line}`);
    console.log("");
  }
  if (savedUsd > 0 && spend > 0) {
    console.log(
      `  ${(savedMin / 60).toFixed(1)} studio hours and $${savedUsd.toLocaleString()} of labour avoided,\n` +
        `  for $${spend.toFixed(3)} of model spend. Illustrative, from the rates the briefs state.\n`,
    );
  }

  return wrong.length > 0 || failed ? 2 : 0;
}
