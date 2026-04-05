import { readFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ── Load config ──────────────────────────────────────────────
const configPath = resolve(root, "config.json");
if (!existsSync(configPath)) {
	console.error(
		"\n❌  config.json not found.\n" +
		"    Copy config.json.template to config.json and set your vault path.\n"
	);
	process.exit(1);
}

let config;
try {
	config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
	console.error("❌  Failed to parse config.json:", e.message);
	process.exit(1);
}

const vaultPluginPath = config.vaultPluginPath;
if (!vaultPluginPath || vaultPluginPath === "/path/to/your/vault/.obsidian/plugins/pensieve") {
	console.error(
		"\n❌  Please set a real vaultPluginPath in config.json.\n"
	);
	process.exit(1);
}

const dest = resolve(vaultPluginPath);

// ── Ensure destination exists ────────────────────────────────
mkdirSync(dest, { recursive: true });

// ── Copy artifacts ───────────────────────────────────────────
const files = ["main.js", "manifest.json", "styles.css"];
for (const file of files) {
	const src = resolve(root, file);
	if (!existsSync(src)) {
		console.error(`❌  Build artifact not found: ${file}. Run 'npm run build' first.`);
		process.exit(1);
	}
	copyFileSync(src, resolve(dest, file));
	console.log(`✅  Copied ${file} → ${dest}/`);
}

console.log("\n🧠  Pensieve installed. Reload Obsidian to apply changes.\n");
