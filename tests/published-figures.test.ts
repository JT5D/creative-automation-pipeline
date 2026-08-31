import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatUsd } from "../src/pricing.js";
import type { CampaignReport } from "../src/report.js";

/**
 * Every number published anywhere in this repo, checked against the run it
 * claims to come from.
 *
 * The README opens by saying "every number on this page comes from the run
 * committed in docs/sample-output/report.json". That sentence was false for
 * two figures at once - the README said 39.3s and 1.41s while the committed
 * report said 39.8s and 1.66s - because a number in prose is a COPY of a fact,
 * and copies drift silently. Nothing failed when they did.
 *
 * So the claims are listed here as (where, what, expected) and derived from the
 * report at test time. It goes red in both directions: change the run without
 * updating the docs, or reword a sentence so the pattern stops matching, and
 * this fails. That is the point - a figure nobody can forget to update.
 */
const report = JSON.parse(
  readFileSync(path.resolve("docs/sample-output/report.json"), "utf8"),
) as CampaignReport;

const briefs = JSON.parse(readFileSync(path.resolve("samples/briefs.json"), "utf8")) as {
  expect: string;
}[];

/**
 * What the whole sample library adds up to, summed from what each brief
 * advertises.
 *
 * Those advertised figures are not decoration: tests/pipeline.test.ts runs every
 * brief that is not meant to be refused and asserts it produces exactly what its
 * manifest entry claims. So summing them here pins the README's batch sentence
 * to the same reality, through the manifest, without running six campaigns.
 */
const library = briefs.reduce(
  (acc, b) => {
    const m = /^(\d+) creatives · (\d+) generations?$/.exec(b.expect);
    if (!m) return acc;
    return { creatives: acc.creatives + Number(m[1]), generations: acc.generations + Number(m[2]) };
  },
  { creatives: 0, generations: 0 },
);

const readme = readFileSync(path.resolve("README.md"), "utf8");
const microsite = readFileSync(path.resolve("docs/index.html"), "utf8");

const seconds = (report.durationMs / 1000).toFixed(1);
const cost = report.estimatedCostUsd?.totalUsd.toFixed(3);
const perCreative = report.successMetrics.efficiency.secondsPerCreative.toFixed(2);
const creatives = String(report.metrics.variantsCreated);
const passedChecks = report.assignmentProof.checks.filter((c) => c.passed).length;
// The three the recruiter FAQ names by name: time saved, campaigns generated,
// overall efficiency. They are on the microsite now, so they are pinned like
// everything else on it.
const saved = report.successMetrics.timeSaved;
const eff = report.successMetrics.efficiency;
if (!saved) throw new Error("the committed run has no timeSaved to pin the microsite against");
const savedHours = (saved.minutes / 60).toFixed(1);
const savedUsd = String(Math.round(saved.usd ?? 0));
// Formatted the way the console formats money, so the page and the product
// cannot round the same number two different ways. At three decimals this read
// $0.006 for a figure that is $0.00558.
const perCreativeUsd = formatUsd(eff.costPerCreativeUsd ?? 0).slice(1);
const reusePct = String(Math.round(eff.reuseRate * 100));
// Formats are not a field on the report. Every product is produced in every
// format in every market, so the count divides out - and deriving it means the
// strip cannot claim a format the run did not actually cut.
const formats =
  report.metrics.variantsCreated /
  (report.metrics.productsProcessed * report.metrics.marketsProcessed);

/**
 * Each claim names the document, the sentence it lives in, and the value the
 * run says it should carry. The pattern must capture exactly one group.
 */
