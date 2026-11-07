/* 乱翻书 · 阅读器本体（浏览器 + Tauri 双环境）
   Gao Hongyan · for Jojo */

// legacy 构建：主构建依赖过新的 JS 特性，WebView2/旧 Chromium 不支持
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import {
  initI18n, setLocale, t, getLocale, fillLangSelect, applyI18n, onLocaleChange,
} from "./i18n.js";
import { submitLangRequest } from "./lang-request.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const PDF_OPTIONS = {
  cMapUrl: "./vendor/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "./vendor/pdfjs/standard_fonts/",
  /* JPEG2000 / ICC 色彩 / JBIG2 解码；缺此目录时彩色图与色块会丢失 */
  wasmUrl: "./vendor/pdfjs/wasm/",
};

const MAX_BYTES = 512 * 1024 * 1024;
/** ≤ 此大小：asset 协议 fetch 读入；更大文件走 Rust 分块 IPC（WebView2 的
 * 自定义协议需整体打包响应体，传大文件不稳定，不能用于大 PDF） */
const INLINE_OPEN_MAX = 64 * 1024 * 1024;
/** 分块 IPC 每块大小（Rust 侧上限 32MB） */
const PDF_CHUNK_SIZE = 16 * 1024 * 1024;
const THUMB_LAZY_MAX_BYTES = 80 * 1024 * 1024;
const THUMB_MAX_W = 140;
const THUMB_JPEG_Q = 0.72;
const RECENT_GRID_LIMIT = 12;
const CACHE_LIMIT = 7;
const INDICATOR_HIDE_MS = 2500;
const SUPPORT_URL = "https://buymeacoffee.com/luanpdf";
const RECENT_LIMIT = 20;

const IS_TAURI = !!window.__TAURI__;

async function resolveAppVersion() {
  if (!IS_TAURI) return null;
  try {
    if (typeof window.__TAURI__.app?.getVersion === "function") {
      return await window.__TAURI__.app.getVersion();
    }
  } catch (e) {
    console.warn("getVersion failed", e);
  }
  return null;
}

async function showAppVersion() {
  const el = $("appVersion");
  if (!el) return;
  const v = await resolveAppVersion();
  if (!v) return;
  el.textContent = `v${v}`;
  el.hidden = false;
  el.title = `luanpdf ${v}`;
}

/* 动画时长以 CSS 变量 --turn-ms 为准，JS 与 CSS 单点同步 */
function turnDurationMs() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--turn-ms");
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 300;
}

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const topbar = $("topbar");
const stage = $("stage");
const pageHost = $("pageHost");
const startScreen = $("startScreen");
const pageIndicator = $("pageIndicator");
const outlinePanel = $("outlinePanel");
const outlineList = $("outlineList");
const bookmarkPanel = $("bookmarkPanel");
const bookmarkList = $("bookmarkList");
const jumpBox = $("jumpBox");
const jumpInput = $("jumpInput");
const jumpTotal = $("jumpTotal");
const toast = $("toast");
const dropMask = $("dropMask");
const fileInput = $("fileInput");
const docTitle = $("docTitle");
let launchReady = false;
const pendingLaunchPaths = [];

function queueLaunchPath(path) {
  if (!path) return;
  if (launchReady) void openPath(path);
  else pendingLaunchPaths.push(path);
}

async function flushPendingLaunchPaths() {
  launchReady = true;
  while (pendingLaunchPaths.length) {
    const path = pendingLaunchPaths.shift();
    await openPath(path);
  }
}
const recentList = $("recentList");
const langSelect = $("langSelect");
const langRequestBox = $("langRequestBox");
const langRequestInput = $("langRequestInput");
const langRequestNote = $("langRequestNote");
const shortcutHints = $("shortcutHints");
const edgeHintLeft = $("edgeHintLeft");
const edgeHintRight = $("edgeHintRight");
const hintOverlay = $("hintOverlay");

const EDGE_HINT_PX = 56;
/** 左右快捷键轨（收窄约半宽，正文可贴到细缝） */
const SIDE_RAIL = 58;
/** 书页与屏幕边缘的细缝 */
const PAGE_EDGE_SEAM = 3;
/** 边缘提示无鼠标扫过则自动收起 */
const HINT_IDLE_MS = 5000;
let hintIdleTimer = 0;
const TURN_EDGE = 0.1; /* 屏幕左右各 10% 为翻页区，中间区域点击走 U/M/L */
let hintOverlayOpen = false;
const thumbQueue = [];
let thumbQueueBusy = false;

/* ---------- 持久化存储 ----------
   Tauri：app_data_dir()/data.json（Windows 自动从 %AppData%\KanPDF 迁移）
   浏览器：localStorage["kanpdf:store"]
   结构：{ progress: { "文件名|字节数": {page,zoom,ts,bookmarks[]} },
          recents: [{path,name,ts}], settings: {turnStyle} } */
const store = {
  data: { progress: {}, recents: [], settings: {} },
  _timer: null,
  async init() {
    try {
      const raw = IS_TAURI
        ? await window.__TAURI__.core.invoke("load_data")
        : localStorage.getItem("kanpdf:store");
      if (raw) this.data = Object.assign(this.data, JSON.parse(raw));
    } catch (e) {
      console.error("store load failed", e);
    }
    if (!this.data.progress || typeof this.data.progress !== "object") {
      this.data.progress = {};
    }
    if (!Array.isArray(this.data.recents)) this.data.recents = [];
    if (!this.data.settings || typeof this.data.settings !== "object") {
      this.data.settings = {};
    }
    this.migrate();
  },
  /* 从旧版 localStorage 键迁移（一次性） */
  migrate() {
    if (this.data.migrated) return;
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("kanpdf:progress:")) {
          const id = k.slice("kanpdf:progress:".length);
          if (!this.data.progress[id]) {
            this.data.progress[id] = JSON.parse(localStorage.getItem(k));
          }
        }
      }
      const rec = localStorage.getItem("kanpdf:recents");
      if (rec && (!this.data.recents || this.data.recents.length === 0)) {
        this.data.recents = JSON.parse(rec);
      }
    } catch { /* 旧数据损坏则放弃迁移 */ }
    this.data.migrated = true;
    this.save();
  },
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  },
  async flush() {
    clearTimeout(this._timer);
    const raw = JSON.stringify(this.data);
    try {
      if (IS_TAURI) {
        await window.__TAURI__.core.invoke("save_data", { content: raw });
      } else {
        localStorage.setItem("kanpdf:store", raw);
      }
    } catch (e) {
      console.error("store save failed", e);
    }
  },
};

window.addEventListener("pagehide", () => store.flush());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") store.flush();
});

/* ---------- 状态 ---------- */
let pdfDoc = null;
let docId = null; // "文件名|字节数"
let currentPage = 1;
let userZoom = 1;
let baseScale = 1;
let animating = false;
let pendingTurn = 0;
let renderCache = new Map();
let renderSeq = 0;
let indicatorTimer = null;
let resizeTimer = null;
let rotation = 0; // 0 | 90 | 270（竖屏翻转阅读）
let partZoom = null; // null | 'top' | 'middle' | 'bottom'（单页普通模式：局部放大）
let partZoomBaseCanvas = null; // 进入局部放大前保留的整页 canvas，退出时还原
let pdfPreSpread = false; // PDF 每页已是扫描双页（再开对开会变成四页横排）

/* ---------- 扫描双页侦测 ----------
   部分扫描 PDF 一页里已是左右两页。优先看画幅比例：多页都明显偏宽时
   直接认定，不再强依赖中缝亮带（彩色跨页百科常没有清晰装订缝）。 */
const PRE_SPREAD_MIN_RATIO = 1.20;
const PRE_SPREAD_STRONG_RATIO = 1.32;
const PRE_SPREAD_RATIO_ONLY = 1.36; /* 仅凭比例即可投票的阈值 */

