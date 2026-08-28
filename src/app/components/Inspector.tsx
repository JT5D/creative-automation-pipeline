import { useEffect, useRef, useState } from "react";
import type { Creative, ProductRecord } from "../types.js";

/**
 * One creative, at size, with its own provenance and checks.
 *
 * The per-card check lists this replaces were eight lines under every one of
 * twenty-four cards -- a wall nobody read. Selecting a creative is the natural
 * moment to ask "is this one right", so the detail lives here and the gallery
 * stays a gallery.
 *
 * There is no Approve or Regenerate control. The repo has no approval store,
 * and a button that silently does nothing is worse than an absent one: a
 * reviewer will click it. Sign-off is named as the human step it is.
 */
export function Inspector({
  creative: c,
  product,
  onClose,
  onApproveAsset,
}: {
  creative: Creative | null;
  product: ProductRecord | null;
  onClose: () => void;
  /** Supplies an approved hero for this product and writes it into the brief. */
  onApproveAsset: (productId: string, file: File) => Promise<void>;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!c || !product) {
    return (
      <aside className="inspector">
        <p className="empty">
          <strong>No creative selected</strong>
          Choose an exported file to see where its hero came from and which checks it passed.
        </p>
      </aside>
    );
  }

  const h = product.hero;
  const generated = h.source !== "reused";
  const post = product.socialCopy?.find((entry) => entry.locale === c.locale);

  return (
    <aside className="inspector">
      <div className="insp-shot">
        <img src={`/outputs/${c.outputPath}`} alt={`${product.productName} ${c.ratio}`} />
      </div>
      <h3>
        {product.productName} · {c.ratio.replace("x", ":")}
      </h3>

      <dl className="insp-meta">
        <dt>Source</dt>
        <dd>{generated ? "Generated hero" : "Approved hero, reused"}</dd>
        {generated ? (
          <>
            <dt>Model</dt>
            <dd>{h.generation?.model ?? "-"}</dd>
            <dt>Operation</dt>
            <dd>{h.generation?.operation ?? "-"}</dd>
          </>
        ) : (
          <>
            <dt>Origin</dt>
            <dd className="brk">{h.sourceAssetPath?.split("/").pop() ?? "-"}</dd>
            <dt>Cost</dt>
            <dd>None - no model call</dd>
          </>
        )}
        <dt>Dimensions</dt>
        <dd>
          {c.width} × {c.height}
        </dd>
        <dt>Market</dt>
        <dd>{c.locale}</dd>
        <dt>File</dt>
        <dd className="brk">{c.outputPath}</dd>
      </dl>

      {post && (
        <>
          <span className="insp-label">Caption for {c.locale}</span>
          {/* Assembled from copy the brief already carries, not written by a
              model, and screened by the same prohibited-term list as the
              pixels. It is here rather than on the card because it belongs to
              the post, and a post is a product in a market. */}
          <pre className="insp-caption">{post.caption}</pre>
          <p className="insp-tags">{post.hashtags.join(" ")}</p>
        </>
      )}

      <span className="insp-label">Production checks</span>
      <ul className="checks">
        {c.validation.checks.map((chk) => (
          <li key={chk.id} className={chk.status}>
            <span>{chk.status === "pass" ? "✓" : chk.status === "warning" ? "!" : "✕"}</span>
            {chk.message}
          </li>
        ))}
      </ul>

      {generated && (
        <SupplyApproved productId={product.productId} onApproveAsset={onApproveAsset} />
      )}

      <a className="ghost dl" href={`/outputs/${c.outputPath}`} download>
        Download this creative
      </a>
    </aside>
  );
}

/**
 * The half of review this repo can actually do.
 *
 * There is no approval store behind a sign-off button, so there is no sign-off
 * button. Supplying the approved asset is real: the file lands in
 * samples/assets, the brief gains an approvedHeroPath, and the next run finds
 * it on disk and generates nothing.
 */
function SupplyApproved({
  productId,
  onApproveAsset,
}: {
  productId: string;
  onApproveAsset: (productId: string, file: File) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (file?: File | null) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await onApproveAsset(productId, file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="insp-review">
      <strong>Review required</strong>
      <p>
        A model produced this hero. Creative sign-off happens with a person - but you can supply the
        approved asset here, and the next run will reuse it instead of generating one.
      </p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => send(e.target.files?.[0])}
      />
      <button
        type="button"
        className="ghost"
        onClick={() => input.current?.click()}
        disabled={busy}
      >
        {busy ? "Saving…" : "Supply approved hero"}
      </button>
      {error && <p className="err">{error}</p>}
    </div>
  );
}
