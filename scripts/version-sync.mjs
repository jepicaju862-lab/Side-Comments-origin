import fs from "node:fs";

const manifestPath = new URL("../manifest.json", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

if (pkg.version !== manifest.version) {
  pkg.version = manifest.version;
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log(`Synced package.json to version ${manifest.version}`);
} else {
  console.log(`Versions already match at ${manifest.version}`);
}
