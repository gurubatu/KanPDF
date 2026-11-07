/* 语言诉求 · v2.1 — 阅读器与落地页共用 */

export const LANG_REQUEST_MAIL = "i18n@luanpdf.com";
export const APP_VERSION = "2.6.0";

export function buildLangRequestMessage(language, note, uiLocale) {
  const lines = [
    "[LuanPDF / luanpdf.com — language request]",
    `Desired language: ${language.trim()}`,
    `Current UI: ${uiLocale}`,
    `App version: ${APP_VERSION}`,
  ];
  const n = (note || "").trim();
  if (n) lines.push(`Note: ${n}`);
  return lines.join("\n");
}

export async function submitLangRequest({
  language,
  note,
  uiLocale,
  mailSubject,
  onEmpty,
  onDone,
  persist,
}) {
  const lang = (language || "").trim();
  if (!lang) {
    onEmpty?.();
    return false;
  }
  const body = buildLangRequestMessage(lang, note, uiLocale);
  persist?.({ lang, note: (note || "").trim(), ui: uiLocale, ts: Date.now() });
  try {
    await navigator.clipboard.writeText(body);
  } catch { /* 无剪贴板权限时仍尝试 mailto */ }
  const mailto = `mailto:${LANG_REQUEST_MAIL}?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;
  onDone?.();
  return true;
}
