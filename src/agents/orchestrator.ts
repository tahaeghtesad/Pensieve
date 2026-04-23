import type { OllamaService } from "../ollama";
import type { PensieveSettings } from "../settings";
import { DirectChatAgent } from "./directchat";
import { EditorAgent } from "./editor";
import { LibrarianAgent } from "./librarian";
import { ResearcherAgent } from "./researcher";
import type { AgentContext, AgentResult, IntentType, ReActAgent } from "./types";

const CLASSIFY_PROMPT = `You are a task classifier. Classify the user's request into exactly one category.

Categories:
- direct_chat: General questions, asking about notes, conversation, no modifications needed
- editor: Creating notes, writing, editing, planning, reviewing, summarizing, evaluating, fact-checking, daily/weekly notes
- librarian: Organizing vault structure, maintaining notes, linting frontmatter, orphan cleanup, knowledge graph extraction, archiving old notes, format governance, deduplication
- researcher: Web research, reading URLs, ingesting articles, brainstorming, exploring structural gaps, discovering new angles

Respond with ONLY the category name. Nothing else.`;

export class Orchestrator {
		private agents: Map<IntentType, ReActAgent>;
	private ollama: OllamaService;
	settings: PensieveSettings;

	constructor(ollama: OllamaService, settings: PensieveSettings) {
		this.ollama = ollama;
		this.settings = settings;
		this.agents = new Map<IntentType, ReActAgent>([
			["direct_chat", new DirectChatAgent()],
			["editor", new EditorAgent()],
			["librarian", new LibrarianAgent()],
			["researcher", new ResearcherAgent()],
		]);
	}

	updateSettings(settings: PensieveSettings): void {
		this.settings = settings;
	}

	async classify(query: string, abortSignal?: { aborted: boolean }): Promise<IntentType> {
		if (!this.settings.agentEnabled) return "direct_chat";

		// ── Fast-path: URL detection routes immediately to Researcher ──
		const urlPattern = /https?:\/\/[^\s]+/i;
		const urlKeywords = /(read this link|read this url|ingest this|read this page|summarize this link|research this url|research this link)/i;
		if (urlPattern.test(query) || urlKeywords.test(query)) {
			return "researcher";
		}

		let response = "";
		try {
			await this.ollama.chat(
				this.settings.chatModel,
				[
					{ role: "system", content: CLASSIFY_PROMPT },
					{ role: "user", content: query },
				],
				(token) => { response += token; },
				abortSignal
			);
		} catch {
			return "direct_chat";
		}

		const valid: IntentType[] = ["direct_chat", "editor", "librarian", "researcher"];
		const raw = response.trim().toLowerCase();

		// Pass 1: exact match after stripping non-alpha
		const stripped = raw.replace(/[^a-z_]/g, "");
		if (valid.includes(stripped as IntentType)) return stripped as IntentType;

		// Pass 2: scan for embedded intent string
		// To avoid matching echoed prompt text (e.g., "Categories are direct_chat, editor... The answer is editor"),
		// we find all matches and pick the one that appears last in the response.
		const foundIntents = valid.filter(intent => raw.includes(intent));
		if (foundIntents.length === 1) {
			return foundIntents[0] as IntentType;
		} else if (foundIntents.length > 1) {
			// Sort by last index of occurrence and pick the last one
			const lastFound = foundIntents.sort((a, b) => raw.lastIndexOf(a) - raw.lastIndexOf(b)).pop();
			if (lastFound) return lastFound as IntentType;
		}

		// Keyword fallback
		const q = query.toLowerCase();
		if (/(explore|discover|brainstorm|gap|structural hole|connect idea|new angle|research angle|novelty)/.test(q)) return "researcher";
		if (/(read this|ingest|research|url|http|webpage|article|link)/.test(q)) return "researcher";
		if (/(organize|move|rename|folder|restructure|architect|zettelkasten|para)/.test(q)) return "librarian";
		if (/(garden|lint|orphan|cleanup|clean up|deduplic|vault health|fix links|broken links|reparent)/.test(q)) return "librarian";
		if (/(compress|consolidate|archive|memory|temporal|decay|old notes)/.test(q)) return "librarian";
		if (/(synthesize|atomic|split|extract|graph|topic|theme|concept|triplet|ontol)/.test(q)) return "librarian";
		if (/(markdown format|wiki format|frontmatter|temporal schema|chronology|migrate notes|normalize tags|strict format)/.test(q)) return "librarian";
		if (/(create|add|write|append|update|edit|daily note|weekly note|jot down)/.test(q)) return "editor";
		if (/(plan|break down|steps|roadmap|outline|structure)/.test(q)) return "editor";
		if (/(review|summarize|evaluate|assess|analyze|improve|feedback)/.test(q)) return "editor";
		if (/(fact.?check|verify|validate|confirm|is.*true|check.*claim)/.test(q)) return "editor";

		return "direct_chat";
	}