async function analyzePagePreSpread(page) {
  const vp = page.getViewport({ scale: 1 });
  const ratio = vp.width / vp.height;
  if (ratio < PRE_SPREAD_MIN_RATIO) {
    return { preSpread: false, strong: false, ratioOnly: false, ratio };
  }

  const sampleW = Math.min(320, Math.max(180, Math.floor(vp.width)));
  const svp = page.getViewport({ scale: sampleW / vp.width });
  const cw = Math.floor(svp.width);
  const ch = Math.floor(svp.height);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport: svp }).promise;

  const { data } = ctx.getImageData(0, 0, cw, ch);
  const colInk = new Float32Array(cw);
  for (let x = 0; x < cw; x++) {
    let sum = 0;
    for (let y = 0; y < ch; y++) {
      const i = (y * cw + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += (255 - lum) / 255;
    }
    colInk[x] = sum / ch;
  }

  const band = Math.max(3, Math.floor(cw * 0.07));
  const cx = Math.floor(cw / 2);
  let minInk = Infinity;
  for (let x = cx - band; x <= cx + band; x++) {
    if (x >= 0 && x < cw && colInk[x] < minInk) minInk = colInk[x];
  }

  const sideW = Math.max(2, Math.floor(cw * 0.12));
  const leftStart = Math.floor(cw * 0.08);
  const rightStart = Math.floor(cw * 0.8);
  let leftInk = 0;
  let rightInk = 0;
  for (let i = 0; i < sideW; i++) {
    leftInk += colInk[leftStart + i];
    rightInk += colInk[rightStart + i];
  }
  leftInk /= sideW;
  rightInk /= sideW;
  const contentInk = (leftInk + rightInk) / 2;
  const gutterContrast = contentInk - minInk;

  const mid = Math.floor(cw / 2);
  let leftHalf = 0;
  let rightHalf = 0;
  for (let x = 0; x < mid; x++) leftHalf += colInk[x];
  for (let x = mid; x < cw; x++) rightHalf += colInk[x];
  leftHalf /= mid;
  rightHalf /= cw - mid;
  const symDiff = Math.abs(leftHalf - rightHalf) / Math.max(contentInk, 0.02);

  const ratioOnly = ratio >= PRE_SPREAD_RATIO_ONLY;
  const strong =
    ratio >= PRE_SPREAD_STRONG_RATIO &&
    (ratioOnly || (gutterContrast >= 0.02 && symDiff < 0.45));
  const preSpread =
    ratioOnly ||
    (ratio >= PRE_SPREAD_MIN_RATIO &&
      gutterContrast >= 0.014 &&
      symDiff < 0.5);

  return { preSpread, strong, ratioOnly, ratio, gutterContrast, symDiff };
}

function pagesToSampleForPreSpread(numPages) {
  if (numPages <= 1) return [1];
  const picked = [];
  const candidates = [
    2, 3, 4, 5,
    Math.max(2, Math.ceil(numPages * 0.25)),
    Math.max(2, Math.ceil(numPages * 0.5)),
    Math.max(2, Math.ceil(numPages * 0.75)),
  ];
  for (const p of candidates) {
    if (p >= 1 && p <= numPages && !picked.includes(p)) picked.push(p);
  }
  return picked.slice(0, 6);
}

async function detectPreSpread(doc) {
  const pages = pagesToSampleForPreSpread(doc.numPages);
  let votes = 0;
  let strong = 0;
  let ratioOnlyVotes = 0;
  let ratios = [];
  for (const n of pages) {
    try {
      const page = await doc.getPage(n);
      const r = await analyzePagePreSpread(page);
      ratios.push(r.ratio);
      if (r.preSpread) votes++;
      if (r.strong) strong++;
      if (r.ratioOnly) ratioOnlyVotes++;
    } catch { /* 忽略采样失败 */ }
  }
  if (ratioOnlyVotes >= 2) return true;
  if (pages.length >= 3 && ratioOnlyVotes >= Math.ceil(pages.length * 0.6)) return true;
  if (pages.length === 1 && ratioOnlyVotes === 1) return true;
  if (strong >= 1 && votes >= 1) return true;
  if (votes >= 2) return true;
  if (ratios.length >= 2) {
    const sorted = [...ratios].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    if (mid >= PRE_SPREAD_RATIO_ONLY) return true;
  }
  return false;
}

/* ---------- 双页对开 ----------
   封面（第 1 页）单独显示，其后 2-3、4-5 成对；
   竖屏翻转与双页互斥（竖屏就是为了放大单页）。
   扫描双页 PDF 不再启用对开（避免一页变四页）。 */
function spreadMode() {
  return !!store.data.settings.spread;
}
function spreadActive() {
  return spreadMode() && rotation === 0 && !pdfPreSpread;
}
/* 页码 → 所属对开的起始页 */
function spreadStart(p) {
  if (!spreadActive()) return p;
  return p <= 1 ? 1 : (p % 2 === 0 ? p : p - 1);
}
/* 当前视图包含的页码列表 */
function visiblePages() {
  if (!pdfDoc) return [];
  if (!spreadActive()) return [currentPage];
  const s = spreadStart(currentPage);
  return s > 1 && s + 1 <= pdfDoc.numPages ? [s, s + 1] : [s];
}

function docState() {
  if (!docId) return null;
  let s = store.data.progress[docId];
  if (!s) {
    s = {};
    store.data.progress[docId] = s;
  }
  return s;
}

/* ---------- 小工具 ---------- */
function showToast(msg, ms = 2600) {
  toast.textContent = msg;
  toast.classList.remove("fade-out");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("fade-out"), ms);
}

function showIndicator() {
  if (!pdfDoc) return;
  const vis = visiblePages();
  const label = vis.length === 2 ? `${vis[0]}-${vis[1]}` : `${vis[0]}`;
  pageIndicator.textContent = `${label} / ${pdfDoc.numPages}`;
  pageIndicator.classList.remove("fade-out");
  clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(
    () => pageIndicator.classList.add("fade-out"),
    INDICATOR_HIDE_MS
  );
}

function persistLangRequest(entry) {
  if (!store.data.langRequests) store.data.langRequests = [];
  store.data.langRequests.push(entry);
  if (store.data.langRequests.length > 50) {
    store.data.langRequests.splice(0, store.data.langRequests.length - 50);
  }
  store.save();
}

function openLangRequestBox() {
  langRequestInput.value = "";
  langRequestNote.value = "";
  langRequestBox.classList.remove("closed");
  langRequestInput.focus();
}

function closeLangRequestBox() {
  langRequestBox.classList.add("closed");
}

async function sendLangRequest() {
  await submitLangRequest({
    language: langRequestInput.value,
    note: langRequestNote.value,
    uiLocale: getLocale(),
    mailSubject: t("langRequestMailSubject", { lang: langRequestInput.value.trim() }),
    onEmpty: () => showToast(t("langRequestEmpty")),
    onDone: () => {
      closeLangRequestBox();
      showToast(t("langRequestSent"), 3400);
    },
    persist: persistLangRequest,
  });
}

async function openSupportUrl() {
  if (IS_TAURI && window.__TAURI__?.opener?.openUrl) {
    try {
      await window.__TAURI__.opener.openUrl(SUPPORT_URL);
      return;
    } catch (e) {
      console.error("open support url failed", e);
    }
  }
  window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
}

function setupSupport() {
  $("btnSupport").addEventListener("click", () => void openSupportUrl());
  $("btnSupportStart").addEventListener("click", () => void openSupportUrl());
}

function setupLangRequest() {
  $("btnLangRequest").addEventListener("click", openLangRequestBox);
  $("btnLangRequestStart").addEventListener("click", openLangRequestBox);
  $("btnLangRequestSubmit").addEventListener("click", () => void sendLangRequest());
  $("btnLangRequestClose").addEventListener("click", closeLangRequestBox);
  langRequestBox.addEventListener("click", (e) => {
    if (e.target === langRequestBox) closeLangRequestBox();
  });
}

function updateZoomLabel() {
  $("btnZoomReset").textContent = t("zoomLabel", { pct: Math.round(userZoom * 100) });
}

function applyRotateLabel() {
  $("btnRotate").textContent =
    rotation === 0 ? t("portrait") : rotation === 90 ? t("portraitRight") : t("portraitLeft");
}

async function refreshMonitorButton() {
  const btn = $("btnMonitor");
  if (!btn) return;
  if (!IS_TAURI) {
    btn.hidden = true;
    return;
  }
  try {
    const { monitors, primary, current } = await fetchMonitors();
    const secondary = pickSecondaryMonitor(monitors, primary);
    if (!secondary) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.disabled = false;
    const onPrimary = isSameMonitor(current, primary);
    btn.textContent = onPrimary ? t("monitorGoSecondary") : t("monitorGoPrimary");
    btn.title = t("btnMonitorTitle");
  } catch (e) {
    console.warn("refreshMonitorButton", e);
    btn.hidden = true;
  }
}

function refreshDynamicLabels() {
  applyTurnStyleLabel();
  applySpreadLabel();
  applyRotateLabel();
  updateZoomLabel();
  applyI18n();
  void refreshMonitorButton();
}

async function changeLocale(loc) {
  await setLocale(loc);
  store.data.settings.locale = loc;
  store.save();
  syncLangSelects(loc);
  refreshDynamicLabels();
  renderBookmarkPanel();
  renderRecents();
  if (pdfDoc) openJumpBox(false);
}

function syncLangSelects(loc) {
  if (langSelect) fillLangSelect(langSelect, loc);
}

function setupLangSelects() {
  if (!langSelect) return;
  fillLangSelect(langSelect, getLocale());
  langSelect.addEventListener("change", (e) => changeLocale(e.target.value));
}

function saveProgress() {
  if (!docId) return;
  const s = docState();
  s.page = currentPage;
  s.zoom = userZoom;
  s.ts = Date.now();
  store.save();
}

