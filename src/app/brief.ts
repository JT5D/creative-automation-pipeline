/**
 * Writes an approved hero into the brief the console is holding.
 *
 * The brief is live editable text, so the change is visible: open Edit source
 * after supplying an asset and the new `approvedHeroPath` line is there. That
 * is deliberate -- the point being demonstrated is that the reuse branch is a
 * real path in a real file, not a mode the UI toggles.
 *
 * JSON round-trips through the parser. YAML is edited as text, because
 * re-serializing it would discard the comments that explain the brief, and
 * those comments are half of what the sample is for.
 */
export function withApprovedHero(brief: string, productId: string, assetPath: string): string {
  const text = brief.trim();

  if (text.startsWith("{")) {
    const doc = JSON.parse(text) as { products?: { id?: string; approvedHeroPath?: string }[] };
    const product = doc.products?.find((p) => p.id === productId);
    if (product) product.approvedHeroPath = assetPath;
    return JSON.stringify(doc, null, 2);
  }

  const existing = new RegExp(
    `(- id:\\s*${productId}\\b[\\s\\S]*?\\n)(\\s*)approvedHeroPath:.*`,
    "m",
  );
  if (existing.test(brief)) {
    return brief.replace(existing, `$1$2approvedHeroPath: ${assetPath}`);
  }
  const idLine = new RegExp(`^(\\s*)- id:\\s*${productId}\\s*$`, "m");
  return brief.replace(
    idLine,
    (line, indent) => `${line}\n${indent}  approvedHeroPath: ${assetPath}`,
  );
}
