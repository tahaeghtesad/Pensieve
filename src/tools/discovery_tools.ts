import type { Tool, ToolResult } from "./types";

export const calculateStructuralHolesTool: Tool = {
	name: "calculate_structural_holes",
	description: "Analyzes the vault's exact resolved links network (adjacency matrix) to detect gap-nodes, bridge opportunities, or disjoint structural clusters. Use this to find disparate parts of the knowledge base that should be logically connected but currently lack intermediate synthesis.",
	parameters: [
		{ name: "max_nodes", type: "number", description: "The upper limit of gap-node suggestions to return. Defaults to 5.", required: false }
	],
	async execute(args, ctx): Promise<ToolResult> {
		const maxNodes = Number(args.max_nodes) || 5;
		const resolvedLinks = ctx.app.metadataCache.resolvedLinks;

		// Calculate basic node statistics proxying Burt's Constraint (structural holes)
		// We want to identify "Hubs" and "Orphans" to bridge them, or find nodes that link exclusively to unconnected domains.
		interface NodeStats {
			path: string;
			inDegree: number;
			outDegree: number;
			links: string[];
			constraintScore: number;
		}

		const nodes: Map<string, NodeStats> = new Map();
		
		// Map out degrees
		for (const [sourcePath, linksOut] of Object.entries(resolvedLinks)) {
			if (!nodes.has(sourcePath)) {
				nodes.set(sourcePath, { path: sourcePath, inDegree: 0, outDegree: 0, links: Object.keys(linksOut), constraintScore: 0 });
			}
			const stats = nodes.get(sourcePath)!;
			stats.outDegree += Object.keys(linksOut).length;
			
			// Map in degrees
			for (const targetPath of Object.keys(linksOut)) {
				if (!nodes.has(targetPath)) {
					nodes.set(targetPath, { path: targetPath, inDegree: 0, outDegree: 0, links: [], constraintScore: 0 });
				}
				nodes.get(targetPath)!.inDegree++;
			}
		}

		// A very fast approximation for "Structural Holes":
		// Find nodes with high outgoing links but their targets share ZERO links amongst themselves
		const candidates: NodeStats[] = [];
		for (const stat of nodes.values()) {
			if (stat.outDegree < 2) continue; // Must connect multiple things to be a bridge

			let sharedNeighborhoods = 0;
			let maxPossibleShared = 0;
			
			for (let i = 0; i < stat.links.length; i++) {
				for (let j = i + 1; j < stat.links.length; j++) {
					maxPossibleShared++;
					const targetA = stat.links[i]!;
					const targetB = stat.links[j]!;
					
					// Are targetA and targetB linked structurally?
					const linksFromA = resolvedLinks[targetA] || {};
					const linksFromB = resolvedLinks[targetB] || {};
					if ((targetB in linksFromA) || (targetA in linksFromB)) {
						sharedNeighborhoods++;
					}
				}
			}

			// Low constraint means targets are NOT connected to each other! Ideal bridge potential.
			stat.constraintScore = maxPossibleShared > 0 ? (sharedNeighborhoods / maxPossibleShared) : 0;
			
			if (stat.constraintScore < 0.3) {
				candidates.push(stat);
			}
		}

		// Sort by lowest constraint score (most bridging potential) and high outDegree
		candidates.sort((a, b) => {
			if (a.constraintScore === b.constraintScore) {
				return b.outDegree - a.outDegree;
			}
			return a.constraintScore - b.constraintScore;
		});

		const topNodes = candidates.slice(0, maxNodes);
		if (topNodes.length === 0) {
			return { success: true, output: "Vault is fully structurally saturated or lacks enough linked nodes to find isolated conceptual gaps." };
		}

		const resultStrings = topNodes.map(n => 
			`- Node [[${n.path}]] acts as a bridge. It links to [${n.links.slice(0,3).join(", ")}${n.links.length > 3 ? "..." : ""}], but those targets share almost no connections with each other (Constraint Score: ${n.constraintScore.toFixed(2)}).`
		);

		return { success: true, output: "Found optimal Structural Holes bridging isolated topics:\n" + resultStrings.join("\n") };
	}
};

export const evaluateInformationGainTool: Tool = {
	name: "evaluate_information_gain",
	description: "Compares a hypothesized new idea/concept against the entire vault via semantic vector search to check for redundancy. Use this before proposing extensive research to ensure the agent's new angle does not merely restate something the user already documented.",
	parameters: [
		{ name: "proposed_concept", type: "string", description: "A detailed paragraph or sentence describing the novel idea.", required: true }
	],
	async execute(args, ctx): Promise<ToolResult> {
		const concept = String(args["proposed_concept"] ?? "");
		if (!concept) return { success: false, output: "proposed_concept is required" };

		const results = await ctx.retriever.retrieve(concept);
		
		// If ANY chunk has a higher cosine similarity > 0.85, it's considered highly redundant
		const redundancies = results.filter(r => r.score > 0.82);
		
		if (redundancies.length > 0) {
			const report = redundancies.map(r => `[[${r.filePath}]] (Similarity: ${r.score.toFixed(2)})`).join(", ");
			return { 
				success: true, 
				output: `LOW INFORMATION GAIN. The user already has notes extremely similar to this concept in:\n${report}\n\nDo not pursue this concept. Pivot to a different angle.`
			};
		}

		return { 
			success: true, 
			output: `HIGH INFORMATION GAIN. Max background similarity is only ${results[0]?.score?.toFixed(2) || 0}. The concept is novel within the vault. Proceed to outline an exploratory research plan.` 
		};
	}
};

export function registerDiscoveryTools(registry: import("./registry").ToolRegistry): void {
	registry.register(calculateStructuralHolesTool);
	registry.register(evaluateInformationGainTool);
}
