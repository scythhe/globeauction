import { LANGUAGES, useTranslation } from "../i18n/index.tsx";

export function LanguageSwitcher() {
  const { lang, setLang } = useTranslation();

  return (
    <div className="flex items-center gap-0.5 rounded border border-border p-0.5 text-xs font-semibold">
      {LANGUAGES.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          className={`rounded px-1.5 py-1 transition ${
            lang === code ? "bg-brand text-white" : "text-ink-muted hover:text-ink"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
