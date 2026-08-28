import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/server.js";

/**
 * The local app's HTTP surface.
 *
 * Seventeen routes had no test, and four of them spend money or write files.
 * Every test here exercises a REFUSAL or a read: nothing in this file starts a
 * generation, so the suite stays free to run.
 *
 * The guard paths are the ones worth holding. A route that spends money on a
 * request it should have rejected is the only bug in this server that costs
 * something, and it cannot be caught by typechecking.
 */
let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const get = (path: string) => fetch(`${base}${path}`);
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("server: reads", () => {
  it("serves the brief library, the formats, the models and the looks", async () => {
    const briefs = await (await get("/api/briefs")).json();
    expect(Array.isArray(briefs)).toBe(true);
    expect(briefs.length).toBeGreaterThan(1);
    // Every entry has to carry what the console renders, or the picker shows
    // blanks and nothing fails.
    for (const b of briefs) expect(b).toMatchObject({ file: expect.any(String) });

    const formats = await (await get("/api/formats")).json();
    expect(formats.some((f: { required: boolean }) => f.required)).toBe(true);

    const { models } = await (await get("/api/models")).json();
    // The picker must never offer a model that cannot serve the size the
    // adapter asks for.
    for (const m of models) expect(m.maxImageSize).toBe("2K");

    const { looks } = await (await get("/api/looks")).json();
    expect(looks.map((l: { id: string }) => l.id)).toContain("daylight");
  });

  it("prices the shot catalogue without generating anything", async () => {
    const { shots, unitPriceUsd } = await (await get("/api/shots")).json();
    expect(shots.length).toBeGreaterThan(0);
    // The console multiplies these two to show the bill before the button.
    expect(typeof unitPriceUsd).toBe("number");
  });

  it("refuses a campaign id that climbs out of the output root", async () => {
    const res = await get("/api/campaigns/..%2F..%2Fetc/archive");
    expect(res.ok).toBe(false);
  });
});

describe("server: refusals before spending", () => {
  it("refuses an estimate with no brief", async () => {
    expect((await post("/api/estimate", {})).status).toBe(400);
  });

  it("refuses a run with no brief", async () => {
    expect((await post("/api/runs", {})).status).toBe(400);
  });

  it("refuses a shoot with no set-ups selected", async () => {
    // A VALID brief, deliberately. An invalid one returns 400 from the parser
    // and the test passes while the guard that matters is deleted - which is
    // what the first version of this test did.
    const brief = readFileSync("samples/campaign.yaml", "utf8");
    const res = await post("/api/shoot", {
      brief,
      productId: "radiance-serum",
      shots: [],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/set-up/i);
  });

  it("refuses an asset upload with a bad product id or mime type", async () => {
    expect(
      (await post("/api/assets", { productId: "../escape", mimeType: "image/png", dataBase64: "" }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("/api/assets", {
          productId: "ok-id",
          mimeType: "application/zip",
          dataBase64: "",
        })
      ).status,
    ).toBe(400);
  });

  it("refuses a batch that names no briefs", async () => {
    expect((await post("/api/batches", { files: [] })).status).toBe(400);
  });
});