const CLAIMS: { where: string; doc: string; pattern: RegExp; expected: string }[] = [
  {
    where: "README headline - elapsed for the full selection",
    doc: readme,
    pattern: /24 creatives in ([\d.]+)s for \$/,
    expected: seconds,
  },
  {
    where: "README headline - cost for the full selection",
    doc: readme,
    pattern: /24 creatives in [\d.]+s for \$([\d.]+)/,
    expected: String(cost),
  },
  {
    where: "README business goal 1 - campaign velocity",
    doc: readme,
    pattern: /One brief → 24 validated creatives in ([\d.]+)s/,
    expected: seconds,
  },
  {
    where: "README pain point 1 - seconds per creative",
    doc: readme,
    pattern: /One brief → 24 finished creatives, ([\d.]+)s each/,
    expected: perCreative,
  },
  {
    where: "README requirements traceability - assignmentProof check count",
    doc: readme,
    pattern: /own records - (\w+) checks over what the run actually wrote/,
    expected: numberWord(report.assignmentProof.checks.length),
  },
  {
    where: "microsite business metrics - time saved",
    doc: microsite,
    pattern: /<span class="v">([\d.]+)h<\/span><span class="l">Time saved per run/,
    expected: savedHours,
  },
  {
    where: "microsite business metrics - labour cost avoided",
    doc: microsite,
    pattern: /<span class="v">\$(\d+)<\/span><span class="l">Labour cost avoided/,
    expected: savedUsd,
  },
  {
    where: "microsite business metrics - creatives per paid generation",
    doc: microsite,
    pattern: /<span class="v">(\d+)<\/span><span class="l">Creatives per paid generation/,
    expected: String(eff.creativesPerGenerationCall),
  },
  {
    where: "microsite business metrics - cost per creative",
    doc: microsite,
    pattern: /<span class="v">\$([\d.]+)<\/span><span class="l">Cost per creative/,
    expected: perCreativeUsd,
  },
  {
    where: "microsite business metrics - reuse rate",
    doc: microsite,
    pattern: /<span class="v">(\d+)%<\/span><span class="l">Approved-asset reuse rate/,
    expected: reusePct,
  },
  {
    where: "README batch scale - creatives across the whole library",
    doc: readme,
    pattern: /\*\*(\d+)\ncreatives from \d+ generations for \$[\d.]+\*\*/,
    expected: String(library.creatives),
  },
  {
    where: "README batch scale - generations across the whole library",
    doc: readme,
    pattern: /\*\*\d+\ncreatives from (\d+) generations for \$[\d.]+\*\*/,
    expected: String(library.generations),
  },
  {
    where: "README sample library size",
    doc: readme,
    pattern: /(\w+) sample briefs ship with the repo/,
    expected: capitalise(numberWord(briefs.length)),
  },
  {
    where: "microsite lede - creatives, elapsed and cost",
    doc: microsite,
    pattern: /<strong>(\d+) creatives in [\d.]+ seconds for \$[\d.]+<\/strong>/,
    expected: creatives,
  },
  {
    where: "microsite lede - elapsed",
    doc: microsite,
    pattern: /<strong>\d+ creatives in ([\d.]+) seconds for \$[\d.]+<\/strong>/,
    expected: seconds,
  },
  {
    where: "microsite lede - cost",
    doc: microsite,
    pattern: /<strong>\d+ creatives in [\d.]+ seconds for \$([\d.]+)<\/strong>/,
    expected: String(cost),
  },
  // The stat strip is the first thing a reviewer reads and it carried none of
  // this. One of its tiles said "24/24 checks passed", which is the creative
  // validation rate wearing the word the assignment proof owns - the same
  // label-broader-than-measurement defect this repo keeps finding. Both
  // numbers are here now so neither can drift and neither can borrow the
  // other's meaning.
  {
    where: "microsite stat strip - products",
    doc: microsite,
    pattern: /<span class="v">(\d+)<\/span><span class="l">Products<\/span>/,
    expected: String(report.metrics.productsProcessed),
  },
  {
    where: "microsite stat strip - markets",
    doc: microsite,
    pattern: /<span class="v">(\d+)<\/span><span class="l">Markets<\/span>/,
    expected: String(report.metrics.marketsProcessed),
  },
  {
    where: "microsite stat strip - formats",
    doc: microsite,
    pattern: /<span class="v">(\d+)<\/span><span class="l">Formats<\/span>/,
    expected: String(formats),
  },
  {
    where: "microsite stat strip - creatives",
    doc: microsite,
    pattern: /<span class="v">(\d+)<\/span><span class="l">Creatives<\/span>/,
    expected: creatives,
  },
  {
    where: "microsite stat strip - paid generations",
    doc: microsite,
    pattern: /<span class="v">(\d+)<\/span><span class="l">Paid generation<\/span>/,
    expected: String(report.metrics.liveHeroGenerations),
  },
  {
    where: "microsite stat strip - creatives validated",
    doc: microsite,
    pattern: /<span class="v">([\d/]+)<\/span><span class="l">Creatives validated<\/span>/,
    expected: `${report.metrics.validationPassed}/${report.metrics.variantsCreated}`,
  },
  {
    where: "microsite stat strip - assignment proof",
    doc: microsite,
    pattern: /<span class="v">([\d/]+)<\/span><span class="l">Assignment proof[^<]*<\/span>/,
    expected: `${passedChecks}/${report.assignmentProof.checks.length}`,
  },
];

function capitalise(word: string): string {
  return word[0].toUpperCase() + word.slice(1);
}

function numberWord(n: number): string {
  return (
    [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
      "eleven",
      "twelve",
    ][n] ?? String(n)
  );
}

describe("published figures", () => {
  it.each(CLAIMS)("$where matches the committed run", ({ doc, pattern, expected }) => {
    const found = pattern.exec(doc);
    // A pattern that stops matching is a failure, not a skip. Rewording the
    // sentence around a number is exactly when the number gets left behind.
    expect(found, `no sentence in the document matched ${pattern}`).not.toBeNull();
    expect(found?.[1]).toBe(expected);
  });

  it("has a committed report that is a real, complete, live run", () => {
    // The docs quote this file, so it must never be a cache-served or offline
    // run. Both produce real files and neither demonstrates the requirement.
    expect(report.mode).toBe("final");
    expect(report.metrics.liveHeroGenerations).toBeGreaterThan(0);
    expect(report.metrics.heroesFromCache).toBe(0);
    expect(report.metrics.heroesPlaceholder).toBe(0);
    expect(report.assignmentProof.passed).toBe(true);
    expect(report.metrics.validationFailed).toBe(0);
  });

  it("ships the committed creatives and file tree alongside that report", () => {
    const tree = readFileSync(path.resolve("docs/sample-output/file-tree.txt"), "utf8")
      .split("\n")
      .filter(Boolean);

    // The tree has to describe the same run, or the evidence folder is two
    // different runs stapled together.
    for (const product of report.products) {
      for (const creative of product.creatives) {
        expect(tree).toContain(creative.outputPath);
      }
      // The caption files this run wrote are part of the delivered output.
      for (const post of product.socialCopy) {
        expect(tree.some((line) => line.endsWith(`/copy/${post.locale.toLowerCase()}.txt`))).toBe(
          true,
        );
      }
    }
  });
});
