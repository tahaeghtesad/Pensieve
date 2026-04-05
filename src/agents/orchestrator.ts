import type { OllamaService } from "../ollama";
import type { PensieveSettings } from "../settings";
import { PlannerAgent } from "./planner";
import { WriterAgent } from "./writer";
import { ReviewerAgent } from "./reviewer";
import { CriticAgent } from "./critic";
import { FactCheckerAgent } from "./factchecker";
import type { AgentContext, AgentResult, IntentType, ReActAgent } from "./types";

const CLASSIFY_PROMPT = `You are a task classifier. Classify the user's request into exactly one category.

Categories:
- direct_chat: General questions, asking about notes, conversation, no modifications needed
- write_task: Creating notes, adding content, editing notes, daily/weekly notes, appending
- plan_task: Complex multi-step planning, organizing goals, structuring projects
- review_task: Reviewing, summarizing, evaluating, or analyzing note content
- factcheck_task: Verifying facts, checking claims, validating information

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
		]);
	}

	updateSettings(settings: PensieveSettings): void {
		this.settings = settings;
	}

	async classify(query: string): Promise<IntentType> {
		if (!this.settings.agentEnabled) return "direct_chat";

		let response = "";
		try {
			await this.ollama.chat(
				this.settings.chatModel,
				[
					{ role: "system", content: CLASSIFY_PROMPT },
					{ role: "user", content: query },
				],
				(token) => { response += token; }
			);
		} catch {
			return "direct_chat";
		}

		const raw = response.trim().toLowerCase().replace(/[^a-z_]/g, "");
		const valid: IntentType[] = ["direct_chat", "write_task", "plan_task", "review_task", "factcheck_task"];
		if (valid.includes(raw as IntentType)) return raw as IntentType;

		// Keyword fallback
		const q = query.toLowerCase();
		if (/(create|add|write|append|update|edit|daily note|weekly note|jot down)/.test(q)) return "write_task";
		if (/(plan|organize|break down|steps|roadmap|outline|structure)/.test(q)) return "plan_task";
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