/* ---------- 书签 ---------- */
function getBookmarks() {
  const s = docState();
  if (!s) return [];
  if (!s.bookmarks) s.bookmarks = [];
  return s.bookmarks;
}

function isBookmarked(p) {
  return !!docId && getBookmarks().includes(p);
}

function toggleBookmark() {
  if (!pdfDoc) return;
  const bm = getBookmarks();
  const i = bm.indexOf(currentPage);
  if (i >= 0) {
    bm.splice(i, 1);
    showToast(t("bookmarkRemoved", { page: currentPage }));
  } else {
    bm.push(currentPage);
    bm.sort((a, b) => a - b);
    showToast(t("bookmarkAdded", { page: currentPage }));
  }
  store.save();
  updateRibbon();
  renderBookmarkPanel();
}

function updateRibbon() {
  for (const ex of pageHost.querySelectorAll(".bookmark-ribbon")) ex.remove();
  if (!pdfDoc || partZoom) return;
  const vis = visiblePages();
  for (let i = 0; i < vis.length; i++) {
    if (!isBookmarked(vis[i])) continue;
    const r = document.createElement("div");
    r.className = "bookmark-ribbon";
    if (vis.length === 2) {
      /* 左半页丝带贴左半的右上角，右半页贴整体右上角 */
      r.style.right = i === 0 ? "53.5%" : "3.5%";
    }
    pageHost.appendChild(r);
  }
}

function renderBookmarkPanel() {
  bookmarkList.innerHTML = "";
  if (!pdfDoc) return;
  const bm = getBookmarks();
  if (bm.length === 0) {
    bookmarkList.innerHTML =
      `<div class="outline-empty">${t("noBookmarks")}</div>`;
    return;
  }
  for (const p of bm) {
    const row = document.createElement("div");
    row.className = "bm-row";
    const btn = document.createElement("button");
    btn.className = "outline-item";
    btn.textContent = t("pageLabel", { n: p });
    btn.addEventListener("click", () => {
      bookmarkPanel.classList.add("closed");
      showPage(p);
    });
    const del = document.createElement("button");
    del.className = "bm-del";
    del.textContent = "✕";
    del.title = t("removeBookmarkTitle");
    del.addEventListener("click", () => {
      const b = getBookmarks();
      const i = b.indexOf(p);
      if (i >= 0) b.splice(i, 1);
      store.save();
      renderBookmarkPanel();
      updateRibbon();
    });
    row.append(btn, del);
    bookmarkList.appendChild(row);
  }
}

/* ---------- 渲染 ---------- */
async function computeBaseScale() {
  const page = await pdfDoc.getPage(currentPage);
  const vp = page.getViewport({ scale: 1 });
  /* 上下/左右只留细缝；侧轨收窄后正文明显变大 */
  const padY = PAGE_EDGE_SEAM * 2;
  const padX = SIDE_RAIL * 2 + PAGE_EDGE_SEAM * 2;
  const availH = Math.max(120, stage.clientHeight - padY);
  const availW = Math.max(120, stage.clientWidth - padX);
  /* 双页模式按两页宽度适配（封面单独页也用同一比例，保持视觉一致） */
  const cols = spreadActive() && pdfDoc.numPages > 1 ? 2 : 1;
  baseScale = Math.min(availH / vp.height, availW / (vp.width * cols));
}

async function renderPage(num) {
  const scale = baseScale * userZoom;
  const cached = renderCache.get(num);
  if (cached && Math.abs(cached.scale - scale) < 1e-6) {
    renderCache.delete(num);
    renderCache.set(num, cached);
    return cached.canvas;
  }

  const seq = renderSeq;
  const page = await pdfDoc.getPage(num);
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: scale * dpr });

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
  canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
  canvas.className = "page-layer";

  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp })
    .promise;

  if (seq !== renderSeq) return null;
  renderCache.set(num, { canvas, scale });
  while (renderCache.size > CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    renderCache.delete(oldest);
  }
  return canvas;
}

/* 视图渲染：单页直接用 renderPage，双页把左右两页合成到一张 canvas，
   这样平移/卷页动画代码无需感知双页的存在 */
async function renderView(p) {
  if (!spreadActive()) return renderPage(p);
  const s = spreadStart(p);
  if (s === 1 || s + 1 > pdfDoc.numPages) return renderPage(s);

  const key = `s${s}`;
  const scale = baseScale * userZoom;
  const cached = renderCache.get(key);
  if (cached && Math.abs(cached.scale - scale) < 1e-6) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cached.canvas;
  }

  const seq = renderSeq;
  const left = await renderPage(s);
  const right = await renderPage(s + 1);
  if (!left || !right || seq !== renderSeq) return null;

  const canvas = document.createElement("canvas");
  canvas.width = left.width + right.width;
  canvas.height = Math.max(left.height, right.height);
  canvas.style.width = `${parseFloat(left.style.width) + parseFloat(right.style.width)}px`;
  canvas.style.height = `${Math.max(parseFloat(left.style.height), parseFloat(right.style.height))}px`;
  canvas.className = "page-layer";

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(left, 0, 0);
  ctx.drawImage(right, left.width, 0);

  /* 中缝阴影：书脊感 */
  const gw = Math.max(8, canvas.width * 0.012);
  const gl = ctx.createLinearGradient(left.width - gw, 0, left.width, 0);
  gl.addColorStop(0, "rgba(60,45,25,0)");
  gl.addColorStop(1, "rgba(60,45,25,0.18)");
  ctx.fillStyle = gl;
  ctx.fillRect(left.width - gw, 0, gw, canvas.height);
  const gr = ctx.createLinearGradient(left.width, 0, left.width + gw, 0);
  gr.addColorStop(0, "rgba(60,45,25,0.18)");
  gr.addColorStop(1, "rgba(60,45,25,0)");
  ctx.fillStyle = gr;
  ctx.fillRect(left.width, 0, gw, canvas.height);

  renderCache.set(key, { canvas, scale });
  while (renderCache.size > CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    renderCache.delete(oldest);
  }
  return canvas;
}

function sizeHostTo(canvas) {
  pageHost.style.width = canvas.style.width;
  pageHost.style.height = canvas.style.height;
}

function focusReader() {
  if (stage && pdfDoc) stage.focus({ preventScroll: true });
}

function readerNavFromKey(e) {
  const k = e.key;
  const c = e.code;
  if (k === "Home" || c === "Home") return "home";
  if (k === "End" || c === "End") return "end";
  if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown"
      || c === "ArrowRight" || c === "ArrowDown" || c === "PageDown") return 1;
  if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp"
      || c === "ArrowLeft" || c === "ArrowUp" || c === "PageUp") return -1;
  return 0;
}

function handleReaderNavKey(e) {
  if (!pdfDoc) return;
  if (e.target === jumpInput || e.target === langRequestInput || e.target === langRequestNote) {
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const nav = readerNavFromKey(e);
  if (!nav) return;
  e.preventDefault();
  e.stopPropagation();
  if (nav === "home") void showPage(1);
  else if (nav === "end") void showPage(pdfDoc.numPages);
  else turnPage(nav);
}

/* ---------- 局部放大（单页 · 普通横屏） ----------
   U / M / L 各取约 35% 页高（中区居中），交界处有重叠过渡，
   避免信息正好卡在 33% 分界线上被裁掉。 */
const PART_ZONE_FRAC = 0.35;
/** U/M/L：高于屏幕密度渲染再缩小，文字更利落（1.5 ≈ 再清晰一档） */
const PART_RENDER_BOOST = 1.5;

function partZoneSrcY(pageH, zone) {
  const band = pageH * PART_ZONE_FRAC;
  if (zone === "top") return 0;
  if (zone === "bottom") return Math.max(0, pageH - band);
  return Math.max(0, (pageH - band) / 2);
}

function partStageSize() {
  const pad = PAGE_EDGE_SEAM * 2;
  return { availW: stage.clientWidth - pad, availH: stage.clientHeight - pad };
}

async function renderPartSection(num, zone) {
  const { availW, availH } = partStageSize();
  const page = await pdfDoc.getPage(num);
  const vp1 = page.getViewport({ scale: 1 });
  const basePdfScale = baseScale * userZoom;
  const w = vp1.width * basePdfScale;
  const h = vp1.height * basePdfScale;
  const bandH = h * PART_ZONE_FRAC;
  const fit = Math.min(availW / w, availH / bandH);
  const pdfScale = basePdfScale * fit;
  const outH = bandH * fit;

  const cacheKey = `pz${num}-${zone}-${PART_ZONE_FRAC}-${pdfScale.toFixed(5)}-b${PART_RENDER_BOOST}`;
  const cached = renderCache.get(cacheKey);
  if (cached && Math.abs(cached.scale - pdfScale) < 1e-6) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached.canvas;
  }

  const seq = renderSeq;
  const dpr = window.devicePixelRatio || 1;
  const renderScale = pdfScale * dpr * PART_RENDER_BOOST;
  const vp = page.getViewport({ scale: renderScale });
  const srcBandH = vp.height * PART_ZONE_FRAC;
  const srcY = partZoneSrcY(vp.height, zone);

  const full = document.createElement("canvas");
  full.width = Math.floor(vp.width);
  full.height = Math.floor(vp.height);
  await page.render({
    canvasContext: full.getContext("2d"),
    viewport: vp,
  }).promise;
  if (seq !== renderSeq) return null;

  const out = document.createElement("canvas");
  out.width = Math.floor(availW * dpr);
  out.height = Math.floor(outH * dpr);
  out.style.width = `${Math.floor(availW)}px`;
  out.style.height = `${Math.floor(outH)}px`;
  out.className = "page-layer";
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(
    full, 0, srcY, vp.width, srcBandH, 0, 0, out.width, out.height
  );

  renderCache.set(cacheKey, { canvas: out, scale: pdfScale });
  while (renderCache.size > CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    renderCache.delete(oldest);
  }
  return out;
}

