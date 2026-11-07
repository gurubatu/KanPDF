/**
 * 将 pdfjs-dist 运行时资源同步到 web/vendor/pdfjs（legacy 构建 + cmaps + 字体 + wasm）。
 * 缺 wasm 时 JPEG2000 / ICC 色彩管理无法工作，PDF 会只剩黑白文字。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PKG = path.join(ROOT, "node_modules", "pdfjs-dist");
const OUT = path.join(ROOT, "web", "vendor", "pdfjs");

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    console.error("missing:", srcDir);
    process.exit(1);
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    if (fs.statSync(src).isDirectory()) copyDir(src, dest);
    else copyFile(src, dest);
  }
}

if (!fs.existsSync(PKG)) {
  console.error("Run npm install first (pdfjs-dist missing).");
  process.exit(1);
}

copyFile(
  path.join(PKG, "legacy", "build", "pdf.min.mjs"),
  path.join(OUT, "pdf.min.mjs")
);
copyFile(
  path.join(PKG, "legacy", "build", "pdf.worker.min.mjs"),
  path.join(OUT, "pdf.worker.min.mjs")
);
copyDir(path.join(PKG, "cmaps"), path.join(OUT, "cmaps"));
copyDir(path.join(PKG, "standard_fonts"), path.join(OUT, "standard_fonts"));
copyDir(path.join(PKG, "wasm"), path.join(OUT, "wasm"));

console.log("synced pdfjs vendor ->", OUT);
