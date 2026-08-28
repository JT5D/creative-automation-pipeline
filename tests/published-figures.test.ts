import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

const briefs = JSON.parse(readFileSync(path.resolve("samples/briefs.json"), "utf8")) as unknown[];

const readme = readFileSync(path.resolve("README.md"), "utf8");
const microsite = readFileSync(path.resolve("docs/index.html"), "utf8");

const seconds = (report.durationMs / 1000).toFixed(1);
const cost = report.estimatedCostUsd?.totalUsd.toFixed(3);
const perCreative = report.successMetrics.efficiency.secondsPerCreative.toFixed(2);
const creatives = String(report.metrics.variantsCreated);

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
    where: "README walkthrough - cost at full scale",
    doc: readme,
    pattern: /still one generation, still \$([\d.]+)\./,
    expected: String(cost),
  },
  {
    where: "README requirements traceability - assignmentProof check count",
    doc: readme,
    pattern: /own records - (\w+) facts counted off the files on disk/,
    expected: numberWord(report.assignmentProof.checks.length),
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
];

function capitalise(word: string): string {
  return word[0].toUpperCase() + word.slice(1);
}

function numberWord(n: number): string {
  return (
    ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ??
    String(n)
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