function cleanupPartZoomDom() {
  const wrap = pageHost.querySelector(".part-zoom-wrap");
  if (wrap) wrap.remove();
  pageHost.classList.remove("part-top", "part-middle", "part-bottom");
  pageHost.style.overflow = "";
  pageHost.style.height = "";
  pageHost.style.width = "";
}

function mountPartZoom(canvas) {
  const { availW, availH } = partStageSize();
  pageHost.classList.add(`part-${partZoom}`);
  pageHost.style.width = `${availW}px`;
  pageHost.style.height = `${availH}px`;
  pageHost.style.overflow = "hidden";

  const wrap = document.createElement("div");
  wrap.className = "part-zoom-wrap";
  wrap.style.height = canvas.style.height;
  canvas.className = "page-layer base";
  canvas.style.position = "relative";
  canvas.style.transform = "";
  canvas.style.transformOrigin = "";
  wrap.appendChild(canvas);
  pageHost.innerHTML = "";
  pageHost.appendChild(wrap);
}

async function clearPartZoom(silent) {
  if (!partZoom) return;
  partZoom = null;
  await applyPartZoomView();
  if (!silent) showToast(t("restoredFullPage"));
}

const PART_ZOOM_KEY = { top: "partTop", middle: "partMiddle", bottom: "partBottom" };

async function togglePartZoom(zone) {
  if (!pdfDoc || animating) return;
  if (rotation !== 0) {
    showToast(t("partZoomLandscapeOnly"));
    return;
  }
  if (spreadActive()) {
    showToast(t("partZoomNoSpread"));
    return;
  }
  partZoom = partZoom === zone ? null : zone;
  await applyPartZoomView();
  if (partZoom) {
    const key = zone === "top" ? "U" : zone === "middle" ? "M" : "L";
    showToast(
      t("partZoomToast", {
        zone: t(PART_ZOOM_KEY[zone]),
        key,
      })
    );
  } else {
    showToast(t("restoredFullPage"));
  }
}

async function applyPartZoomView() {
  cleanupPartZoomDom();

  if (!partZoom) {
    let canvas = partZoomBaseCanvas;
    partZoomBaseCanvas = null;
    if (!canvas) canvas = pageHost.querySelector(".page-layer.base");
    if (!canvas) {
      canvas = await renderView(currentPage);
      if (!canvas) return;
    }
    pageHost.innerHTML = "";
    canvas.className = "page-layer base";
    canvas.style.transform = "";
    canvas.style.transformOrigin = "";
    canvas.style.position = "";
    sizeHostTo(canvas);
    pageHost.appendChild(canvas);
    updateRibbon();
    return;
  }

  const base = pageHost.querySelector(".page-layer.base");
  if (base && !partZoomBaseCanvas) partZoomBaseCanvas = base;

  const partCanvas = await renderPartSection(currentPage, partZoom);
  if (!partCanvas || !partZoom) return;
  mountPartZoom(partCanvas);
  updateRibbon();
}

function pageClickZone(fraction) {
  /* 点击分区与 35% 视窗对齐：上 0–35%、下 65–100%、中间其余 */
  if (fraction < PART_ZONE_FRAC) return "top";
  if (fraction > 1 - PART_ZONE_FRAC) return "bottom";
  return "middle";
}

function clickOnPage(e) {
  const target =
    pageHost.querySelector(".part-zoom-wrap") ||
    pageHost.querySelector(".page-layer.base");
  if (!target) return false;
  const r = target.getBoundingClientRect();
  return (
    e.clientX >= r.left && e.clientX <= r.right &&
    e.clientY >= r.top && e.clientY <= r.bottom
  );
}

function pageClickYFraction(e) {
  const target =
    pageHost.querySelector(".part-zoom-wrap") ||
    pageHost.querySelector(".page-layer.base");
  const r = target.getBoundingClientRect();
  return (e.clientY - r.top) / r.height;
}

function prerenderNeighbors() {
  const targets = spreadActive()
    ? [currentPage + 2, currentPage + 3, currentPage - 1, currentPage - 2]
    : [currentPage + 1, currentPage - 1, currentPage + 2, currentPage - 2];
  setTimeout(async () => {
    for (const n of targets) {
      if (!pdfDoc || n < 1 || n > pdfDoc.numPages) continue;
      try {
        await renderPage(n);
        if (spreadActive()) await renderView(n);
      } catch { /* 忽略预渲染失败 */ }
    }
  }, 60);
}

/* 直接显示（无动画：打开、跳转、缩放、旋转） */
async function showPage(num) {
  partZoom = null;
  partZoomBaseCanvas = null;
  currentPage = spreadStart(num);
  const canvas = await renderView(currentPage);
  if (!canvas) return;
  pageHost.innerHTML = "";
  canvas.className = "page-layer base";
  sizeHostTo(canvas);
  pageHost.appendChild(canvas);
  showIndicator();
  saveProgress();
  prerenderNeighbors();
  focusReader();
}

/* ---------- 翻页（平移 / 卷页两种动画） ---------- */
function turnStyle() {
  return store.data.settings.turnStyle === "curl" ? "curl" : "slide";
}

function finishTurn(newCanvas) {
  animating = false;
  prerenderNeighbors();
  if (pendingTurn) {
    const d = pendingTurn;
    pendingTurn = 0;
    turnPage(d);
  }
}

async function turnPage(dir) {
  if (!pdfDoc) return;
  if (animating) { pendingTurn = dir; return; }
  partZoom = null;
  partZoomBaseCanvas = null;
  let target;
  if (spreadActive()) {
    const s = spreadStart(currentPage);
    target = dir > 0 ? (s === 1 ? 2 : s + 2) : (s === 2 ? 1 : s - 2);
  } else {
    target = currentPage + dir;
  }
  if (target < 1 || target > pdfDoc.numPages) {
    showIndicator();
    return;
  }

  animating = true;
  const newCanvas = await renderView(target);
  if (!newCanvas) { animating = false; return; }

  const oldCanvas = pageHost.querySelector(".page-layer.base");
  currentPage = target;
  showIndicator();
  saveProgress();

  if (turnStyle() === "curl" && oldCanvas) {
    await animateCurl(dir, oldCanvas, newCanvas);
    finishTurn(newCanvas);
    return;
  }

  /* 平移滑出（保底方案） */
  newCanvas.className = "page-layer";
  newCanvas.classList.add(dir > 0 ? "turn-enter-next" : "turn-enter-prev");
  sizeHostTo(newCanvas);
  pageHost.appendChild(newCanvas);
  void newCanvas.offsetWidth;

  newCanvas.classList.add("turn-active", "turn-to-center");
  if (oldCanvas) {
    oldCanvas.classList.remove("base");
    oldCanvas.classList.add(
      "turn-active",
      dir > 0 ? "turn-exit-next" : "turn-exit-prev"
    );
  }

  setTimeout(() => {
    if (oldCanvas) oldCanvas.remove();
    newCanvas.classList.remove(
      "turn-active", "turn-to-center", "turn-enter-next", "turn-enter-prev"
    );
    newCanvas.classList.add("base");
    finishTurn(newCanvas);
  }, turnDurationMs() + 20);
}

/* ---------- 卷页动画 ----------
   向前：当前页从右缘卷成纸筒，向左滚出，露出下一页；
   向后：上一页从左缘滚入摊平，盖住当前页（时间反演）。
   Linux WebKit：从 DOM 移除的 canvas 再 drawImage/复挂可能变空白，动画全程用快照。 */
