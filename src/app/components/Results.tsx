import { useEffect, useState } from "react";
import type { CampaignReport, Creative, ProductRecord } from "../types.js";

export type Selection = { creative: Creative; product: ProductRecord };

/**
 * The exported files, grouped by product, at their true aspect ratio.
 *
 * These are the largest thing on screen because they are what the run is for.
 * Cards carry no check list any more -- that detail moved to the inspector,
 * where it applies to one creative instead of stacking eight lines under each
 * of twenty-four.
 */
export function Results({
  report,
  brief,
  filterLocale,
  filterRatio,
  selected,
  onSelect,
}: {
  report?: CampaignReport;
  /** The brief text the shoot re-parses, so a shoot uses what is on screen. */
  brief?: string;
  filterLocale: string;
  filterRatio: string;
  selected: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  if (!report)
    return (
      <p className="empty">
        <strong>No creatives yet</strong>
        Run the campaign to produce them. Every file shown here is read from disk, not re-rendered
        in the browser.
      </p>
    );

  return (
    <>
      {report.failures.length > 0 && (
        <div className="failures">
          <strong>{report.failures.length} product(s) did not complete</strong>
          <ul>
            {report.failures.map((f) => (
              <li key={f.productId}>
                <b>{f.productName}</b> - {f.message}
              </li>
            ))}
          </ul>
          <p>Every other product was still exported.</p>
        </div>
      )}

      <div className="workspace">
        {report.products.map((product) => {
          const shown = product.creatives.filter(
            (c) =>
              (filterLocale === "all" || c.locale === filterLocale) &&
              (filterRatio === "all" || c.ratio === filterRatio),
          );
          if (shown.length === 0) return null;

          return (
            <section key={product.productId} className="product">
              <div className="product-head">
                <div>
                  <h3>{product.productName}</h3>
                  <p className="prov">{provenance(product)}</p>
                </div>
                <SourceBadge source={product.hero.source} />
                <ReviewBadge product={product} />
              </div>

              {brief && <ShootPanel productId={product.productId} brief={brief} />}

              <div className="shots">
                {shown.map((c) => {
                  const on =
                    selected?.creative.outputPath === c.outputPath &&
                    selected?.product.productId === product.productId;
                  return (
                    <button
                      type="button"
                      key={`${c.ratio}-${c.locale}`}
                      className={`shot ${on ? "on" : ""}`}
                      style={{
                        flexBasis: `${BASIS[c.ratio] ?? 236}px`,
                        flexGrow: BASIS[c.ratio] ?? 236,
                      }}
                      onClick={() => onSelect({ creative: c, product })}
                    >
                      <span className="frame" style={{ aspectRatio: `${c.width} / ${c.height}` }}>
                        <img
                          src={`/outputs/${c.outputPath}`}
                          alt={`${product.productName} ${c.ratio} ${c.locale}`}
                        />
                      </span>
                      <span className="cap">
                        <b>{c.ratio.replace("x", ":")}</b>
                        <span className="loc">{c.locale}</span>
                        <span className={`dot ${c.validation.status}`} />
                      </span>
                    </button>
                  );
                })}
              </div>

              <PostCopy product={product} locale={filterLocale} />
            </section>
          );
        })}
      </div>
    </>
  );
}

/**
 * Flex bases in the ratio's own proportion, so a row of mixed formats stays
 * aspect-true and equal-height at any width without a media query. These are
 * bases, never heights -- the cards grow past them to fill the row.
 */
const BASIS: Record<string, number> = { "1x1": 236, "4x5": 190, "9x16": 133, "16x9": 420 };

/**
 * The brief names slow approval cycles as a pain point, so say plainly which
 * products a human still has to look at. Derived here rather than stored:
 * anything a new model produced, or anything that did not pass cleanly, needs
 * eyes. Reused approved assets that passed every check do not.
 */
type ShotCatalogue = {
  shots: { id: string; label: string; framing: string }[];
  model: string;
  unitPriceUsd?: number;
};
type ShotResult = { id: string; label: string; path?: string; error?: string };

/**
 * Cover one product from several camera set-ups, with the bill shown first.
 *
 * The campaign path generates ONE hero and crops it to every format, because a
 * crop is free and a generation is not. That is the cost argument this whole
 * pipeline rests on, and coverage is what it gives up. This is what buying the
 * coverage back costs, and the reason it lives behind a disclosure with a
 * running total rather than behind a button: nine set-ups is nine paid
 * generations, roughly ten times the campaign that produced the hero. Nobody
 * should discover that afterwards.
 *
 * Defaults to nothing selected. A control that spends money on load is not a
 * control.
 */
function ShootPanel({ productId, brief }: { productId: string; brief: string }) {
  const [catalogue, setCatalogue] = useState<ShotCatalogue | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<ShotResult[]>([]);

  useEffect(() => {
    fetch("/api/shots")
      .then((r) => r.json())
      .then(setCatalogue)
      .catch(() => {});
  }, []);

  if (!catalogue) return null;
  const unit = catalogue.unitPriceUsd ?? 0;
  const total = picked.length * unit;

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const shoot = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/shoot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, productId, shots: picked }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? "Shoot failed");
      else setMade(json.results ?? []);
    } catch {
      setError("Could not reach the local server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="shoot">
      <summary>
        Shoot camera variations
        <span> {catalogue.shots.length} set-ups available, one paid generation each</span>
      </summary>

      <div className="shoot-grid">
        {catalogue.shots.map((s) => (
          <label key={s.id} className={picked.includes(s.id) ? "on" : ""} title={s.framing}>
            <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} />
            {s.label}
          </label>
        ))}
      </div>

      <div className="shoot-bill">
        {/* The number that is real money, before the button that spends it. */}
        <b>
          {picked.length} x ${unit.toFixed(3)} = ${total.toFixed(3)}
        </b>
        <button type="button" onClick={shoot} disabled={busy || picked.length === 0}>
          {busy ? "Shooting…" : `Shoot ${picked.length || "nothing"}`}
        </button>
      </div>

      {error && <p className="err">{error}</p>}

      {made.length > 0 && (
        <div className="shoot-out">
          {made.map((r) =>
            r.path ? (
              <figure key={r.id}>
                <img src={r.path} alt={r.label} />
                <figcaption>{r.label}</figcaption>
              </figure>
            ) : (
              <p key={r.id} className="err">
                {r.label}: {r.error}
              </p>
            ),
          )}
        </div>
      )}
    </details>
  );
}

