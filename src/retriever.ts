import { OllamaService, OllamaMessage } from "./ollama";
import { VectorStore, ScoredEntry } from "./vectorstore";
import type { PensieveSettings } from "./settings";

/** A retrieved document with its source info and relevance score. */
export interface RetrievedDocument {
	text: string;
	filePath: string;
	score: number;
}

export class Retriever {
	private ollama: OllamaService;
	private vectorStore: VectorStore;
	private settings: PensieveSettings;

	constructor(
		ollama: OllamaService,
		vectorStore: VectorStore,
		settings: PensieveSettings
	) {
		this.ollama = ollama;
		this.vectorStore = vectorStore;
		this.settings = settings;
	}

	/** Update the vector store reference (after re-indexing). */
	setVectorStore(store: VectorStore): void {
		this.vectorStore = store;
	}

	getStore(): VectorStore {
		return this.vectorStore;
	}

	/**
	 * Retrieve the top-K most relevant documents for a given query.
	 */
	async retrieve(query: string): Promise<RetrievedDocument[]> {
		if (this.vectorStore.size === 0) {
			return [];
		}

		// Embed the query with the search_query prefix for nomic
		const embeddings = await this.ollama.embed(
			this.settings.embeddingModel,
			["search_query: " + query]
		);

		const queryEmbedding = embeddings[0];
		if (!queryEmbedding) return [];

		const results: ScoredEntry[] = await this.vectorStore.search(
			queryEmbedding,
			this.settings.topK
		);

		return results.map((r) => ({
			text: r.entry.text,
			filePath: r.entry.filePath,
			score: r.score,
		}));
	}

	/**
	 * Format retrieved documents into a context block that's included in the
	 * system/user message to the LLM.
	 */
	buildContext(docs: RetrievedDocument[]): string {
		if (docs.length === 0) return "";

		const sections = docs.map((doc, i) => {
			return `--- Context ${i + 1} (from [[${doc.filePath}]], relevance: ${doc.score.toFixed(3)}) ---\n${doc.text}`;
		});

		return (
			"\n\nThe following context from the user's vault is relevant to their question:\n\n" +
			sections.join("\n\n") +
			"\n\n--- End of context ---\n"
		);
	}

	/**
	 * Assemble the full message array for the chat API call.
	 * Injects retrieved context into the system prompt.
	 */
	buildMessages(
		systemPrompt: string,
		context: string,
		chatHistory: OllamaMessage[],
		userQuery: string
	): OllamaMessage[] {
		const messages: OllamaMessage[] = [];
		messages.push({ role: "system", content: systemPrompt });

		const maxHist = this.settings.maxChatHistory;
		const historySlice =
			chatHistory.length > maxHist
				? chatHistory.slice(chatHistory.length - maxHist)
				: chatHistory;

		messages.push(...historySlice);

		const finalContent = context
			? `${context}\n\n**User Question:**\n${userQuery}`
			: userQuery;

		messages.push({ role: "user", content: finalContent });

		return messages;
	}
}