function clonePageCanvas(src) {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.style.width = src.style.width;
  c.style.height = src.style.height;
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

function drawCurlFrame(ctx, img, W, H, t, R) {
  ctx.clearRect(0, 0, W, H);
  const xc = W - t * (W + R); // 卷轴接触线

  // 纸筒右侧投影（落在下层页面上）
  if (xc + R < W) {
    const shW = R * 0.9;
    const g = ctx.createLinearGradient(xc + R, 0, xc + R + shW, 0);
    g.addColorStop(0, "rgba(60,45,25,0.30)");
    g.addColorStop(1, "rgba(60,45,25,0)");
    ctx.fillStyle = g;
    ctx.fillRect(xc + R, 0, shW, H);
  }

  // 未卷起的平摊部分
  if (xc > 0) {
    const w = Math.min(xc, W);
    ctx.drawImage(img, 0, 0, w, H, 0, 0, w, H);
    // 接近卷轴处的弯折阴影
    const bw = R * 0.5;
    const bg = ctx.createLinearGradient(xc - bw, 0, xc, 0);
    bg.addColorStop(0, "rgba(0,0,0,0)");
    bg.addColorStop(1, "rgba(0,0,0,0.16)");
    ctx.fillStyle = bg;
    ctx.fillRect(Math.max(0, xc - bw), 0, Math.min(bw, xc), H);
  }

  // 纸筒本体（看到的是纸的背面，圆柱高光）
  if (xc + R > 0 && xc < W) {
    const rg = ctx.createLinearGradient(xc, 0, xc + R, 0);
    rg.addColorStop(0, "#b3aa99");
    rg.addColorStop(0.28, "#fdfbf3");
    rg.addColorStop(0.6, "#f2ecdd");
    rg.addColorStop(1, "#a49b89");
    ctx.fillStyle = rg;
    ctx.fillRect(xc, 0, R, H);
    ctx.fillStyle = "rgba(90,70,40,0.35)";
    ctx.fillRect(xc, 0, 1.5, H);
    ctx.fillRect(xc + R - 1.5, 0, 1.5, H);
  }
}

function animateCurl(dir, oldCanvas, newCanvas) {
  return new Promise((resolve) => {
    const forward = dir > 0;
    const baseSnap = clonePageCanvas(forward ? newCanvas : oldCanvas);
    const movingSnap = clonePageCanvas(forward ? oldCanvas : newCanvas);
    const finalSnap = clonePageCanvas(newCanvas);

    pageHost.replaceChildren();
    baseSnap.className = "page-layer base";
    sizeHostTo(baseSnap);
    pageHost.appendChild(baseSnap);

    const ov = document.createElement("canvas");
    ov.width = movingSnap.width;
    ov.height = movingSnap.height;
    ov.style.width = movingSnap.style.width;
    ov.style.height = movingSnap.style.height;
    ov.className = "curl-layer";
    pageHost.appendChild(ov);

    const ctx = ov.getContext("2d");
    const W = ov.width;
    const H = ov.height;
    const R = Math.max(36, W * 0.1);
    const dur = turnDurationMs();
    const t0 = performance.now();

    function frame(now) {
      let u = Math.min(1, (now - t0) / dur);
      u = 1 - Math.pow(1 - u, 2); // ease-out
      const t = forward ? u : 1 - u;
      drawCurlFrame(ctx, movingSnap, W, H, t, R);
      if ((now - t0) < dur) {
        requestAnimationFrame(frame);
      } else {
        pageHost.replaceChildren();
        finalSnap.className = "page-layer base";
        sizeHostTo(finalSnap);
        pageHost.appendChild(finalSnap);
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

function applyTurnStyleLabel() {
  $("btnTurnStyle").textContent =
    turnStyle() === "curl" ? t("turnCurl") : t("turnSlide");
}

function toggleTurnStyle() {
  store.data.settings.turnStyle = turnStyle() === "curl" ? "slide" : "curl";
  store.save();
  applyTurnStyleLabel();
  showToast(turnStyle() === "curl" ? t("switchedCurl") : t("switchedSlide"));
}

/* ---------- 双页对开切换 ---------- */
function applySpreadLabel() {
  const btn = $("btnSpread");
  btn.disabled = pdfPreSpread;
  btn.title = pdfPreSpread ? t("preSpreadBtnTitle") : t("btnSpreadTitle");
  btn.textContent = spreadActive() ? t("dualPage") : t("singlePage");
}

async function toggleSpread() {
  if (pdfPreSpread) {
    showToast(t("preSpreadNoSpread"));
    return;
  }
  if (rotation !== 0) {
    showToast(t("spreadNoPortrait"));
    return;
  }
  partZoom = null;
  store.data.settings.spread = !spreadMode();
  store.save();
  applySpreadLabel();
  if (pdfDoc) {
    renderSeq++;
    renderCache.clear();
    await computeBaseScale();
    await showPage(currentPage);
  }
  showToast(spreadMode() ? t("switchedSpread") : t("switchedSingle"));
}

/* ---------- 竖屏翻转阅读 ---------- */
async function setRotation(deg) {
  partZoom = null;
  rotation = deg;
  document.body.classList.toggle("rot90", deg === 90);
  document.body.classList.toggle("rot270", deg === 270);
  applyRotateLabel();
  await setFullscreen(deg !== 0);
  await new Promise((r) => setTimeout(r, 120));
  if (pdfDoc) {
    renderSeq++;
    renderCache.clear();
    await computeBaseScale();
    await showPage(currentPage);
  }
  showToast(
    deg === 0
      ? t("restoredUpright")
      : t("portraitToast", {
          side: t(deg === 90 ? "sideRight" : "sideLeft"),
          way: t(deg === 90 ? "wayCCW" : "wayCW"),
        }),
    3200
  );
}

function cycleRotation() {
  setRotation(rotation === 0 ? 90 : rotation === 90 ? 270 : 0);
}

async function setFullscreen(on) {
  try {
    if (IS_TAURI) {
      await window.__TAURI__.window.getCurrentWindow().setFullscreen(on);
    } else if (on && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else if (!on && document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch { /* 全屏被拒绝时静默，旋转仍生效 */ }
}

function isApiFullscreen() {
  return !!(
    document.fullscreenElement
    || document.webkitFullscreenElement
    || document.mozFullScreenElement
    || document.msFullscreenElement
  );
}

function isBrowserNativeFullscreen() {
  if (isApiFullscreen()) return false;
  try {
    return window.matchMedia("(display-mode: fullscreen)").matches;
  } catch {
    return false;
  }
}

async function requestApiFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  throw new Error("fullscreen unsupported");
}

async function exitApiFullscreen() {
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
}

async function toggleFullscreen() {
  try {
    if (IS_TAURI) {
      const w = window.__TAURI__.window.getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
      return;
    }
    if (isApiFullscreen()) {
      await exitApiFullscreen();
      return;
    }
    if (isBrowserNativeFullscreen()) {
      showToast("当前是浏览器 F11 全屏，请再按 F11 退出，再用 F 进入阅读全屏", 4200);
      return;
    }
    await requestApiFullscreen();
  } catch (err) {
    console.warn("fullscreen toggle failed", err);
    showToast("全屏切换未成功 · 可试按 F，或先退出浏览器 F11", 3200);
  }
}

function handleFullscreenHotkey(e) {
  if (e.key !== "F11" && e.code !== "F11") return false;
  if (e.repeat) {
    e.preventDefault();
    return true;
  }
  if (!IS_TAURI && isBrowserNativeFullscreen()) {
    return true;
  }
  e.preventDefault();
  e.stopPropagation();
  void toggleFullscreen();
  return true;
}

/* ---------- 多显示器（Ctrl+1 主屏 · Ctrl+2 副屏） ---------- */
function monitorKey(m) {
  const p = m.position;
  const s = m.size;
  return `${p.x},${p.y},${s.width},${s.height}`;
}

function isSameMonitor(a, b) {
  if (!a || !b) return false;
  return monitorKey(a) === monitorKey(b);
}

function monitorWorkAreaPixels(m) {
  const wa = m.workArea || m;
  const size = wa.size || m.size;
  return (size?.width || 0) * (size?.height || 0);
}

function monitorAnchorPhysical(monitor) {
  const pos = monitor.workArea?.position || monitor.position;
  return { x: pos.x + 20, y: pos.y + 20 };
}

function makePhysicalPosition(x, y) {
  const dpi = window.__TAURI__?.dpi;
  if (dpi?.PhysicalPosition) return new dpi.PhysicalPosition(x, y);
  return { type: "Physical", x, y };
}

function tauriMonitorApi() {
  return window.__TAURI__.window;
}

async function fetchMonitors() {
  const api = tauriMonitorApi();
  const [monitors, primary, current] = await Promise.all([
    api.availableMonitors(),
    api.primaryMonitor(),
    api.currentMonitor(),
  ]);
  return { monitors, primary, current };
}

function pickSecondaryMonitor(monitors, primary) {
  const others = monitors.filter((m) => !isSameMonitor(m, primary));
  if (!others.length) return null;
  return others.sort((a, b) => monitorWorkAreaPixels(b) - monitorWorkAreaPixels(a))[0];
}

async function moveWindowToMonitor(monitor) {
  if (!IS_TAURI || !monitor) return false;
  const win = tauriMonitorApi().getCurrentWindow();
  if (await win.isFullscreen()) await win.setFullscreen(false);
  if (await win.isMaximized()) {
    await win.unmaximize();
    await new Promise((r) => setTimeout(r, 80));
  }

  const anchor = monitorAnchorPhysical(monitor);
  await win.setPosition(makePhysicalPosition(anchor.x, anchor.y));
  await win.maximize();
  await win.show();
  await win.setFocus();
  return true;
}

async function moveToPrimaryMonitor() {
  if (!IS_TAURI) {
    showToast(t("monitorDesktopOnly"));
    return;
  }
  try {
    const { primary } = await fetchMonitors();
    if (!primary) {
      showToast(t("monitorPrimaryMissing"));
      return;
    }
    if (await moveWindowToMonitor(primary)) {
      showToast(t("monitorMovedPrimary"));
      await refreshMonitorButton();
    }
  } catch (e) {
    console.error("moveToPrimaryMonitor", e);
    showToast(t("monitorMoveFailed"));
  }
}

async function moveToSecondaryMonitor() {
  if (!IS_TAURI) {
    showToast(t("monitorDesktopOnly"));
    return;
  }
  try {
    const { monitors, primary } = await fetchMonitors();
    const secondary = pickSecondaryMonitor(monitors, primary);
    if (!secondary) {
      showToast(t("monitorSecondaryMissing"));
      return;
    }
    if (await moveWindowToMonitor(secondary)) {
      showToast(t("monitorMovedSecondary"));
      await refreshMonitorButton();
    }
  } catch (e) {
    console.error("moveToSecondaryMonitor", e);
    showToast(t("monitorMoveFailed"));
  }
}

async function toggleMonitor() {
  if (!IS_TAURI) {
    showToast(t("monitorDesktopOnly"));
    return;
  }
  try {
    const { monitors, primary, current } = await fetchMonitors();
    const secondary = pickSecondaryMonitor(monitors, primary);
    if (!secondary) {
      showToast(t("monitorSecondaryMissing"));
      return;
    }
    if (isSameMonitor(current, primary)) {
      if (await moveWindowToMonitor(secondary)) {
        showToast(t("monitorMovedSecondary"));
        await refreshMonitorButton();
      }
    } else {
      if (await moveWindowToMonitor(primary)) {
        showToast(t("monitorMovedPrimary"));
        await refreshMonitorButton();
      }
    }
  } catch (e) {
    console.error("toggleMonitor", e);
    showToast(t("monitorMoveFailed"));
  }
}

/* 物理坐标 → 逻辑（旋转后）水平比例，用于点击翻页分区 */
function logicalXFraction(e) {
  const r = document.getElementById("viewport").getBoundingClientRect();
  if (rotation === 90) return (e.clientY - r.top) / r.height;
  if (rotation === 270) return 1 - (e.clientY - r.top) / r.height;
  return (e.clientX - r.left) / r.width;
}

/* 物理坐标 → 逻辑纵向像素，用于顶栏 hover 唤出 */
function logicalY(e) {
  if (rotation === 90) return window.innerWidth - e.clientX;
  if (rotation === 270) return e.clientX;
  return e.clientY;
}

/* 物理坐标 → 逻辑水平像素，用于左右边缘快捷键提示 */
function logicalX(e) {
  const r = document.getElementById("viewport").getBoundingClientRect();
  if (rotation === 90) return e.clientY - r.top;
  if (rotation === 270) return r.bottom - e.clientY;
  return e.clientX - r.left;
}

function logicalViewportWidth() {
  return document.getElementById("viewport").getBoundingClientRect().width;
}

function setHintOverlay(open) {
  hintOverlayOpen = open;
  hintOverlay.classList.toggle("closed", !open);
  hintOverlay.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) {
    shortcutHints.classList.add("closed");
    edgeHintLeft.classList.remove("visible");
    edgeHintRight.classList.remove("visible");
  }
}

function toggleHintOverlay() {
  setHintOverlay(!hintOverlayOpen);
}

function updateEdgeHints(e) {
  if (!pdfDoc || hintOverlayOpen) return;
  const lx = logicalX(e);
  const vw = logicalViewportWidth();
  const onLeft = lx < EDGE_HINT_PX;
  const onRight = lx > vw - EDGE_HINT_PX;
  if (onLeft || onRight) {
    shortcutHints.classList.remove("closed");
    shortcutHints.setAttribute("aria-hidden", "false");
    edgeHintLeft.classList.toggle("visible", onLeft);
    edgeHintRight.classList.toggle("visible", onRight);
    bumpHintIdle();
  }
}

function hideEdgeHints() {
  clearTimeout(hintIdleTimer);
  hintIdleTimer = 0;
  edgeHintLeft.classList.remove("visible");
  edgeHintRight.classList.remove("visible");
  shortcutHints.classList.add("closed");
  shortcutHints.setAttribute("aria-hidden", "true");
}

function bumpHintIdle() {
  clearTimeout(hintIdleTimer);
  hintIdleTimer = setTimeout(() => {
    hideEdgeHints();
  }, HINT_IDLE_MS);
}

function hideAllHints() {
  setHintOverlay(false);
  hideEdgeHints();
}

/** 打开书时先亮一下左右提示，随后无操作自动收起 */
function showEdgeHintsBriefly() {
  if (!pdfDoc) return;
  edgeHintLeft.classList.add("visible");
  edgeHintRight.classList.add("visible");
  shortcutHints.classList.remove("closed");
  shortcutHints.setAttribute("aria-hidden", "false");
  bumpHintIdle();
}

async function goHome() {
  hideAllHints();
  try {
    await setFullscreen(false);
  } catch { /* ignore */ }
  if (rotation !== 0) {
    rotation = 0;
    document.body.classList.remove("rot90", "rot270");
    applyRotateLabel();
  }
  pdfDoc = null;
  docId = null;
  currentPage = 1;
  userZoom = 1;
  partZoom = null;
  partZoomBaseCanvas = null;
  pdfPreSpread = false;
  renderSeq++;
  renderCache.clear();
  pageHost.innerHTML = "";
  pageHost.style.width = "";
  pageHost.style.height = "";
  pageHost.classList.remove("part-top", "part-middle", "part-bottom");
  startScreen.classList.remove("closed");
  topbar.classList.add("hidden-doc");
  topbar.classList.remove("show");
  docTitle.textContent = "";
  for (const id of ["btnOutline", "btnJump", "btnZoomReset", "btnBookmarks"]) {
    $(id).disabled = true;
  }
  outlinePanel.classList.add("closed");
  bookmarkPanel.classList.add("closed");
  jumpBox.classList.add("closed");
  applySpreadLabel();
  renderRecents();
}

/* ---------- 最近打开（Tauri 下才有文件路径） ---------- */
async function captureThumbFromDoc(doc) {
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1, THUMB_MAX_W / base.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
    }).promise;
    return canvas.toDataURL("image/jpeg", THUMB_JPEG_Q);
  } catch (e) {
    console.warn("thumb capture failed", e);
    return null;
  }
}

async function loadRecentThumb(recent) {
  if (!IS_TAURI || recent.thumb) return;
  try {
    let size = recent.size;
    if (size == null) {
      size = await window.__TAURI__.core.invoke("pdf_file_size", { path: recent.path });
      recent.size = size;
    }
    if (size > THUMB_LAZY_MAX_BYTES) return;

    const data = await loadPdfBytes(recent.path, size);
    const doc = await pdfjsLib.getDocument({ data, ...PDF_OPTIONS }).promise;
    const thumb = await captureThumbFromDoc(doc);
    await doc.destroy();
    if (!thumb) return;

    const entry = store.data.recents.find((r) => r.path === recent.path);
    if (!entry) return;
    entry.thumb = thumb;
    if (size != null) entry.size = size;
    store.save();
    renderRecents();
  } catch (e) {
    console.warn("recent thumb load failed", recent.path, e);
  }
}

function queueRecentThumb(recent) {
  if (!recent || recent.thumb) return;
  if (recent.size != null && recent.size > THUMB_LAZY_MAX_BYTES) return;
  if (thumbQueue.some((r) => r.path === recent.path)) return;
  thumbQueue.push(recent);
  void drainThumbQueue();
}

async function drainThumbQueue() {
  if (thumbQueueBusy) return;
  thumbQueueBusy = true;
  while (thumbQueue.length) {
    const item = thumbQueue.shift();
    await loadRecentThumb(item);
  }
  thumbQueueBusy = false;
}

function addRecent(path, name, sizeBytes, thumb) {
  if (!path) return;
  const prev = store.data.recents.find((r) => r.path === path);
  let list = store.data.recents.filter((r) => r.path !== path);
  list.unshift({
    path,
    name,
    ts: Date.now(),
    size: sizeBytes ?? prev?.size,
    thumb: thumb ?? prev?.thumb,
  });
  store.data.recents = list.slice(0, RECENT_LIMIT);
  store.save();
  void store.flush();
  renderRecents();
}

function removeRecent(path) {
  store.data.recents = store.data.recents.filter((r) => r.path !== path);
  store.save();
  renderRecents();
}

function renderRecents() {
  if (!IS_TAURI) return;
  const list = Array.isArray(store.data.recents) ? store.data.recents : [];
  recentBox.classList.toggle("closed", list.length === 0);
  recentList.innerHTML = "";
  recentList.className = "recent-grid";

  for (const r of list.slice(0, RECENT_GRID_LIMIT)) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "recent-card";
    card.title = r.path;

    if (r.thumb) {
      const img = document.createElement("img");
      img.className = "recent-thumb";
      img.src = r.thumb;
      img.alt = "";
      img.loading = "lazy";
      card.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "recent-thumb recent-thumb-placeholder";
      ph.textContent = "PDF";
      card.appendChild(ph);
      queueRecentThumb(r);
    }

    const label = document.createElement("span");
    label.className = "recent-name";
    label.textContent = r.name;
    card.appendChild(label);

    card.addEventListener("click", () => openPath(r.path));
    recentList.appendChild(card);
  }
}

/* ---------- 打开文档 ---------- */
async function finishOpenSideEffects(saved) {
  if (!pdfDoc) return;
  try {
    pdfPreSpread = await detectPreSpread(pdfDoc);
    if (pdfPreSpread) {
      if (spreadMode()) {
        store.data.settings.spread = false;
        store.save();
      }
      applySpreadLabel();
      renderSeq++;
      renderCache.clear();
      await computeBaseScale();
      await showPage(currentPage);
      showToast(t("preSpreadDetected"), 3600);
    } else {
      applySpreadLabel();
    }
    await buildOutline();
    renderBookmarkPanel();
    showEdgeHintsBriefly();
    try {
      await setFullscreen(true);
    } catch { /* 全屏被拒时仍可阅读 */ }
    if (saved && saved.page > 1) showToast(t("resumedPage", { page: currentPage }));
  } catch (e) {
    console.warn("finishOpenSideEffects", e);
  }
}

async function openData(source, name, sizeBytes) {
  if (sizeBytes > MAX_BYTES) {
    showToast(t("fileTooLarge", { mb: (sizeBytes / 1048576).toFixed(0) }));
    return false;
  }
  try {
    const task = pdfjsLib.getDocument({ data: source, ...PDF_OPTIONS });
    const doc = await task.promise;

    renderSeq++;
    renderCache.clear();
    pdfDoc = doc;
    pdfPreSpread = false;
    docId = `${name}|${sizeBytes}`;
    docTitle.textContent = name;

    const saved = store.data.progress[docId];
    currentPage = saved && saved.page >= 1 && saved.page <= doc.numPages ? saved.page : 1;
    userZoom = saved && saved.zoom ? saved.zoom : 1;
    updateZoomLabel();

    await computeBaseScale();
    await showPage(currentPage);

    startScreen.classList.add("closed");
    topbar.classList.remove("hidden-doc");
    for (const id of ["btnOutline", "btnJump", "btnZoomReset", "btnBookmarks"]) {
      $(id).disabled = false;
    }

    void finishOpenSideEffects(saved);
    return true;
  } catch (err) {
    if (err && err.name === "PasswordException") {
      showToast(t("encryptedPdf"));
    } else {
      console.error(err);
      showToast(t("corruptPdf"));
    }
    return false;
  }
}

async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    showToast(t("pdfOnly"));
    return;
  }
  const buf = await file.arrayBuffer();
  await openData(new Uint8Array(buf), file.name, file.size);
}

async function finishOpenRecent(path, name, sizeBytes) {
  try {
    const thumb = await captureThumbFromDoc(pdfDoc);
    addRecent(path, name, sizeBytes, thumb);
  } catch (e) {
    console.warn("finishOpenRecent", e);
    addRecent(path, name, sizeBytes, null);
  }
}

/** 大文件经 Rust 分块读取（二进制 IPC），绕开 asset 协议在 WebView2 上大响应体不稳定的问题 */
async function readPdfBytesChunked(path, sizeBytes, onProgress) {
  const data = new Uint8Array(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const len = Math.min(PDF_CHUNK_SIZE, sizeBytes - offset);
    const chunk = await window.__TAURI__.core.invoke("read_pdf_chunk", { path, offset, len });
    const bytes = new Uint8Array(chunk);
    if (!bytes.length) throw new Error(`read_pdf_chunk: empty read at ${offset}`);
    data.set(bytes, offset);
    offset += bytes.length;
    onProgress?.(offset / sizeBytes);
  }
  return data;
}

/** 读取 PDF 字节：小文件走 asset fetch（快），大文件走分块 IPC（稳） */
async function loadPdfBytes(path, sizeBytes) {
  if (sizeBytes <= INLINE_OPEN_MAX) {
    try {
      const url = window.__TAURI__.core.convertFileSrc(path);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch pdf failed: ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      console.warn("asset fetch failed, fallback to chunked read", e);
    }
  }
  return readPdfBytesChunked(path, sizeBytes);
}

/* Tauri：≤64MB 主线程 fetch 读入；更大文件分块 IPC 读入，全部走 data 模式打开 */
async function openPath(path) {
  const name = path.split(/[\\/]/).pop() || "document.pdf";
  try {
    const sizeBytes = await window.__TAURI__.core.invoke("pdf_file_size", { path });
    if (sizeBytes > MAX_BYTES) {
      showToast(t("fileTooLarge", { mb: (sizeBytes / 1048576).toFixed(0) }));
      return;
    }
    if (sizeBytes > INLINE_OPEN_MAX) {
      showToast(`${name} · ${(sizeBytes / 1048576).toFixed(0)} MB…`, 6000);
    }
    const data = await loadPdfBytes(path, sizeBytes);
    const ok = await openData(data, name, sizeBytes);
    if (ok) void finishOpenRecent(path, name, sizeBytes);
  } catch (e) {
    console.error(e);
    showToast(t("openFailed", { name }));
    removeRecent(path);
  }
}

/* 统一入口：Tauri 用原生对话框（可记路径），浏览器用 <input type=file> */
async function pickAndOpen() {
  if (IS_TAURI) {
    try {
      const path = await window.__TAURI__.core.invoke("plugin:dialog|open", {
        options: {
          title: t("dialogOpenPdf"),
          filters: [{ name: "PDF", extensions: ["pdf"] }],
          multiple: false,
          directory: false,
        },
      });
      if (path) await openPath(typeof path === "string" ? path : path.path || path[0]);
      return;
    } catch (e) {
      console.error("native dialog failed, fallback", e);
    }
  }
  fileInput.click();
}

/* ---------- PDF 内嵌目录 ---------- */
async function outlineItemPage(item) {
  try {
    let dest = item.dest;
    if (typeof dest === "string") dest = await pdfDoc.getDestination(dest);
    if (!Array.isArray(dest) || !dest[0]) return null;
    return (await pdfDoc.getPageIndex(dest[0])) + 1;
  } catch {
    return null;
  }
}

async function buildOutline() {
  outlineList.innerHTML = "";
  const outline = await pdfDoc.getOutline();
  if (!outline || outline.length === 0) {
    outlineList.innerHTML = `<div class="outline-empty">${t("noOutline")}</div>`;
    return;
  }
  const addItems = async (items, depth) => {
    for (const it of items) {
      const btn = document.createElement("button");
      btn.className = "outline-item";
      btn.textContent = it.title || t("untitled");
      btn.style.paddingLeft = `${14 + depth * 16}px`;
      btn.addEventListener("click", async () => {
        const p = await outlineItemPage(it);
        if (p) {
          outlinePanel.classList.add("closed");
          await showPage(p);
        }
      });
      outlineList.appendChild(btn);
      if (it.items && it.items.length) await addItems(it.items, depth + 1);
    }
  };
  await addItems(outline, 0);
}

/* ---------- 缩放 ---------- */
async function setZoom(z) {
  if (!pdfDoc || animating) return;
  partZoom = null;
  userZoom = Math.min(4, Math.max(0.5, z));
  updateZoomLabel();
  renderSeq++;
  renderCache.clear();
  await showPage(currentPage);
}

/* ---------- 事件 ---------- */
$("btnOpen").addEventListener("click", pickAndOpen);
$("btnStartOpen").addEventListener("click", pickAndOpen);
$("btnRotate").addEventListener("click", cycleRotation);
$("btnMonitor").addEventListener("click", () => void toggleMonitor());
$("btnTurnStyle").addEventListener("click", toggleTurnStyle);
$("btnSpread").addEventListener("click", toggleSpread);
$("btnBookmarks").addEventListener("click", () => {
  renderBookmarkPanel();
  bookmarkPanel.classList.toggle("closed");
});
$("btnBookmarkClose").addEventListener("click", () =>
  bookmarkPanel.classList.add("closed"));
fileInput.addEventListener("change", () => {
  openFile(fileInput.files[0]);
  fileInput.value = "";
});

/* 拖放：Tauri 用原生事件（有路径），浏览器用 HTML5 */
if (IS_TAURI) {
  const { listen } = window.__TAURI__.event;
  listen("tauri://drag-enter", () => dropMask.classList.remove("closed"));
  listen("tauri://drag-leave", () => dropMask.classList.add("closed"));
  listen("tauri://drag-drop", (e) => {
    dropMask.classList.add("closed");
    const payload = e.payload;
    const paths = Array.isArray(payload)
      ? payload
      : (payload && payload.paths) || [];
    const pdf = paths.find((p) => /\.pdf$/i.test(p));
    if (pdf) openPath(pdf);
    else if (paths.length) showToast(t("pdfOnly"));
  });
  /* 文件关联 / 命令行传入的 PDF */
  listen("open-pdf", (e) => {
    queueLaunchPath(e.payload);
  });
} else {
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    dropMask.classList.remove("closed");
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) { dragDepth = 0; dropMask.classList.add("closed"); }
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropMask.classList.add("closed");
    openFile(e.dataTransfer.files[0]);
  });
}

