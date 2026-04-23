import { TFile, Vault, Notice } from "obsidian";
import { OllamaService } from "./ollama";
import { VectorStore, VectorEntry } from "./vectorstore";
import type { PensieveSettings } from "./settings";

const INDEX_FILE = "pensieve-index.json";
const EMBED_BATCH_SIZE = 1; // Batch size 1 because we are sending entire unchunked files now

/** Folders excluded from indexing — templates, config, internal data. */
const EXCLUDED_FOLDERS = [".obsidian/", ".pensieve/", "templates/"];

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

	public progressStatus = "";
	public progressCurrent = 0;
	public progressTotal = 0;
	private progressListeners: IndexProgressCallback[] = [];

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

	public addProgressListener(cb: IndexProgressCallback): void {
		this.progressListeners.push(cb);
	}

	public removeProgressListener(cb: IndexProgressCallback): void {
		this.progressListeners = this.progressListeners.filter((l) => l !== cb);
	}

	private emitProgress(status: string, current: number, total: number): void {
		this.progressStatus = status;
		this.progressCurrent = current;
		this.progressTotal = total;
		for (const listener of this.progressListeners) {
			listener(status, current, total);
		}
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
				const loaded = VectorStore.deserialize(raw);

				// Detect stale indexes from before we removed chunking.
				// If any entry has chunkIndex (which no longer exists on the type but might in JSON),
				// the entire index is from the old era and will produce garbage retrieval results.
				const hasOldEntries = loaded.getAllEntries().some((e: any) => e.chunkIndex !== undefined);
				if (hasOldEntries) {
					console.log("[Pensieve] Stale index detected — clearing. A full re-index is needed.");
					new Notice("Pensieve: Old index detected. Please re-index your vault (click the refresh icon).", 8000);
					this.vectorStore = new VectorStore();
					// Delete the stale file
					await adapter.remove(indexPath);
					return;
				}

				this.vectorStore = loaded;
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
			const files = this.vault.getMarkdownFiles()
				.filter(f => !EXCLUDED_FOLDERS.some(ex => f.path.toLowerCase().startsWith(ex)));
			const total = files.length;
			let current = 0;

			// User requested: old indexes should automatically be removed on refresh.
			this.vectorStore.clear();
			await this.saveIndex();

			// Batch of documents waiting to be embedded
			let pendingDocs: {
				filePath: string;
				text: string;
				lastModified: number;
				ctime: number;
			}[] = [];

			const flushPending = async () => {
				if (pendingDocs.length === 0) return;

				// Batch embed
				const texts = pendingDocs.map(
					(doc) => "search_document: " + doc.text
				);
				
				let embeddings: number[][] = [];
				try {
					embeddings = await this.ollama.embed(
						this.settings.embeddingModel,
						texts
					);
				} catch (e: any) {
					// Fallback for 400 errors (context window exceeded for massive files)
					if (e.message && e.message.includes("400")) {
						console.warn("[Pensieve] 400 Error on full file embed. Truncating to 50,000 chars and retrying...", e);
						const truncatedTexts = texts.map(t => t.substring(0, 50000));
						embeddings = await this.ollama.embed(
							this.settings.embeddingModel,
							truncatedTexts
						);
					} else {
						throw e;
					}
				}

				const entries: VectorEntry[] = pendingDocs.map((doc, i) => ({
					id: doc.filePath,
					filePath: doc.filePath,
					text: doc.text,
					embedding: embeddings[i] ?? [],
					lastModified: doc.lastModified,
					ctime: doc.ctime,
				}));

				this.vectorStore.addEntries(entries);
				pendingDocs = [];
			};

			for (const file of files) {
				current++;
				this.emitProgress(
					`Indexing: ${file.path}`,
					current,
					total
				);
				onProgress?.(`Indexing: ${file.path}`, current, total);

				// Since we cleared the index above, we don't need to skip unchanged files
				// or remove them here. We just index everything fresh.
				const content = await this.vault.cachedRead(file);
				const noteText = content.trim() || "Empty note";

				pendingDocs.push({
					filePath: file.path,
					text: noteText,
					lastModified: file.stat.mtime,
					ctime: file.stat.ctime,
				});

				if (pendingDocs.length >= EMBED_BATCH_SIZE) {
					await flushPending();
				}
			}

			// Flush remaining
			await flushPending();
			await this.saveIndex();

			this.emitProgress("Indexing complete", total, total);
			onProgress?.("Indexing complete", total, total);
			new Notice(
				`Pensieve: Indexed ${total} files (${this.vectorStore.size} documents)`
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
		if (EXCLUDED_FOLDERS.some(ex => file.path.toLowerCase().startsWith(ex))) return;

		try {
			this.vectorStore.removeByFile(file.path);
			const content = await this.vault.cachedRead(file);
			const noteText = content.trim() || "Empty note";

			if (!noteText) return;

			const texts = ["search_document: " + noteText];
			
			let embeddings: number[][] = [];
			try {
				embeddings = await this.ollama.embed(
					this.settings.embeddingModel,
					texts
				);
			} catch (e: any) {
				if (e.message && e.message.includes("400")) {
					console.warn(`[Pensieve] 400 Error indexing ${file.path}. Truncating to 50,000 chars and retrying...`);
					const truncatedTexts = texts.map(t => t.substring(0, 50000));
					embeddings = await this.ollama.embed(
						this.settings.embeddingModel,
						truncatedTexts
					);
				} else {
					throw e;
				}
			}

			const entries: VectorEntry[] = [{
				id: file.path,
				filePath: file.path,
				text: noteText,
				embedding: embeddings[0] ?? [],
				lastModified: file.stat.mtime,
				ctime: file.stat.ctime,
			}];

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
