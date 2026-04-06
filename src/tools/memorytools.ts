import { TFile } from "obsidian";
import type { Tool, ToolResult } from "./types";
import { cosineSimilarity } from "../vectorstore";
import { ensureFolder } from "./notetools";

function normPath(p: string): string {
    if (p.startsWith("/")) return p.substring(1);
    return p;
}

export const getTemporalContextTool: Tool = {
	name: "get_temporal_context",
	description: "Retrieve notes using an episodic memory model. Applies an exponential decay weight to older notes based on their creation and modification times, preventing stale context from drowning out new architecture.",
	parameters: [
		{ name: "query", type: "string", description: "The search concept to embed and query against the vault", required: true },
		{ name: "top_k", type: "number", description: "Number of top results to return", required: false }
	],
	async execute(args, ctx): Promise<ToolResult> {
		const query = String(args["query"] ?? "");
		const topK = Number(args["top_k"] ?? 5);

		if (!query) return { success: false, output: "Query is required" };

		const texts = ["search_document: " + query];
		const embeddings = await ctx.ollama.embed(ctx.settings.embeddingModel, texts);
		const qEmbed = embeddings[0];
		if (!qEmbed || qEmbed.length === 0) return { success: false, output: "Failed to generate query embedding." };

		const entries = ctx.retriever.getStore().getAllEntries();
		const now = Date.now();
        
        // 10% decay per 30 days => lambda = -ln(0.9) / 30 ≈ 0.00351
		const decayRate = 0.00351;

		const scored = entries.map(e => {
			const rawScore = cosineSimilarity(qEmbed, e.embedding);
			const mtime = e.lastModified;
			const ctime = e.ctime || mtime; // Fallback entirely to mtime if ctime is mysteriously unavailable
			
            // Use Math.max of creating and modification time so frequently updated files stay "young"
			const ageMs = now - Math.max(ctime, mtime);
			const ageDays = ageMs / (1000 * 60 * 60 * 24);
			
			// Compute decayed score
			const decay = Math.exp(-decayRate * ageDays);
			const decayedScore = rawScore * decay;
			
			return { entry: e, score: decayedScore, rawScore, ageDays };
		});

		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, topK);

		const resultChunks = top.map(s => {
			return `[File: ${s.entry.filePath} | Age: ${Math.round(s.ageDays)}d | Decayed Context Score: ${s.score.toFixed(3)}]\n${s.entry.text}`;
		}).join("\n\n---\n\n");

		if (resultChunks.length === 0) return { success: true, output: "No context found." };
		return { success: true, output: resultChunks };
	}
};

export const compressClusterTool: Tool = {
	name: "compress_cluster",
	description: "Consolidate a cluster of disparate notes into a highly-dense memory node block. Saves the summary to the hidden memory directory.",
	parameters: [
		{ name: "file_paths", type: "string", description: "Comma-separated list of file paths to cluster and compress.", required: true },
		{ name: "concept_name", type: "string", description: "The overarching theme or concept linking these files.", required: true }
	],
	async execute(args, ctx): Promise<ToolResult> {
		const rawPaths = String(args["file_paths"] ?? "").split(",").map(p => normPath(p.trim())).filter(p => p.length > 0);
		const concept = String(args["concept_name"] ?? "memory_cluster");

		if (rawPaths.length === 0) return { success: false, output: "No file paths provided." };

		let context = "";
		let filesHit = 0;
		for (const path of rawPaths) {
			const file = ctx.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				context += `\n\n--- [FILE: ${path}] ---\n`;
				context += await ctx.vault.cachedRead(file);
				filesHit++;
			}
		}

		if (filesHit === 0) return { success: false, output: "Failed to read any of the provided files." };

		const prompt = `You are a memory consolidation engine. Your task is to extract the core axioms, facts, and themes from the following clustered notes regarding the concept: "${concept}". 
Create a highly dense, hierarchical summary that strips out daily minutiae and redundancy. Format as pure markdown without conversational padding.

<notes>
${context}
</notes>`;

		let summary = "";
		await ctx.ollama.chat(ctx.settings.chatModel, [{ role: "user", content: prompt }], token => { summary += token; });
		
		const dir = ".pensieve/memory_nodes";
		const adapter = ctx.vault.adapter;
		
		if (!(await adapter.exists(".pensieve"))) {
			await adapter.mkdir(".pensieve");
		}
		if (!(await adapter.exists(dir))) {
			await adapter.mkdir(dir);
		}

		const safeConcept = concept.replace(/[^a-zA-Z0-9_\-\ ]/g, "_").trim();
		let finalDest = `${dir}/${safeConcept}.md`;
		
		let counter = 1;
		while (await adapter.exists(finalDest)) {
			finalDest = `${dir}/${safeConcept}_${counter}.md`;
			counter++;
		}

		await adapter.write(finalDest, summary);

		// Since .pensieve is hidden, we manually inject it into the VectorStore here so temporal_context sees it immediately!
		try {
			const chunks = (await import("../chunker")).chunkMarkdown(summary, ctx.settings.chunkSize, ctx.settings.chunkOverlap);
			const texts = chunks.map(c => "search_document: " + c.text);
			const embeds = await ctx.ollama.embed(ctx.settings.embeddingModel, texts);
			
			const entries = chunks.map((c, i) => ({
				id: `${finalDest}::${i}`,
				filePath: finalDest,
				chunkIndex: i,
				text: c.text,
				embedding: embeds[i] ?? [],
				lastModified: Date.now(),
				ctime: Date.now()
			}));
			ctx.retriever.getStore().addEntries(entries);
		} catch (e) {
			console.error("[Pensieve] Failed to manually index memory node", e);
		}

		return { success: true, output: `Compressed ${filesHit} notes successfully into episodic memory block: ${finalDest}` };
	}
};

export function registerMemoryTools(registry: import("./registry").ToolRegistry): void {
	registry.register(getTemporalContextTool);
	registry.register(compressClusterTool);
}