/* 点击：屏幕左右 10% 翻页；页内中间区域按 U/M/L 三分区放大 */
stage.addEventListener("mousedown", () => {
  if (pdfDoc) focusReader();
});

stage.addEventListener("click", (e) => {
  if (!pdfDoc) return;
  const fx = logicalXFraction(e);

  if (fx < TURN_EDGE) {
    turnPage(-1);
    return;
  }
  if (fx > 1 - TURN_EDGE) {
    turnPage(1);
    return;
  }

  if (rotation === 0 && !spreadActive() && clickOnPage(e)) {
    if (partZoom) void togglePartZoom(partZoom);
    else void togglePartZoom(pageClickZone(pageClickYFraction(e)));
  }
});

/* 键盘（Linux WebKit 需在 capture 阶段拦截方向键） */
window.addEventListener("keydown", handleReaderNavKey, true);
window.addEventListener("keydown", (e) => { handleFullscreenHotkey(e); }, true);

document.addEventListener("keydown", (e) => {
  if (e.target === langRequestInput || e.target === langRequestNote) {
    if (e.key === "Enter" && e.target === langRequestInput) {
      e.preventDefault();
      void sendLangRequest();
    } else if (e.key === "Escape") {
      closeLangRequestBox();
    }
    return;
  }

  if (e.target === jumpInput) {
    if (e.key === "Enter") {
      const n = parseInt(jumpInput.value, 10);
      jumpBox.classList.add("closed");
      if (pdfDoc && n >= 1 && n <= pdfDoc.numPages) showPage(n);
      else if (jumpInput.value) showToast(t("pageOutOfRange"));
    } else if (e.key === "Escape") {
      jumpBox.classList.add("closed");
    }
    return;
  }

  if (e.ctrlKey && (e.key === "o" || e.key === "O")) {
    e.preventDefault(); pickAndOpen(); return;
  }
  if (e.ctrlKey && (e.key === "g" || e.key === "G")) {
    e.preventDefault(); openJumpBox(); return;
  }
  if (e.ctrlKey && e.key === "0") {
    e.preventDefault(); setZoom(1); return;
  }
  if (e.ctrlKey && e.key === "1") {
    e.preventDefault(); void moveToPrimaryMonitor(); return;
  }
  if (e.ctrlKey && e.key === "2") {
    e.preventDefault(); void moveToSecondaryMonitor(); return;
  }
  /* F11 在 capture 阶段处理，见 handleFullscreenHotkey */
  if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    void toggleFullscreen();
    return;
  }
  if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); cycleRotation(); return;
  }
  if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); toggleBookmark(); return;
  }
  if ((e.key === "d" || e.key === "D") && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); toggleSpread(); return;
  }
  if ((e.key === "u" || e.key === "U") && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); void togglePartZoom("top"); return;
  }
  if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); void togglePartZoom("middle"); return;
  }
  if ((e.key === "l" || e.key === "L") && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); void togglePartZoom("bottom"); return;
  }
  if (e.key === " " && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (pdfDoc && e.target !== jumpInput && e.target !== langRequestInput
        && e.target !== langRequestNote) {
      e.preventDefault();
      toggleHintOverlay();
      return;
    }
  }
  if (!pdfDoc) return;

  switch (e.key) {
    case "Escape":
      if (!hintOverlay.classList.contains("closed")) {
        setHintOverlay(false);
        break;
      }
      if (partZoom) { void clearPartZoom(true); break; }
      if (!langRequestBox.classList.contains("closed")) {
        closeLangRequestBox();
        break;
      }
      if (!outlinePanel.classList.contains("closed")
          || !bookmarkPanel.classList.contains("closed")
          || !jumpBox.classList.contains("closed")) {
        outlinePanel.classList.add("closed");
        bookmarkPanel.classList.add("closed");
        jumpBox.classList.add("closed");
        break;
      }
      /* Esc：先退出全屏；再按回首页 */
      if (IS_TAURI) {
        void (async () => {
          try {
            const w = window.__TAURI__.window.getCurrentWindow();
            if (await w.isFullscreen()) {
              await w.setFullscreen(false);
              showToast(t("exitedFullscreen"), 2200);
              return;
            }
          } catch { /* fall through */ }
          await goHome();
        })();
        break;
      }
      if (document.fullscreenElement) {
        e.preventDefault();
        void setFullscreen(false);
        showToast(t("exitedFullscreen"), 2200);
        break;
      }
      e.preventDefault();
      void goHome();
      break;
  }
});

