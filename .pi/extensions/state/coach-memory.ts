import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { slugify, nowStamp, coachMemoryPath, withQueuedFileMutation, readText, validationFailureResult } from "./util.js";
import type { JsonObject, ValidationResult } from "./util.js";

type CoachMemoryCategory =
	| "Stable Learning Preferences"
	| "Recurring Weaknesses"
	| "Effective Remediation Patterns"
	| "Ineffective Patterns To Avoid"
	| "Scoring Calibration Notes"
	| "Cross-Project Misconceptions"
	| "Coach Self-Corrections";

type CoachMemoryParams = {
	category: CoachMemoryCategory;
	observation: string;
	evidence: string[];
	project?: string;
	outlineNode?: string;
	concept?: string;
	learnerConfirmed?: boolean;
	occurrenceCount?: number;
};

type ReadCoachMemoryParams = {
	category?: CoachMemoryCategory;
	maxChars?: number;
	includeRetracted?: boolean;
};

type RetractCoachMemoryParams = {
	entryIdOrMatch: string;
	reason: string;
};

const coachMemoryParameters = {
	type: "object",
	properties: {
		category: {
			type: "string",
			description:
				"One of: Stable Learning Preferences | Recurring Weaknesses | Effective Remediation Patterns | Ineffective Patterns To Avoid | Scoring Calibration Notes | Cross-Project Misconceptions | Coach Self-Corrections",
		},
		observation: {
			type: "string",
			description:
				"A concrete learner pattern or coach self-correction. Do not write personality labels or unsupported judgments.",
		},
		evidence: {
			type: "array",
			items: { type: "string" },
			description: "Concrete learner outputs, score patterns, or correction records that justify the memory.",
		},
		project: { type: "string" },
		outlineNode: { type: "string" },
		concept: { type: "string" },
		learnerConfirmed: {
			type: "boolean",
			description: "True only when the learner explicitly confirmed this memory should be kept.",
		},
		occurrenceCount: {
			type: "number",
			description: "Number of separate observations supporting this memory. Must be at least 2 unless learnerConfirmed is true.",
		},
	},
	required: ["category", "observation", "evidence"],
	additionalProperties: false,
} as any;

const readCoachMemoryParameters = {
	type: "object",
	properties: {
		category: {
			type: "string",
			description: "Optional section name to read from SOUL.md.",
		},
		maxChars: {
			type: "number",
			description: "Maximum characters to return. Default 12000, max 30000.",
		},
		includeRetracted: {
			type: "boolean",
			description: "When true, include the audit-only Retracted section. Default false.",
		},
	},
	additionalProperties: false,
} as any;

const retractCoachMemoryParameters = {
	type: "object",
	properties: {
		entryIdOrMatch: {
			type: "string",
			description:
				"Entry ID or unique text fragment from the coach memory entry to retract.",
		},
		reason: {
			type: "string",
			description:
				"Concrete reason the memory was disproven, superseded, or should no longer guide coaching.",
		},
	},
	required: ["entryIdOrMatch", "reason"],
	additionalProperties: false,
} as any;

const coachMemoryCategories: CoachMemoryCategory[] = [
	"Stable Learning Preferences",
	"Recurring Weaknesses",
	"Effective Remediation Patterns",
	"Ineffective Patterns To Avoid",
	"Scoring Calibration Notes",
	"Cross-Project Misconceptions",
	"Coach Self-Corrections",
];

const coachMemoryCategorySet = new Set<string>(coachMemoryCategories);

function renderCoachMemoryTemplate(): string {
	return [
		"# Feynman Coach Long-Term Memory",
		"",
		"Purpose: cross-project learner coaching memory. Keep this file factual, evidence-backed, and useful for adapting future coaching. Do not use it as a personality prompt.",
		"",
		"Write rules:",
		"- Record only stable learning patterns, learner-confirmed preferences, effective remediation strategies, or coach self-corrections.",
		"- Do not record unsupported personality judgments.",
		"- Do not duplicate project progress, scores, or concept notes here.",
		"- Each entry must include evidence and whether the learner confirmed it.",
		"",
		...coachMemoryCategories.flatMap((category) => [`## ${category}`, "", "- No entries yet.", ""]),
		"## Retracted",
		"",
		"- No entries yet.",
		"",
		"## Last Updated",
		"",
		"Never",
		"",
	].join("\n");
}

function cleanEvidence(values: string[]): string[] {
	return values.map((value) => value.trim()).filter(Boolean);
}

