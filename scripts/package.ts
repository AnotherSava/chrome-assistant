import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf-8"));
const version: string = manifest.version;

console.log(`Building extension v${version}...`);
execSync("npm run build", { stdio: "inherit" });

const { default: JSZip } = await import("jszip");
const zip = new JSZip();

function addFile(filePath: string): void {
  const full = path.join(root, filePath);
  zip.file(filePath.replace(/\\/g, "/"), fs.readFileSync(full));
}

function addDir(dirPath: string, exclude?: (name: string) => boolean): void {
  const full = path.join(root, dirPath);
  if (!fs.existsSync(full)) return;
  for (const entry of fs.readdirSync(full, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path.join(entry.parentPath ?? entry.path, entry.name);
    const relFromRoot = path.relative(root, rel);
    if (exclude && exclude(relFromRoot)) continue;
    zip.file(relFromRoot.replace(/\\/g, "/"), fs.readFileSync(rel));
  }
}

addFile("manifest.json");
addDir("dist", (name) => name.endsWith(".map"));
addDir("assets/extension");

const outName = `gmail-assistant-${version}.zip`;
const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
fs.writeFileSync(path.join(root, outName), buffer);

const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
console.log(`Created ${outName} (${sizeMB} MB)`);
