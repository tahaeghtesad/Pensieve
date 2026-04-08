import { TFile, Vault, Notice } from "obsidian";
import { OllamaService } from "./ollama";
import { chunkMarkdown } from "./chunker";
import { VectorStore, VectorEntry } from "./vectorstore";
import type { PensieveSettings } from "./settings";

const INDEX_FILE = "pensieve-index.json";
const EMBED_BATCH_SIZE = 32;

export type IndexProgressCallback = (
	status: string,
	current: number,
	total: number
) => void;

/**
 * Coordinates the vault-indexing pipeline:
 * read files → chunk → embed → store in vector store.
 */
export class VaultIndexer {
	private vault: Vault;
	private ollama: OllamaService;
	private settings: PensieveSettings;
	public vectorStore: VectorStore;
	private indexing = false;

	constructor(
		vault: Vault,
		ollama: OllamaService,
		settings: PensieveSettings
	) {
		this.vault = vault;
		this.ollama = ollama;
		this.settings = settings;
		this.vectorStore = new VectorStore();
	}

	get isIndexing(): boolean {
		return this.indexing;
	}

	/**
	 * Load a previously saved index from the vault's config directory.
	 */
	async loadIndex(): Promise<void> {
		try {
			const adapter = this.vault.adapter;
			const configDir = this.vault.configDir; // .obsidian
			const indexPath = `${configDir}/plugins/pensieve/${INDEX_FILE}`;
			if (await adapter.exists(indexPath)) {
				const raw = await adapter.read(indexPath);
				this.vectorStore = VectorStore.deserialize(raw);
				console.log(
					`[Pensieve] Loaded index with ${this.vectorStore.size} entries`
				);
			}
		} catch (e) {
			console.error("[Pensieve] Failed to load index:", e);
			new Notice("Pensieve Error: Failed to load index — " + (e instanceof Error ? e.message : String(e)), 5000);
		}
	}

	/**
	 * Save the current index to disk.
	 */
	async saveIndex(): Promise<void> {
		try {
			const adapter = this.vault.adapter;
			const configDir = this.vault.configDir;
			const dir = `${configDir}/plugins/pensieve`;
			if (!(await adapter.exists(dir))) {
				await adapter.mkdir(dir);
			}
			await adapter.write(
				`${dir}/${INDEX_FILE}`,
				this.vectorStore.serialize()
			);
		} catch (e) {
			console.error("[Pensieve] Failed to save index:", e);
			new Notice("Pensieve Error: Failed to save index — " + (e instanceof Error ? e.message : String(e)), 5000);
		}
	}

	/**
	 * Full vault re-index. Skips files whose mtime hasn't changed.
	 */
	async indexVault(onProgress?: IndexProgressCallback): Promise<void> {
		if (this.indexing) {
			new Notice("Pensieve: Indexing is already in progress.");
			return;
		}

		this.indexing = true;

		try {
			const files = this.vault.getMarkdownFiles();
			const total = files.length;
			let current = 0;

			// Remove entries for deleted files
			const currentPaths = new Set(files.map((f) => f.path));
			for (const indexed of this.vectorStore.getIndexedFiles()) {
				if (!currentPaths.has(indexed)) {
					this.vectorStore.removeByFile(indexed);
				}
			}

			// Batch of chunks waiting to be embedded
			let pendingChunks: {
				filePath: string;
				chunkIndex: number;
				text: string;
				lastModified: number;
				ctime: number;
			}[] = [];

			const flushPending = async () => {
				if (pendingChunks.length === 0) return;

				// Batch embed
				const texts = pendingChunks.map(
					(c) => "search_document: " + c.text
				);
				const embeddings = await this.ollama.embed(
					this.settings.embeddingModel,
					texts
				);

				const entries: VectorEntry[] = pendingChunks.map((c, i) => ({
					id: `${c.filePath}::${c.chunkIndex}`,
					filePath: c.filePath,
					chunkIndex: c.chunkIndex,
					text: c.text,
					embedding: embeddings[i] ?? [],
					lastModified: c.lastModified,
					ctime: c.ctime,
				}));

				this.vectorStore.addEntries(entries);
				pendingChunks = [];
			};

			for (const file of files) {
				current++;
				onProgress?.(
					`Indexing: ${file.path}`,
					current,
					total
				);

				// Skip unchanged files
				if (
					this.vectorStore.hasFile(file.path, file.stat.mtime)
				) {
					continue;
				}

				// Re-index this file
				this.vectorStore.removeByFile(file.path);
				const content = await this.vault.cachedRead(file);
				const chunks = chunkMarkdown(
					content,
					this.settings.chunkSize,
					this.settings.chunkOverlap
				);

				for (let ci = 0; ci < chunks.length; ci++) {
					const chunk = chunks[ci];
					if (!chunk) continue;

					pendingChunks.push({
						filePath: file.path,
						chunkIndex: ci,
						text: chunk.text,
						lastModified: file.stat.mtime,
						ctime: file.stat.ctime,
					});

					if (pendingChunks.length >= EMBED_BATCH_SIZE) {
						await flushPending();
					}
				}
			}

			// Flush remaining
			await flushPending();
			await this.saveIndex();

			onProgress?.("Indexing complete", total, total);
			new Notice(
				`Pensieve: Indexed ${total} files (${this.vectorStore.size} chunks)`
			);
		} catch (e) {
			console.error("[Pensieve] Indexing error:", e);
			new Notice(`Pensieve: Indexing failed — ${e}`);
		} finally {
			this.indexing = false;
		}
	}

	/**
	 * Incrementally index a single file that was created or modified.
	 */
	async indexFile(file: TFile): Promise<void> {
		if (file.extension !== "md") return;

		try {
			this.vectorStore.removeByFile(file.path);
			const content = await this.vault.cachedRead(file);
			const chunks = chunkMarkdown(
				content,
				this.settings.chunkSize,
				this.settings.chunkOverlap
			);

			if (chunks.length === 0) return;

			const texts = chunks.map((c) => "search_document: " + c.text);
			const embeddings = await this.ollama.embed(
				this.settings.embeddingModel,
				texts
			);

			const entries: VectorEntry[] = chunks.map((c, i) => ({
				id: `${file.path}::${i}`,
				filePath: file.path,
				chunkIndex: i,
				text: c.text,
				embedding: embeddings[i] ?? [],
				lastModified: file.stat.mtime,
				ctime: file.stat.ctime,
			}));

			this.vectorStore.addEntries(entries);
			await this.saveIndex();
		} catch (e) {
			console.error(`[Pensieve] Failed to index ${file.path}:`, e);
			new Notice("Pensieve Error: Failed to index " + file.path + " — " + (e instanceof Error ? e.message : String(e)), 5000);
		}
	}

	/**
	 * Remove a file from the index.
	 */
	async onFileDelete(filePath: string): Promise<void> {
		this.vectorStore.removeByFile(filePath);
		await this.saveIndex();
	}
}