function validateCoachMemoryInput(params: CoachMemoryParams): { ok: true; evidence: string[] } | ValidationResult {
	if (!coachMemoryCategorySet.has(params.category)) {
		return {
			ok: false,
			reason: "unknown_coach_memory_category",
			message: `Unknown coach memory category "${params.category}".`,
		};
	}

	const observation = params.observation.trim();
	if (observation.length < 20) {
		return {
			ok: false,
			reason: "coach_memory_observation_too_short",
			message:
				"Cannot update coach memory: observation must be at least 20 characters and describe a concrete learning pattern.",
		};
	}

	const evidence = cleanEvidence(params.evidence);
	if (evidence.length === 0 || evidence.every((item) => item.length < 20)) {
		return {
			ok: false,
			reason: "coach_memory_missing_evidence",
			message:
				"Cannot update coach memory without concrete evidence. Include learner output, score pattern, or correction record.",
		};
	}

	const occurrenceCount = Math.max(0, Number(params.occurrenceCount || 0));
	if (params.learnerConfirmed !== true && occurrenceCount < 2) {
		return {
			ok: false,
			reason: "coach_memory_insufficient_confirmation",
			message:
				"Cannot update coach memory from a single unconfirmed observation. Get learner confirmation or provide occurrenceCount >= 2.",
		};
	}

	return { ok: true, evidence };
}

function coachMemoryEntryId(stamp: string): string {
	return `cm-${stamp.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}`;
}

function sectionBounds(markdown: string, header: string): { start: number; end: number } | undefined {
	const start = markdown.indexOf(header);
	if (start === -1) return undefined;
	const nextHeader = markdown.indexOf("\n## ", start + header.length);
	return { start, end: nextHeader === -1 ? markdown.length : nextHeader };
}

function ensureSection(markdown: string, header: string): string {
	if (markdown.includes(header)) return markdown;
	const lastUpdated = sectionBounds(markdown, "## Last Updated");
	if (lastUpdated) {
		return `${markdown.slice(0, lastUpdated.start).trimEnd()}\n\n${header}\n\n- No entries yet.\n\n${markdown.slice(lastUpdated.start).trimStart()}`;
	}
	return `${markdown.trimEnd()}\n\n${header}\n\n- No entries yet.\n`;
}

function updateSection(markdown: string, header: string, update: (section: string) => string): string {
	const ensured = ensureSection(markdown, header);
	const bounds = sectionBounds(ensured, header);
	if (!bounds) return ensured;
	const section = ensured.slice(bounds.start, bounds.end);
	return `${ensured.slice(0, bounds.start)}${update(section).trimEnd()}${ensured.slice(bounds.end)}`;
}

function removeEmptyPlaceholder(section: string): string {
	return section.replace(/^\s*-\s*No entries yet\.\s*$/gm, "").trimEnd();
}