/* Ctrl + 滚轮缩放 */
window.addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !pdfDoc) return;
  e.preventDefault();
  clearTimeout(setZoom._t);
  const next = userZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
  userZoom = Math.min(4, Math.max(0.5, next));
  updateZoomLabel();
  showIndicator();
  setZoom._t = setTimeout(() => setZoom(userZoom), 160);
}, { passive: false });

/* 顶栏 hover 唤出（按旋转后的逻辑顶部）；左右边缘快捷键提示 */
document.addEventListener("mousemove", (e) => {
  if (!pdfDoc) return;
  const ly = logicalY(e);
  if (ly < 56) topbar.classList.add("show");
  else if (ly > 90 && document.activeElement !== jumpInput
           && jumpBox.classList.contains("closed")) {
    topbar.classList.remove("show");
  }
  updateEdgeHints(e);
});

/* 目录 / 跳转按钮 */
$("btnOutline").addEventListener("click", () =>
  outlinePanel.classList.toggle("closed"));
$("btnOutlineClose").addEventListener("click", () =>
  outlinePanel.classList.add("closed"));
$("btnJump").addEventListener("click", openJumpBox);
$("btnZoomReset").addEventListener("click", () => setZoom(1));

function openJumpBox(focus = true) {
  if (!pdfDoc) return;
  jumpTotal.textContent = t("jumpTotal", { n: pdfDoc.numPages });
  jumpInput.value = "";
  jumpInput.max = pdfDoc.numPages;
  jumpBox.classList.remove("closed");
  if (focus) jumpInput.focus();
}

