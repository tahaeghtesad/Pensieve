import { TFile } from "obsidian";
import type { Tool, ToolContext, ToolResult } from "./types";

// ── Helpers ──────────────────────────────────────────────────

function normPath(p: string): string {
	let clean = p.replace(/^\/+/, ""); // Strip leading slashes
	return clean.endsWith(".md") ? clean : clean + ".md";
}

function joinPath(folder: string, file: string): string {
	const cleanFolder = folder.replace(/^\/+/, "").replace(/\/+$/, "");
	return cleanFolder ? `${cleanFolder}/${file}` : file;
}

async function ensureFolder(ctx: ToolContext, filePath: string): Promise<void> {
	const parts = filePath.split("/").slice(0, -1);
	if (parts.length === 0) return;
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		try { await ctx.vault.createFolder(cur); } catch { /* already exists */ }
	}
}

function getISOWeek(date: Date): { year: number; week: number } {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const day = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - day);
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
	return { year: d.getUTCFullYear(), week };
}

// ── Tools ─────────────────────────────────────────────────────

export const readNoteTool: Tool = {
	name: "read_note",
	description: "Read the full content of a note by its path.",
	parameters: [{ name: "path", type: "string", description: "Note path relative to vault root (e.g. 'Folder/Note.md')", required: true }],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const file = ctx.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { success: false, output: `Note not found: ${path}` };
		const content = await ctx.vault.cachedRead(file);
		return { success: true, output: content };
	},
};

export const writeNoteTool: Tool = {
	name: "write_note",
	description: "Overwrite the entire content of an existing note.",
	parameters: [
		{ name: "path", type: "string", description: "Note path", required: true },
		{ name: "content", type: "string", description: "New markdown content", required: true },
	],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const content = String(args["content"] ?? "");
		const file = ctx.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { success: false, output: `Note not found: ${path}` };
		await ctx.vault.modify(file, content);
		return { success: true, output: `Updated \`${path}\``, affectedFile: path };
	},
};

export const appendToNoteTool: Tool = {
	name: "append_to_note",
	description: "Append text to the end of an existing note.",
	parameters: [
		{ name: "path", type: "string", description: "Note path", required: true },
		{ name: "content", type: "string", description: "Markdown text to append", required: true },
	],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const content = String(args["content"] ?? "");
		const file = ctx.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { success: false, output: `Note not found: ${path}` };
		const existing = await ctx.vault.cachedRead(file);
		const separator = existing.endsWith("\n") ? "\n" : "\n\n";
		await ctx.vault.modify(file, existing + separator + content);
		return { success: true, output: `Appended to \`${path}\``, affectedFile: path };
	},
};

export const createNoteTool: Tool = {
	name: "create_note",
	description: "Create a new note. Fails if the note already exists.",
	parameters: [
		{ name: "path", type: "string", description: "Note path (e.g. 'Projects/NewNote.md')", required: true },
		{ name: "content", type: "string", description: "Initial markdown content", required: true },
	],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const content = String(args["content"] ?? "");
		if (ctx.vault.getAbstractFileByPath(path)) return { success: false, output: `Note already exists: ${path}. Use write_note or append_to_note.` };
		await ensureFolder(ctx, path);
		await ctx.vault.create(path, content);
		return { success: true, output: `Created \`${path}\``, affectedFile: path };
	},
};

export const createDailyNoteTool: Tool = {
	name: "create_daily_note",
	description: "Create or append to today's daily note.",
	parameters: [
		{ name: "content", type: "string", description: "Content to add to the daily note", required: true },
		{ name: "prepend", type: "boolean", description: "If true, add at the top instead of the bottom", required: false },
	],
	async execute(args, ctx): Promise<ToolResult> {
		const content = String(args["content"] ?? "");
		const prepend = Boolean(args["prepend"] ?? false);
		const dateStr = new Date().toISOString().split("T")[0]!;
		const folder = ctx.settings.dailyNoteFolder ?? "Daily";
		const path = joinPath(folder, `${dateStr}.md`);
		const existing = ctx.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const old = await ctx.vault.cachedRead(existing);
			const updated = prepend ? content + "\n\n" + old : old + (old.endsWith("\n") ? "\n" : "\n\n") + content;
			await ctx.vault.modify(existing, updated);
			return { success: true, output: `Updated daily note \`${path}\``, affectedFile: path };
		}
		await ensureFolder(ctx, path);
		const header = `# Daily Note — ${dateStr}\n\n`;
		await ctx.vault.create(path, header + content);
		return { success: true, output: `Created daily note \`${path}\``, affectedFile: path };
	},
};

