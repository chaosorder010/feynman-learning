import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerConceptIndexTools } from "./state/concept-index.js";
import { registerCoachMemoryTools } from "./state/coach-memory.js";
import { registerProgressTools, mergeProgress } from "./state/progress.js";
import { registerSiteTools } from "./state/site.js";

export default function feynmanState(pi: ExtensionAPI) {
	// mergeProgress (owned by the progress module) is injected into the concept-index
	// module so feynman_write_concept_note can merge progress without concept-index
	// statically importing progress, keeping the import graph acyclic.
	registerConceptIndexTools(pi, { mergeProgress });
	registerProgressTools(pi);
	registerCoachMemoryTools(pi);
	registerSiteTools(pi);
}