	async runAgent(intent: IntentType, ctx: AgentContext): Promise<AgentResult> {
		const agent = this.agents.get(intent);
		if (!agent) {
			return { answer: "No agent available for this task.", traceSteps: [], affectedFiles: [] };
		}

		// Emit handoff trace step
		ctx.onTrace({
			type: "agent_handoff",
			content: `Routing to **${agent.agentName}** agent`,
		});

		return agent.run(ctx);
	}

	/**
	 * Run an agent with optional Reflexion (self-correction).
	 * After the Editor agent completes a writing task, a one-shot critic prompt
	 * evaluates the draft. If issues are found, the Editor re-runs once with feedback.
	 */
	async runAgentWithReflection(intent: IntentType, ctx: AgentContext): Promise<AgentResult> {
		const result = await this.runAgent(intent, ctx);

		// Only apply reflection to Editor tasks that produced files
		if (intent !== "editor" || result.affectedFiles.length === 0 || result.needsUserInput) {
			return result;
		}

		// Run a one-shot critic evaluation
		ctx.onTrace({ type: "observation", content: "🔍 Running self-correction check on draft..." });

		const criticPrompt = `You are a strict but fair quality reviewer. Evaluate the following draft response for:
1. Logical errors or contradictions
2. Missing critical information
3. Structural problems (missing sections, poor formatting)
4. Factual claims without evidence

If the draft is acceptable, respond with exactly: APPROVED
If there are issues, respond with: REVISION NEEDED: followed by a concise list of specific issues to fix.

Draft to evaluate:
${result.answer}`;

		let criticResponse = "";
		try {
			await this.ollama.chat(
				this.settings.chatModel,
				[{ role: "user", content: criticPrompt }],
				(token) => { criticResponse += token; }
			);
		} catch {
			// If critic fails, just return the original result
			return result;
		}

		const normalized = criticResponse.trim().toUpperCase();
		if (normalized.startsWith("APPROVED") || !normalized.includes("REVISION NEEDED")) {
			ctx.onTrace({ type: "observation", content: "✅ Self-correction check passed." });
			return result;
		}

		// Critic found issues — re-run the Editor with feedback (1 reflection max)
		ctx.onTrace({ type: "observation", content: `⚠️ Critic feedback: ${criticResponse.trim().slice(0, 200)}` });

		const revisedCtx: AgentContext = {
			...ctx,
			userQuery: `[REVISION REQUEST] Your previous draft had issues. Fix them and try again.\n\nCritic feedback: ${criticResponse.trim()}\n\nOriginal instructions: ${ctx.userQuery}`,
		};

		const revisedResult = await this.runAgent(intent, revisedCtx);
		ctx.onTrace({ type: "observation", content: "✅ Revision complete." });

		// Merge affected files from both runs
		const allAffected = new Set([...result.affectedFiles, ...revisedResult.affectedFiles]);
		return {
			...revisedResult,
			traceSteps: [...result.traceSteps, ...revisedResult.traceSteps],
			affectedFiles: [...allAffected],
		};
	}
}