/**
 * The post that goes with the pictures, ready to paste.
 *
 * A creative is not a post. Whoever schedules it still needs a caption, a tag
 * set and alt text for every product in every market, which is the same
 * per-market, per-product multiplication the images used to cost - so producing
 * the image and stopping is stopping one step short of the thing being
 * automated. It was written to disk and shown one creative at a time in the
 * inspector; it belongs under the images, where the person copying it is
 * looking.
 *
 * Assembled, never generated. Every line is a string the brief already carries
 * and a human already signed off, and the whole post - caption, tags and alt
 * text - is screened by the prohibited-claim check before any of it is
 * produced.
 */
function PostCopy({ product, locale }: { product: ProductRecord; locale: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const posts = product.socialCopy ?? [];
  const shown = locale === "all" ? posts : posts.filter((p) => p.locale === locale);
  if (shown.length === 0) return null;

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard is permission-gated and can simply refuse. The text is on
      // screen and selectable either way, so this is not worth an error state.
    }
  };

  return (
    <div className="post-copy">
      {shown.map((post) => {
        const full = `${post.caption}\n\n${post.hashtags.join(" ")}`;
        return (
          <div key={post.locale} className="post">
            <div className="post-head">
              <code>{post.locale}</code>
              <button type="button" onClick={() => copy(full, post.locale)}>
                {copied === post.locale ? "Copied" : "Copy post"}
              </button>
              <button type="button" onClick={() => copy(post.altText, `${post.locale}-alt`)}>
                {copied === `${post.locale}-alt` ? "Copied" : "Copy alt text"}
              </button>
            </div>
            <p className="post-caption">{post.caption}</p>
            <p className="post-tags">{post.hashtags.join(" ")}</p>
            {/* A report written before alt text existed has none, and the
                console reads those back off disk. An empty ALT label is worse
                than no label. */}
            {post.altText && (
              <p className="post-alt">
                <b>ALT</b> {post.altText}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ReviewBadge({ product }: { product: ProductRecord }) {
  const clean = product.creatives.every((c) => c.validation.status === "pass");
  const label =
    product.hero.source === "reused" && clean
      ? "Approved source"
      : clean
        ? "Review generated hero"
        : "Review required";
  return (
    <span className={`review ${label === "Approved source" ? "auto" : "needed"}`}>{label}</span>
  );
}

export function provenance(product: ProductRecord): string {
  const h = product.hero;
  if (h.source === "reused") {
    return `Reused approved asset · ${h.sourceAssetPath?.split("/").pop() ?? ""}`;
  }
  const g = h.generation;
  return `${g?.provider} · ${g?.model} · ${g?.operation} · ${((g?.durationMs ?? 0) / 1000).toFixed(1)}s`;
}

function SourceBadge({ source }: { source: string }) {
  const label =
    source === "reused"
      ? "Reused"
      : source === "generated"
        ? "Generated"
        : source === "placeholder"
          ? "Offline preview - not a GenAI run"
          : "Generated earlier · review";
  return <span className={`badge ${source}`}>{label}</span>;
}
