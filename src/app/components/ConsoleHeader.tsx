import { formatUsd } from "../../pricing.js";
import type { ModelOption, ProviderStatus } from "../types.js";
import { ThemeToggle } from "./ThemeToggle.js";

type Props = {
  models: ModelOption[];
  model: string;
  onModel: (id: string) => void;
  /** The model the Preview tier uses instead of the chosen one. */
  previewModel: ModelOption | null;
  preview: boolean;
  onPreview: (on: boolean) => void;
  provider: ProviderStatus | null;
  busy: boolean;
  batching: boolean;
  batchCount: number;
  running: boolean;
  canRun: boolean;
  onEstimate: () => void;
  onRun: () => void;
};

/**
 * The title and every control that applies to the whole console.
 *
 * A hundred lines of markup with no state of its own, kept out of App so that
 * App reads as a layout rather than a layout and a control panel at once.
 *
 * The order of the row is deliberate and is the one rule the whole console
 * follows: the thing that spends money is last, it is the only element in the
 * accent colour, and the caveat that qualifies it sits underneath on its own
 * line rather than between two buttons.
 */
export function ConsoleHeader({
  models,
  model,
  onModel,
  previewModel,
  preview,
  onPreview,
  provider,
  busy,
  batching,
  batchCount,
  running,
  canRun,
  onEstimate,
  onRun,
}: Props) {
  /*
   * In Preview the tier picks the model, so the picker shows the model that
   * will actually run and stops accepting a choice.
   *
   * Left live, it advertised "Gemini 3 Pro Image - $0.134 per image" while the
   * estimate directly below it quoted $0.0336, because --preview overrides the
   * selection. Two prices for one run, and the wrong one was the larger and
   * more prominent.
   */
  const shown = preview && previewModel ? [previewModel] : models;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark" />
        <div>
          <h1>Creative Automation Pipeline</h1>
          <p>
            One brief becomes every format and every market. Approved assets are reused; only what
            is missing is generated.
          </p>
        </div>
      </div>

      <div className="controls">
        {models.length > 0 && provider?.provider === "google-gemini" && (
          /*
           * In Preview the tier picks the model, so the picker shows the model
           * that will actually run and stops accepting a choice.
           *
           * Left live, it advertised "Gemini 3 Pro Image - $0.134 per image"
           * while the estimate directly below it quoted $0.0336, because
           * `--preview` overrides the selection. Two prices for one run, and
           * the wrong one was the larger and more prominent.
           */
          <label className="model">
            <select
              value={shown[0]?.id ?? model}
              disabled={preview}
              onChange={(e) => onModel(e.target.value)}
              title={
                preview
                  ? "The Preview tier runs on the cheapest model that can serve 1K, whichever model is selected. Switch to Ship to choose."
                  : undefined
              }
            >
              {shown.map((m) => (
                <option key={m.id} value={m.id}>
                  {/* Unit price only. What makes it unambiguous is the estimate
                      panel underneath, which shows the total AND the
                      arithmetic: "1 x $0.134 per image". A unit price beside
                      "24 creatives" with no visible multiplicand invites the
                      wrong sum, $3.22 for a run that costs $0.134. */}
                  {m.label} - {formatUsd(m.usdPer2K)} per image
                </option>
              ))}
            </select>
          </label>
        )}
        {provider && (
          <div className="provider">
            {/* The model picker beside this already names the model, so the
                pill names the provider. Keyless it carries the full sentence,
                because "no model will be called" is the whole point of it. */}
            <div className={`pill ${provider.configured ? "ok" : "off"}`}>
              <span className="dot" />
              {provider.configured && models.length > 0 ? provider.name : provider.label}
            </div>
          </div>
        )}
        {/* Gold is money in this console, so the tier that spends less is
            not gold. It reads as a mode, because that is what it is. */}
        <div
          className="theme tier"
          title="Preview generates the hero at 1K on the cheapest model that can serve it. Half the price, and not the deliverable: 9:16 needs 1080x1920 out of a square hero, so a 1K source goes soft."
        >
          <button
            type="button"
            className={preview ? "on" : ""}
            aria-pressed={preview}
            onClick={() => onPreview(true)}
          >
            Preview
          </button>
          <button
            type="button"
            className={preview ? "" : "on"}
            aria-pressed={!preview}
            onClick={() => onPreview(false)}
          >
            Ship
          </button>
        </div>
        <ThemeToggle />
        <button type="button" className="ghost" onClick={onEstimate} disabled={busy}>
          Estimate
        </button>
        <button type="button" className="run" onClick={onRun} disabled={busy || !canRun}>
          {busy && running ? "Running…" : batching ? `Run ${batchCount} campaigns` : "Run campaign"}
        </button>
        {/* The hand-off, as a sentence. Not a Firefly button: this repo has no
            entitlement to run that adapter, and a control that quietly does
            nothing is worse than an absent one. It reads as a footnote to the
            provider pill rather than a grey wall under the primary action,
            because no product leads with its disclaimer. */}
        {provider?.handoff && (
          <details className="handoff">
            <summary>Firefly adapter: written, never executed</summary>
            <p>{provider.handoff}</p>
          </details>
        )}
      </div>
    </header>
  );
}
