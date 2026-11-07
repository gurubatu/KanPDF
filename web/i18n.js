/* 乱翻书 i18n · v2.0
   全球使用人数最多的 10 种语言 */

export const LOCALE_IDS = ["en", "zh", "hi", "es", "ar", "bn", "fr", "ru", "pt", "ur"];

export const LOCALE_NAMES = {
  en: "English",
  zh: "简体中文",
  hi: "हिन्दी",
  es: "Español",
  ar: "العربية",
  bn: "বাংলা",
  fr: "Français",
  ru: "Русский",
  pt: "Português",
  ur: "اردو",
};

const RTL = new Set(["ar", "ur"]);

const COUNTRY_TO_LOCALE = {
  CN: "zh", TW: "zh", HK: "zh", MO: "zh", SG: "zh",
  IN: "hi",
  ES: "es", MX: "es", AR: "es", CO: "es", CL: "es", PE: "es", VE: "es",
  EC: "es", GT: "es", CU: "es", BO: "es", DO: "es", HN: "es", PY: "es",
  SV: "es", NI: "es", CR: "es", PA: "es", UY: "es", PR: "es",
  FR: "fr", BE: "fr", LU: "fr", MC: "fr", SN: "fr", CI: "fr", CM: "fr",
  SA: "ar", AE: "ar", EG: "ar", IQ: "ar", MA: "ar", DZ: "ar", JO: "ar",
  KW: "ar", QA: "ar", BH: "ar", OM: "ar", LB: "ar", SY: "ar", YE: "ar",
  LY: "ar", TN: "ar", SD: "ar",
  BD: "bn",
  BR: "pt", PT: "pt", AO: "pt", MZ: "pt",
  RU: "ru", BY: "ru", KZ: "ru", KG: "ru", UZ: "ru",
  PK: "ur",
  US: "en", GB: "en", AU: "en", CA: "en", NZ: "en", IE: "en", ZA: "en",
  NG: "en", PH: "en", IN_en: "en",
};

let locale = "en";
let strings = {};
let fallbackStrings = {};
let changeCb = null;

function browserLocale() {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const base = (l || "").split("-")[0].toLowerCase();
    if (LOCALE_IDS.includes(base)) return base;
  }
  return null;
}

async function geoLocale() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: ctrl.signal });
    clearTimeout(timer);
    const m = (await r.text()).match(/^loc=(\w+)/m);
    if (m && COUNTRY_TO_LOCALE[m[1]]) return COUNTRY_TO_LOCALE[m[1]];
  } catch { /* 离线或超时则跳过 */ }
  return null;
}

async function loadStrings(loc) {
  if (loc !== "en") {
    try {
      const fr = await fetch("./locales/en.json");
      if (fr.ok) fallbackStrings = await fr.json();
    } catch { /* en fallback optional */ }
  } else {
    fallbackStrings = {};
  }
  const r = await fetch(`./locales/${loc}.json`);
  if (!r.ok) throw new Error(`locale ${loc}`);
  return r.json();
}

export function t(key, params) {
  let s = strings[key];
  if (s == null) s = fallbackStrings[key];
  if (s == null) s = key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

export function getLocale() {
  return locale;
}

export function onLocaleChange(cb) {
  changeCb = cb;
}

export function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    const attr = el.dataset.i18nAttr;
    const val = t(key);
    if (attr) el.setAttribute(attr, val);
    else el.textContent = val;
  });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.dataset.i18nTitle));
  });
  document.title = t("docTitle");
}

export function fillLangSelect(select, current) {
  if (!select) return;
  select.textContent = "";
  for (const id of LOCALE_IDS) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = LOCALE_NAMES[id] || id;
    if (id === current) opt.selected = true;
    select.appendChild(opt);
  }
  select.value = LOCALE_IDS.includes(current) ? current : "en";
}

export async function setLocale(loc, opts = {}) {
  if (!LOCALE_IDS.includes(loc)) loc = "en";
  try {
    strings = await loadStrings(loc);
  } catch {
    if (loc !== "en") return setLocale("en", opts);
    throw new Error("i18n: en.json missing");
  }
  locale = loc;
  const htmlLang = loc === "zh" ? "zh-CN" : loc === "pt" ? "pt-BR" : loc;
  document.documentElement.lang = htmlLang;
  document.documentElement.dir = RTL.has(loc) ? "rtl" : "ltr";
  applyI18n();
  if (!opts.silent && changeCb) changeCb(loc);
  return loc;
}

/** 优先级：用户已选 > 浏览器语言 > IP 国家 > English */
export async function initI18n(savedLocale) {
  let loc = savedLocale && LOCALE_IDS.includes(savedLocale) ? savedLocale : null;
  if (!loc) loc = browserLocale() || (await geoLocale()) || "en";
  await setLocale(loc, { silent: true });
  return loc;
}
