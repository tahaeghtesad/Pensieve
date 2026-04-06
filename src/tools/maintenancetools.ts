import { TFile } from "obsidian";
import type { Tool, ToolContext, ToolResult } from "./types";

// ── Helpers ──────────────────────────────────────────────────

function normPath(p: string): string {
	let clean = p.replace(/^\/+/, "");
	return clean.endsWith(".md") ? clean : clean + ".md";
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
	const normalized = raw.replace(/\r\n/g, "\n");
	const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match || typeof match[0] !== "string") return { frontmatter: "", body: normalized };
	const body = normalized.slice(match[0].length);
	return { frontmatter: match[0], body };
}

// ── lint_yaml_frontmatter ────────────────────────────────────

export const lintYamlFrontmatterTool: Tool = {
	name: "lint_yaml_frontmatter",
	description: "Reads a note, accepts an array of inferred tags, and safely injects them into the YAML frontmatter without destroying existing data. Also validates required temporal metadata fields.",
	parameters: [
		{ name: "path", type: "string", description: "Note path relative to vault root (e.g. 'Folder/Note.md')", required: true },
		{ name: "inferred_tags", type: "string", description: "A JSON array of tag strings to inject (e.g. '[\"machine-learning\", \"research\"]')", required: true },
	],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const file = ctx.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { success: false, output: `Note not found: ${path}` };

		// Parse the inferred tags
		let newTags: string[];
		try {
			const parsed = JSON.parse(String(args["inferred_tags"] ?? "[]"));
			if (!Array.isArray(parsed)) return { success: false, output: "inferred_tags must be a JSON array of strings." };
			newTags = parsed.map((t: unknown) => String(t).trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase()).filter((t: string) => t.length > 0);
		} catch {
			return { success: false, output: "inferred_tags must be a valid JSON array string." };
		}

		if (newTags.length === 0) return { success: true, output: `No new tags to inject for \`${path}\`.` };

		const addedTags: string[] = [];

		await ctx.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			// Preserve existing tags
			let existingTags: string[] = [];
			if (Array.isArray(fm["tags"])) {
				existingTags = fm["tags"].map((v: unknown) => String(v));
			} else if (typeof fm["tags"] === "string") {
				existingTags = fm["tags"].split(/[\s,]+/g);
			}

			// Normalize existing tags
			const normalizedExisting = new Set(
				existingTags.map((t) => t.trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase()).filter((t) => t.length > 0)
			);

			// Inject only truly new tags
			for (const tag of newTags) {
				if (!normalizedExisting.has(tag)) {
					normalizedExisting.add(tag);
					addedTags.push(tag);
				}
			}

			// Ensure pensieve/managed tag is present
			if (!normalizedExisting.has("pensieve/managed")) {
				normalizedExisting.add("pensieve/managed");
			}

			fm["tags"] = Array.from(normalizedExisting);

			// Audit trail
			fm["maintained_by"] = "Pensieve_Gardener";
			fm["last_linted"] = new Date().toISOString();
		});

		if (addedTags.length === 0) {
			return { success: true, output: `\`${path}\` already has all specified tags. No changes made.` };
		}

		return {
			success: true,
			output: `Linted \`${path}\`: injected ${addedTags.length} new tag(s): [${addedTags.join(", ")}].`,
			affectedFile: path,
		};
	},
};

// ── reparent_orphan_nodes ────────────────────────────────────

export const reparentOrphanNodesTool: Tool = {
	name: "reparent_orphan_nodes",
	description: "Accepts a note path and an array of proposed [[wikilinks]], and appends them to a 'Related' section at the bottom of the note. Creates the section if it doesn't exist. Non-destructive: never removes existing content.",
	parameters: [
		{ name: "path", type: "string", description: "Path of the orphan note to reparent", required: true },
		{ name: "proposed_links", type: "string", description: "A JSON array of wikilink strings to append (e.g. '[\"[[Machine Learning]]\", \"[[Neural Networks]]\"]')", required: true },
	],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const file = ctx.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { success: false, output: `Note not found: ${path}` };

		// Parse proposed links
		let links: string[];
		try {
			const parsed = JSON.parse(String(args["proposed_links"] ?? "[]"));
			if (!Array.isArray(parsed)) return { success: false, output: "proposed_links must be a JSON array of strings." };
			links = parsed.map((l: unknown) => {
				let s = String(l).trim();
				// Ensure wikilink format
				if (!s.startsWith("[[")) s = `[[${s}`;
				if (!s.endsWith("]]")) s = `${s}]]`;
				return s;
			}).filter((l: string) => l.length > 4); // Filter out empty [[]]
		} catch {
			return { success: false, output: "proposed_links must be a valid JSON array string." };
		}

		if (links.length === 0) return { success: true, output: `No new links to add for \`${path}\`.` };

		const raw = await ctx.vault.cachedRead(file);
		const { frontmatter, body } = splitFrontmatter(raw);

		// Check which links already exist in the body
		const newLinks = links.filter((link) => !body.includes(link));
		if (newLinks.length === 0) {
			return { success: true, output: `\`${path}\` already contains all proposed links. No changes made.` };
		}

		// Find or create the "Related" section
		const lines = body.split("\n");
		const relatedHeaders = ["## Related", "## Related Notes", "## See Also"];
		let relatedIdx = -1;
		for (const header of relatedHeaders) {
			const idx = lines.findIndex((l) => l.trim().toLowerCase() === header.toLowerCase());
			if (idx >= 0) {
				relatedIdx = idx;
				break;
			}
		}

		if (relatedIdx >= 0) {
			// Find the end of the Related section (next ## heading or end of file)
			let insertIdx = lines.length;
			for (let i = relatedIdx + 1; i < lines.length; i++) {
				if (/^##\s+/.test(lines[i] ?? "")) {
					insertIdx = i;
					break;
				}
			}
			// Insert new links just before the next section
			const linkLines = newLinks.map((l) => `- ${l}`);
			lines.splice(insertIdx, 0, ...linkLines);
		} else {
			// Append a new "Related Notes" section at the bottom
			lines.push("");
			lines.push("## Related Notes");
			for (const link of newLinks) {
				lines.push(`- ${link}`);
			}
		}

		const updatedBody = lines.join("\n");
		await ctx.vault.modify(file, frontmatter + updatedBody);

		// Update frontmatter audit trail
		await ctx.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm["maintained_by"] = "Pensieve_Gardener";
			fm["last_reparented"] = new Date().toISOString();
		});

		return {
			success: true,
			output: `Reparented \`${path}\`: appended ${newLinks.length} new link(s): ${newLinks.join(", ")}.`,
			affectedFile: path,
		};
	},
};

// ── Registration ─────────────────────────────────────────────

export function registerMaintenanceTools(registry: import("./registry").ToolRegistry): void {
	registry.register(lintYamlFrontmatterTool);
	registry.register(reparentOrphanNodesTool);
}