function replaceLastUpdated(markdown: string, stamp: string): string {
	const withoutLastUpdated = markdown
		.replace(/\n*## Last Updated[\s\S]*?(?=\n## |\n*$)/g, "")
		.trimEnd();
	return `${withoutLastUpdated}\n\n## Last Updated\n\n${stamp}\n`;
}

function appendCoachMemoryEntry(markdown: string, params: CoachMemoryParams, evidence: string[]): string {
	let next = markdown.trimEnd();
	const categoryHeader = `## ${params.category}`;

	const stamp = nowStamp();
	const entryId = coachMemoryEntryId(stamp);
	const context = [
		params.project ? `project=${slugify(params.project)}` : undefined,
		params.outlineNode ? `outline_node=${params.outlineNode}` : undefined,
		params.concept ? `concept=${params.concept}` : undefined,
	]
		.filter(Boolean)
		.join("; ");
	const entryLines = [
		`### Update ${stamp}`,
		"",
		`- Entry ID: ${entryId}`,
		`- Observation: ${params.observation.trim()}`,
		`- Evidence: ${evidence.join(" | ")}`,
		`- Confirmation: ${params.learnerConfirmed ? "learner-confirmed" : `observed ${Math.max(0, Number(params.occurrenceCount || 0))} times`}`,
		context ? `- Context: ${context}` : undefined,
		"",
	].filter((line): line is string => line !== undefined);

	next = updateSection(next, categoryHeader, (section) => {
		const clean = removeEmptyPlaceholder(section);
		return `${clean}\n\n${entryLines.join("\n")}`;
	});

	return `${replaceLastUpdated(next, stamp).trimEnd()}\n`;
}

function splitCoachMemoryEntries(section: string): { before: string; entries: string[] } {
	const firstEntry = section.indexOf("\n### Update ");
	if (firstEntry === -1) return { before: section.trimEnd(), entries: [] };
	const before = section.slice(0, firstEntry).trimEnd();
	const body = section.slice(firstEntry + 1).trim();
	const entries = body.split(/\n(?=### Update )/g).map((entry) => entry.trim()).filter(Boolean);
	return { before, entries };
}

function retractCoachMemoryEntry(markdown: string, entryIdOrMatch: string, reason: string): { markdown: string; retracted: boolean; entry?: string } {
	const needle = entryIdOrMatch.trim();
	const stamp = nowStamp();
	let found: string | undefined;
	let next = markdown.trimEnd();

	for (const category of coachMemoryCategories) {
		const header = `## ${category}`;
		const bounds = sectionBounds(next, header);
		if (!bounds) continue;
		const section = next.slice(bounds.start, bounds.end);
		const { before, entries } = splitCoachMemoryEntries(section);
		const index = entries.findIndex((entry) => entry.includes(needle));
		if (index === -1) continue;

		found = entries[index];
		const remaining = entries.filter((_, i) => i !== index);
		const replacement = remaining.length > 0 ? `${before}\n\n${remaining.join("\n\n")}` : `${before}\n\n- No entries yet.`;
		next = `${next.slice(0, bounds.start)}${replacement.trimEnd()}${next.slice(bounds.end)}`;
		break;
	}

	if (!found) {
		return { markdown, retracted: false };
	}

	const retractionLines = [
		`### Retraction ${stamp}`,
		"",
		`- Retracted Match: ${needle}`,
		`- Reason: ${reason.trim()}`,
		"",
		"#### Original Entry",
		"",
		found,
		"",
	];

	next = updateSection(next, "## Retracted", (section) => {
		const clean = removeEmptyPlaceholder(section);
		return `${clean}\n\n${retractionLines.join("\n")}`;
	});

	return { markdown: `${replaceLastUpdated(next, stamp).trimEnd()}\n`, retracted: true, entry: found };
}

function stripCoachMemorySection(markdown: string, header: string): string {
	const bounds = sectionBounds(markdown, header);
	if (!bounds) return markdown;
	return `${markdown.slice(0, bounds.start).trimEnd()}\n\n${markdown.slice(bounds.end).trimStart()}`.trim();
}

function extractCoachMemorySection(markdown: string, category: string): string {
	const header = `## ${category}`;
	const bounds = sectionBounds(markdown, header);
	if (!bounds) return "";
	return markdown.slice(bounds.start, bounds.end).trim();
}

export type {
	CoachMemoryCategory,
	CoachMemoryParams,
	ReadCoachMemoryParams,
	RetractCoachMemoryParams,
};
export {
	coachMemoryParameters,
	readCoachMemoryParameters,
	retractCoachMemoryParameters,
	coachMemoryCategories,
	coachMemoryCategorySet,
	renderCoachMemoryTemplate,
	cleanEvidence,
	validateCoachMemoryInput,
	coachMemoryEntryId,
	sectionBounds,
	ensureSection,
	updateSection,
	removeEmptyPlaceholder,
	replaceLastUpdated,
	appendCoachMemoryEntry,
	splitCoachMemoryEntries,
	retractCoachMemoryEntry,
	stripCoachMemorySection,
	extractCoachMemorySection,
};

export function registerCoachMemoryTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "feynman_update_coach_memory",
		label: "Update Feynman Coach Memory",
		description:
			"Append an evidence-backed, cross-project learner coaching memory to ~/.pi/feynman-projects/_learner/SOUL.md.",
		promptSnippet:
			"feynman_update_coach_memory: persist learner-confirmed or repeatedly observed coaching patterns in SOUL.md.",
		promptGuidelines: [
			"Use feynman_update_coach_memory only for stable learner preferences, repeated weaknesses, effective remediation patterns, or coach self-corrections.",
			"Do not write personality labels, unsupported judgments, or ordinary project progress into coach memory.",
			"Either learnerConfirmed must be true or occurrenceCount must be at least 2, and evidence must be concrete.",
		],
		parameters: coachMemoryParameters,
		async execute(_toolCallId, params: CoachMemoryParams) {
			const validation = validateCoachMemoryInput(params);
			if (!validation.ok) {
				return validationFailureResult(validation);
			}

			const file = coachMemoryPath();
			const markdown = await withQueuedFileMutation(file, async () => {
				const existing = (await readText(file)) || renderCoachMemoryTemplate();
				const next = appendCoachMemoryEntry(existing, params, validation.evidence);
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, next, "utf8");
				return next;
			});

			pi.appendEntry("feynman-coach-memory", {
				event: "coach_memory_updated",
				category: params.category,
				project: params.project ? slugify(params.project) : undefined,
				path: file,
				updatedAt: nowStamp(),
			});

			return {
				content: [{ type: "text", text: `Updated coach memory at ${file}` }],
				details: {
					ok: true,
					path: file,
					category: params.category,
					entry_count: (markdown.match(/^### Update /gm) || []).length,
				},
			};
		},
	});

	pi.registerTool({
		name: "feynman_read_coach_memory",
		label: "Read Feynman Coach Memory",
		description:
			"Read the cross-project learner coaching memory from ~/.pi/feynman-projects/_learner/SOUL.md.",
		promptSnippet:
			"feynman_read_coach_memory: read SOUL.md when adapting coaching across projects.",
		promptGuidelines: [
			"Use feynman_read_coach_memory to adapt coaching style across projects without loading unrelated project progress.",
			"Treat SOUL.md as coaching memory, not as a personality prompt or a replacement for progress.json.",
		],
		parameters: readCoachMemoryParameters,
		async execute(_toolCallId, params: ReadCoachMemoryParams = {}) {
			const file = coachMemoryPath();
			const existing = (await readText(file)) || renderCoachMemoryTemplate();
			const selected =
				params.category && coachMemoryCategorySet.has(params.category)
					? extractCoachMemorySection(existing, params.category)
					: params.includeRetracted
						? existing
						: stripCoachMemorySection(existing, "## Retracted");
			const limit = Math.max(1000, Math.min(Number(params.maxChars || 12000), 30000));
			const text = selected.length > limit ? `${selected.slice(0, limit)}\n\n[truncated]` : selected;

			return {
				content: [{ type: "text", text }],
				details: {
					ok: true,
					path: file,
					category: params.category,
					truncated: selected.length > limit,
					chars: text.length,
				},
			};
		},
	});

	pi.registerTool({
		name: "feynman_retract_coach_memory",
		label: "Retract Feynman Coach Memory",
		description:
			"Move a disproven or superseded coach memory entry to the audit-only Retracted section of SOUL.md.",
		promptSnippet:
			"feynman_retract_coach_memory: retract a coach memory entry that should no longer guide coaching.",
		promptGuidelines: [
			"Use feynman_retract_coach_memory when a prior SOUL.md entry is disproven, superseded, or should stop affecting coaching.",
			"Provide a concrete reason. The original entry is preserved under Retracted for auditability.",
		],
		parameters: retractCoachMemoryParameters,
		async execute(_toolCallId, params: RetractCoachMemoryParams) {
			const needle = params.entryIdOrMatch.trim();
			const reason = params.reason.trim();
			if (needle.length < 6 || reason.length < 20) {
				return validationFailureResult({
					ok: false,
					reason: "coach_memory_retraction_too_vague",
					message:
						"Cannot retract coach memory without a specific entry match and a concrete reason of at least 20 characters.",
				});
			}

			const file = coachMemoryPath();
			const result = await withQueuedFileMutation(file, async () => {
				const existing = (await readText(file)) || renderCoachMemoryTemplate();
				const retracted = retractCoachMemoryEntry(existing, needle, reason);
				if (retracted.retracted) {
					await mkdir(dirname(file), { recursive: true });
					await writeFile(file, retracted.markdown, "utf8");
				}
				return retracted;
			});

			if (!result.retracted) {
				return validationFailureResult({
					ok: false,
					reason: "coach_memory_entry_not_found",
					message:
						"Cannot retract coach memory: no active entry matched the provided entryIdOrMatch.",
				});
			}

			pi.appendEntry("feynman-coach-memory", {
				event: "coach_memory_retracted",
				entryIdOrMatch: needle,
				path: file,
				updatedAt: nowStamp(),
			});

			return {
				content: [{ type: "text", text: `Retracted coach memory entry in ${file}` }],
				details: {
					ok: true,
					path: file,
					entryIdOrMatch: needle,
				},
			};
		},
	});
}