export const createWeeklyNoteTool: Tool = {
	name: "create_weekly_note",
	description: "Create or append to this week's weekly note.",
	parameters: [
		{ name: "content", type: "string", description: "Content to add to the weekly note", required: true },
		{ name: "prepend", type: "boolean", description: "If true, add at the top", required: false },
	],
	async execute(args, ctx): Promise<ToolResult> {
		const content = String(args["content"] ?? "");
		const prepend = Boolean(args["prepend"] ?? false);
		const { year, week } = getISOWeek(new Date());
		const weekStr = `W${String(week).padStart(2, "0")}`;
		const folder = ctx.settings.weeklyNoteFolder ?? "Weekly";
		const path = joinPath(folder, `${year}-${weekStr}.md`);
		const existing = ctx.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const old = await ctx.vault.cachedRead(existing);
			const updated = prepend ? content + "\n\n" + old : old + (old.endsWith("\n") ? "\n" : "\n\n") + content;
			await ctx.vault.modify(existing, updated);
			return { success: true, output: `Updated weekly note \`${path}\``, affectedFile: path };
		}
		await ensureFolder(ctx, path);
		const header = `# Weekly Note — ${year} ${weekStr}\n\n`;
		await ctx.vault.create(path, header + content);
		return { success: true, output: `Created weekly note \`${path}\``, affectedFile: path };
	},
};

export const listNotesTool: Tool = {
	name: "list_notes",
	description: "List all markdown notes in the vault, optionally filtered by folder.",
	parameters: [
		{ name: "folder", type: "string", description: "Optional folder path to filter by", required: false },
	],
	async execute(args, ctx): Promise<ToolResult> {
		const folder = args["folder"] ? String(args["folder"]) : null;
		const files = ctx.vault.getMarkdownFiles();
		const filtered = folder ? files.filter((f) => f.path.startsWith(folder)) : files;
		if (filtered.length === 0) return { success: true, output: "No notes found." };
		return { success: true, output: filtered.map((f) => f.path).join("\n") };
	},
};

export const searchVaultTool: Tool = {
	name: "search_vault",
	description: "Semantically search the vault for notes related to a query.",
	parameters: [
		{ name: "query", type: "string", description: "The search query", required: true },
		{ name: "top_k", type: "number", description: "Number of results (default 5)", required: false },
	],
	async execute(args, ctx): Promise<ToolResult> {
		const query = String(args["query"] ?? "");
		const origTopK = ctx.settings.topK;
		const reqK = args["top_k"] ? Number(args["top_k"]) : origTopK;
		ctx.settings.topK = reqK;
		const results = await ctx.retriever.retrieve(query);
		ctx.settings.topK = origTopK;
		if (results.length === 0) return { success: true, output: "No relevant results found." };
		const formatted = results.map((r, i) =>
			`[${i + 1}] ${r.filePath} (score: ${r.score.toFixed(3)})\n${r.text.slice(0, 300)}...`
		).join("\n\n");
		return { success: true, output: formatted };
	},
};

export const openNoteTool: Tool = {
	name: "open_note",
	description: "Open a note in the Obsidian editor.",
	parameters: [{ name: "path", type: "string", description: "Note path to open", required: true }],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const file = ctx.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { success: false, output: `Note not found: ${path}` };
		await ctx.app.workspace.openLinkText(path, "", false);
		return { success: true, output: `Opened \`${path}\`` };
	},
};

