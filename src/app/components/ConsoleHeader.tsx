import type { LookOption, ModelOption, ProviderStatus } from "../types.js";
import { ThemeToggle } from "./ThemeToggle.js";

type Props = {
  models: ModelOption[];
  model: string;
  onModel: (id: string) => void;
  looks: LookOption[];
  look: string;
  onLook: (id: string) => void;
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
 * Lifted out of App for the same reason the lifecycle was: App was carrying the
 * layout and the decisions at once and the linter had started refusing it. This
 * is a hundred lines of markup with no state of its own, so moving it takes a
 * hundred lines of branching out of the component that has to be explainable.
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
  looks,
  look,
  onLook,
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
  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark" />
        <div>
          <h1>Creative Automation Pipeline</h1>
          <p>Brief → approved-asset reuse → GenAI for what is missing → channel variants</p>
        </div>
      </div>

      <div className="controls">
        {models.length > 0 && provider?.provider === "google-gemini" && (
          <label className="model">
            <select value={model} onChange={(e) => onModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {/* Unit price only. What makes it unambiguous is the
                      estimate panel underneath, which shows the total AND the
                      arithmetic: "1 x $0.134 per image". A unit price beside
                      "24 creatives" with no visible multiplicand invites the
                      wrong sum, $3.22 for a run that costs $0.134. */}
                  {m.label} - ${m.usdPer2K.toFixed(3)} per image
                </option>
              ))}
            </select>
          </label>
        )}
        {looks.length > 0 && (
          <label
            className="model"
            title="Art direction. The brief's own look is used unless you pick one."
          >
            <select value={look} onChange={(e) => onLook(e.target.value)}>
              <option value="">Look: from brief</option>
              {looks.map((l) => (
                <option key={l.id} value={l.id} title={l.description}>
                  Look: {l.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {provider && (
          <div className="provider">
            <div className={`pill ${provider.configured ? "ok" : "off"}`}>
              <span className="dot" />
              {provider.label}
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
            nothing is worse than an absent one. Last child of the control row
            on purpose, so it takes its own line underneath rather than
            wedging five lines of caveat between two buttons. */}
        {provider?.handoff && <p className="handoff">{provider.handoff}</p>}
      </div>
    </header>
  );
}
