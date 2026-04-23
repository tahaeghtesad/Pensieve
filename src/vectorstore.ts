import { Notice } from "obsidian";

/** A single stored vector entry. */
export interface VectorEntry {
	id: string;
	filePath: string;
	text: string;
	embedding: number[];
	lastModified: number;
	ctime?: number; // Optional for backward compatibility with existing vector index
}

/** A scored search result. */
export interface ScoredEntry {
	entry: VectorEntry;
	score: number;
}

/** Serialized form (for JSON persistence). */
interface VectorStoreData {
	version: number;
	entries: VectorEntry[];
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value in [-1, 1]; higher = more similar.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let magA = 0;
	let magB = 0;

	for (let i = 0; i < a.length; i++) {
		const ai = a[i] ?? 0;
		const bi = b[i] ?? 0;
		dot += ai * bi;
		magA += ai * ai;
		magB += bi * bi;
	}

	magA = Math.sqrt(magA);
	magB = Math.sqrt(magB);

	if (magA === 0 || magB === 0) return 0;
	return dot / (magA * magB);
}

/**
 * In-memory vector store with cosine-similarity search and
 * JSON persistence via Obsidian's DataAdapter.
 */
export class VectorStore {
	private entries: VectorEntry[] = [];

	/** Total number of entries currently stored. */
	get size(): number {
		return this.entries.length;
	}

	/** Add one or more entries. */
	addEntries(entries: VectorEntry[]): void {
		this.entries.push(...entries);
	}

	/** Return all entries currently stored for global clustering or analysis. */
	getAllEntries(): VectorEntry[] {
		return Array.from(this.entries);
	}

	/** Remove all entries referencing a given file path. */
	removeByFile(filePath: string): void {
		this.entries = this.entries.filter((e) => e.filePath !== filePath);
	}

	/** Check whether a file is already indexed at a given mtime. */
	hasFile(filePath: string, lastModified: number): boolean {
		return this.entries.some(
			(e) => e.filePath === filePath && e.lastModified >= lastModified
		);
	}

	/** Return all distinct file paths currently stored. */
	getIndexedFiles(): Set<string> {
		return new Set(this.entries.map((e) => e.filePath));
	}

	/**
	 * Search for the top-K most similar entries to the query embedding.
	 * Non-blocking: yields to the event loop between batches to prevent UI freezing.
	 */
	async search(queryEmbedding: number[], topK: number): Promise<ScoredEntry[]> {
		const BATCH_SIZE = 500;
		const topResults: ScoredEntry[] = [];
		let minTopScore = -Infinity;

		for (let i = 0; i < this.entries.length; i += BATCH_SIZE) {
			const end = Math.min(i + BATCH_SIZE, this.entries.length);

			for (let j = i; j < end; j++) {
				const entry = this.entries[j]!;
				const score = cosineSimilarity(queryEmbedding, entry.embedding);

				if (topResults.length < topK) {
					topResults.push({ entry, score });
					if (topResults.length === topK) {
						topResults.sort((a, b) => b.score - a.score);
						minTopScore = topResults[topResults.length - 1]!.score;
					}
				} else if (score > minTopScore) {
					// Replace the lowest-scoring entry
					topResults[topResults.length - 1] = { entry, score };
					topResults.sort((a, b) => b.score - a.score);
					minTopScore = topResults[topResults.length - 1]!.score;
				}
			}

			// Yield to event loop between batches to prevent UI freezing
			if (end < this.entries.length) {
				await new Promise<void>(r => setTimeout(r, 0));
			}
		}

		topResults.sort((a, b) => b.score - a.score);
		return topResults;
	}

	/** Serialize to JSON string. */
	serialize(): string {
		const data: VectorStoreData = {
			version: 1,
			entries: this.entries,
		};
		return JSON.stringify(data);
	}

	/** Deserialize from JSON string. */
	static deserialize(json: string): VectorStore {
		const store = new VectorStore();
		try {
			const data = JSON.parse(json) as VectorStoreData;
			if (data.version === 1 && Array.isArray(data.entries)) {
				store.entries = data.entries;
			}
		} catch (e) {
			console.error("[Pensieve] Corrupt vector index:", e);
			new Notice("Pensieve Error: Corrupt vector index — starting with empty store. " + (e instanceof Error ? e.message : String(e)), 5000);
		}
		return store;
	}

	/** Clear all entries. */
	clear(): void {
		this.entries = [];
	}
}
