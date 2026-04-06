import type { OllamaService } from "../ollama";
import type { PensieveSettings } from "../settings";
import { PlannerAgent } from "./planner";
import { WriterAgent } from "./writer";
import { ReviewerAgent } from "./reviewer";
import { CriticAgent } from "./critic";
import { FactCheckerAgent } from "./factchecker";
import { OrganizerAgent } from "./organizer";
import { OntologistAgent } from "./ontologist";
import { ArchivistAgent } from "./archivist";
import { ExplorerAgent } from "./explorer";
import { GovernorAgent } from "./governor";
import { ResearcherAgent } from "./researcher";
import { VaultGardenerAgent } from "./gardener";
import type { AgentContext, AgentResult, IntentType, ReActAgent } from "./types";

const CLASSIFY_PROMPT = `You are a task classifier. Classify the user's request into exactly one category.

Categories:
- direct_chat: General questions, asking about notes, conversation, no modifications needed
- write_task: Creating notes, adding content, editing notes, daily/weekly notes, appending
- plan_task: Complex multi-step planning, outlining goals, structuring projects
- review_task: Reviewing, summarizing, evaluating, or analyzing note content
- factcheck_task: Verifying facts, checking claims, validating information
- organize_task: Restructuring the vault, organizing notes, moving files, renaming, building folders
- synthesize_task: Extracting knowledge graphs, splitting notes into atomic concepts, tagging topics
- archive_task: Compressing old notes into memory nodes, temporal context extraction, memory decay operations
- explore_task: Brainstorming, analyzing graph structure, finding disconnected concepts, generating research angles
- govern_task: Enforcing strict markdown/wiki format, temporal schema compliance, and migration of legacy notes
- ingest_url: Reading a URL/link, researching a webpage, ingesting an article, "read this link", deep-diving into a web resource
- garden_task: Vault cleanup, fixing orphan notes, linting frontmatter, deduplication, structural health checks

Respond with ONLY the category name. Nothing else.`;

export class Orchestrator {
		private agents: Map<IntentType, ReActAgent>;
	private ollama: OllamaService;
	settings: PensieveSettings;

	constructor(ollama: OllamaService, settings: PensieveSettings) {
		this.ollama = ollama;
		this.settings = settings;
		this.agents = new Map<IntentType, ReActAgent>([
			["write_task", new WriterAgent()],
			["plan_task", new PlannerAgent()],
			["review_task", new ReviewerAgent()],
			["factcheck_task", new FactCheckerAgent()],
			["organize_task", new OrganizerAgent()],
			["synthesize_task", new OntologistAgent()],
			["archive_task", new ArchivistAgent()],
			["explore_task", new ExplorerAgent()],
			["govern_task", new GovernorAgent()],
			["ingest_url", new ResearcherAgent()],
			["garden_task", new VaultGardenerAgent()]
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
			return "ingest_url";
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

		const raw = response.trim().toLowerCase().replace(/[^a-z_]/g, "");
		const valid: IntentType[] = ["direct_chat", "write_task", "plan_task", "review_task", "factcheck_task", "organize_task", "synthesize_task", "archive_task", "explore_task", "govern_task", "ingest_url", "garden_task"];
		if (valid.includes(raw as IntentType)) return raw as IntentType;

		// Keyword fallback
		const q = query.toLowerCase();
		if (/(markdown format|wiki format|frontmatter|temporal schema|chronology|migrate notes|normalize tags|strict format)/.test(q)) return "govern_task";
		if (/(explore|discover|brainstorm|gap|structural hole|connect idea|new angle|research angle|novelty)/.test(q)) return "explore_task";
		if (/(compress|consolidate|archive|memory|temporal|decay|old notes)/.test(q)) return "archive_task";
		if (/(garden|lint|orphan|cleanup|clean up|deduplic|vault health|fix links|broken links|reparent)/.test(q)) return "garden_task";
		if (/(organize|move|rename|folder|restructure|architect|zettelkasten|para)/.test(q)) return "organize_task";
		if (/(synthesize|atomic|split|extract|graph|topic|theme|concept)/.test(q)) return "synthesize_task";
		if (/(create|add|write|append|update|edit|daily note|weekly note|jot down)/.test(q)) return "write_task";
		if (/(plan|break down|steps|roadmap|outline|structure)/.test(q)) return "plan_task";
		if (/(review|summarize|evaluate|assess|analyze|improve|feedback)/.test(q)) return "review_task";
		if (/(fact.?check|verify|validate|confirm|is.*true|check.*claim)/.test(q)) return "factcheck_task";

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
}
