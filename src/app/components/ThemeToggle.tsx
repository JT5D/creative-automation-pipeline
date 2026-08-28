import { useState } from "react";

/**
 * Dark / light switch.
 *
 * The initial value is read in index.html before first paint, so this only has
 * to reflect and persist it -- reading it here would render one frame of the
 * wrong palette. Everything the switch changes lives in the two token blocks
 * at the top of styles.css; no component knows a colour.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  const apply = (next: "dark" | "light") => {
    setTheme(next);
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("cap.theme", next);
    } catch {
      // Private browsing: the switch still works for this session.
    }
  };

  return (
    <div className="theme">
      {(["dark", "light"] as const).map((t) => (
        <button
          key={t}
          type="button"
          className={theme === t ? "on" : ""}
          aria-pressed={theme === t}
          onClick={() => apply(t)}
        >
          {t === "dark" ? "Dark" : "Light"}
        </button>
      ))}
    </div>
  );
}