export const moveRenameNoteTool: Tool = {
	name: "move_rename_note",
	description: "Move or rename a note. This safely updates Wikipedia-style links across the entire vault automatically.",
	parameters: [
		{ name: "path", type: "string", description: "Current note path", required: true },
		{ name: "new_path", type: "string", description: "New path/name for the note", required: true }
	],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const newPath = normPath(String(args["new_path"] ?? ""));
		const file = ctx.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { success: false, output: `Note not found: ${path}` };
		if (ctx.vault.getAbstractFileByPath(newPath)) return { success: false, output: `Destination already exists: ${newPath}` };
		
		await ensureFolder(ctx, newPath);
		await ctx.app.fileManager.renameFile(file, newPath);
		return { success: true, output: `Successfully moved/renamed ${path} -> ${newPath}`, affectedFile: newPath };
	}
};

export const archiveNoteTool: Tool = {
	name: "archive_note",
	description: "Archive a note safely instead of deleting it. Moves the note to the hidden .obsidian/archive folder.",
	parameters: [{ name: "path", type: "string", description: "Path of the note to archive", required: true }],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const file = ctx.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { success: false, output: `Note not found: ${path}` };
		
		const destDir = ".obsidian/archive";
		const destPath = `${destDir}/${file.name}`;
		
		const adapter = ctx.vault.adapter;
		if (!(await adapter.exists(destDir))) {
            await adapter.mkdir(destDir);
		}
		
        let finalPath = destPath;
        let counter = 1;
        while (await adapter.exists(finalPath)) {
            const spl = file.name.split(".");
            const ext = spl.pop();
            const base = spl.join(".");
            finalPath = `${destDir}/${base}_${counter}.${ext}`;
            counter++;
        }
        
        const content = await adapter.read(file.path);
        await adapter.write(finalPath, content);
        await ctx.vault.delete(file);
		
		return { success: true, output: `Archived \`${path}\` to ${finalPath}.` };
	}
};

export const updateFrontmatterTool: Tool = {
	name: "update_frontmatter",
	description: "Safely inject or update metadata properties (YAML frontmatter) in a note. Helpful for dynamically updating logical graph nodes and concepts.",
	parameters: [
		{ name: "path", type: "string", description: "Note path", required: true },
		{ name: "properties", type: "string", description: "A stringified JSON map of keys and values to inject or overwrite. For example, '{\"logical_nodes\": [\"A\", \"B\"]}'.", required: true }
	],
	async execute(args, ctx): Promise<ToolResult> {
		const path = normPath(String(args["path"] ?? ""));
		const file = ctx.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { success: false, output: `Note not found: ${path}` };
		
		let props: Record<string, unknown>;
		try {
			props = JSON.parse(String(args["properties"] ?? "{}"));
		} catch {
			return { success: false, output: "Properties must be a valid JSON string." };
		}

		await ctx.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const [k, v] of Object.entries(props)) {
				fm[k] = v;
			}
		});
		return { success: true, output: `Updated properties for \`${path}\`.`, affectedFile: path };
	}
};

export const getKnowledgeGraphTool: Tool = {
	name: "get_knowledge_graph",
	description: "Scan the entire vault and aggregate meta knowledge-graph nodes from note frontmatter.",
	parameters: [],
	async execute(args, ctx): Promise<ToolResult> {
		const files = ctx.vault.getMarkdownFiles();
		const graph: Record<string, unknown> = {};
		
		for (const f of files) {
			const cache = ctx.app.metadataCache.getFileCache(f);
			if (cache && cache.frontmatter) {
				// Clone to avoid mutation and strip raw Position data
				const copy = { ...cache.frontmatter };
				delete copy.position;
				graph[f.path] = copy;
			}
		}
		
		if (Object.keys(graph).length === 0) return { success: true, output: "No frontmatter properties found in the vault." };
		return { success: true, output: JSON.stringify(graph, null, 2) };
	}
};

export function registerAllTools(registry: import("./registry").ToolRegistry): void {
	registry.register(readNoteTool);
	registry.register(writeNoteTool);
	registry.register(appendToNoteTool);
	registry.register(createNoteTool);
	registry.register(createDailyNoteTool);
	registry.register(createWeeklyNoteTool);
	registry.register(listNotesTool);
	registry.register(searchVaultTool);
	registry.register(openNoteTool);
	registry.register(moveRenameNoteTool);
	registry.register(archiveNoteTool);
	registry.register(updateFrontmatterTool);
	registry.register(getKnowledgeGraphTool);
}