/* 窗口 resize / 全屏切换：重算适应尺寸 */
window.addEventListener("resize", () => {
  if (!pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    const hz = partZoom;
    renderSeq++;
    renderCache.clear();
    await computeBaseScale();
    await showPage(currentPage);
    if (hz) {
      partZoom = hz;
      partZoomBaseCanvas = null;
      await applyPartZoomView();
    }
  }, 200);
});

document.addEventListener("fullscreenchange", () => {
  if (!pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    renderSeq++;
    renderCache.clear();
    await computeBaseScale();
    await showPage(currentPage);
    showEdgeHintsBriefly();
  }, 80);
});

/* ---------- 启动 ---------- */
(async function start() {
  await store.init();
  await initI18n(store.data.settings.locale);
  setupLangSelects();
  setupLangRequest();
  setupSupport();
  refreshDynamicLabels();
  renderRecents();
  await showAppVersion();

  /* Tauri：双击 PDF / 右键打开方式 / 微信「用此应用打开」传入的路径 */
  if (IS_TAURI) {
    try {
      const launch = await window.__TAURI__.core.invoke("take_launch_pdf");
      if (launch) queueLaunchPath(launch);
    } catch (e) {
      console.error("launch pdf failed", e);
    }
    await flushPendingLaunchPaths();
  }

  /* ?file= 自动加载（浏览器 / Docker 书库用） */
  const q = new URLSearchParams(location.search).get("file");
  if (!q) return;
  try {
    const resp = await fetch(q);
    const buf = await resp.arrayBuffer();
    const name = decodeURIComponent(q.split("?")[0].split("/").pop());
    await openData(new Uint8Array(buf), name, buf.byteLength);
  } catch (e) {
    console.error("autoload failed", e);
  }
})();
