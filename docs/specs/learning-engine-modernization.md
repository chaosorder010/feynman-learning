# Spec: Learning Engine Modernization

Status: ready-for-agent
Scope: FSRS-based spaced repetition + structured per-concept mastery trajectory + score-calibration (partial credit) + module split of the state extension.

## Problem Statement

As a learner using the Feynman coach across many projects and concepts, I keep hitting three frustrations that erode the value of the long-term learning loop:

1. **Every concept is reviewed on the same fixed clock.** A concept I barely passed and a concept I nailed both come back in 1 day, then 3, then 7, then 30, then "graduated." The scheduler ignores how hard the concept was for me and how well I recalled it. Easy things I already know keep interrupting me; hard things I am shaky on disappear for a month.

2. **The pass/fail score gate is binary and unforgiving.** If my average is 6.8 or one dimension is 5.8, the concept is flunked straight back to `CORRECTING` with no credit for the parts I did get right. There is no notion of "almost there, reinforce later." This produces repeated remediation loops that feel punitive, and the strict LLM grader is known to occasionally penalize valid alternate phrasings or partial reasoning. Over time this makes the coach feel rigid rather than rigorous.

3. **My learner profile is mostly prose.** `SOUL.md` captures cross-project patterns as free text, and the concept index records only the *latest* score and outcome. There is no per-concept history of how my mastery evolved, so "this kind of concept keeps tripping me up" is something the coach has to infer by reading notes rather than read off a trajectory. Weakness detection stays qualitative.

As a maintainer, the third pain is compounded by the fact that the entire state extension is one ~83 KB file holding ten tools, the state machine, the scheduler, the concept-note renderer, and the coach-memory engine. Adding any of the above cleanly means touching a file that is already too big to navigate.

## Solution

Modernize the learning engine in one coordinated change:

- Replace the fixed `[1, 3, 7, 30]` cadence with **FSRS** dynamic scheduling, so `next_review_at` is computed from the concept's stability and the learner's last rating rather than a fixed ladder.
- Persist a **structured per-concept mastery trajectory** (timestamped review events with rating, score, and misconceptions) alongside the existing free-text coach memory, so weakness patterns become data, not just prose.
- Soften the binary score gate with **partial credit**: a narrow near-miss band becomes `CONDITIONAL_PASS` (advances but is queued for priority reinforcement) instead of automatic `CORRECTING`. Make every scoring dimension's rubric atomic so the LLM grader is less likely to penalize valid alternate phrasings.
- **Split the state extension** into focused modules (progress, concept-note, coach-memory, review-scheduler, concept-index) so all of the above lands in code that can be maintained and tested in isolation.

These four are one spec because they share a single seam (the `record_score` tool and the review scheduler) and a single data-structure migration. Doing them separately means migrating `reviews.json` twice.

## User Stories

1. As a learner, I want easy concepts I have clearly mastered to stop appearing for review every few days, so that my review time goes to concepts I actually struggle with.
2. As a learner, I want a concept I fumbled to come back sooner than one I recalled cleanly, so that the scheduler reflects how well I actually know each thing.
3. As a learner, I want to see, for any concept, the full history of my scores and misconceptions over time, so that I can see whether I am actually improving.
4. As a learner, I want a concept that *almost* passed (say average 6.8 or one dimension 5.8) to let me move forward rather than dump me back into full remediation, so that the coach feels rigorous but not punitive.
5. As a learner, I want the coach to accept an equivalent phrasing or alternate derivation as correct, so that I am not penalized for reaching the right understanding by a different path than the coach expected.
6. As a learner, I want near-miss concepts to be tagged for priority reinforcement, so that they come back in the review queue ahead of fully-passed concepts.
7. As a learner, I want the coach to tell me, at `/feynman-status`, which kinds of concepts I am systematically weak at, based on my actual score history, so that I get data-driven guidance rather than a vibe.
8. As a learner, I want the graduation decision for a concept to reflect how stably I know it (long FSRS stability), not just that I survived four fixed rungs, so that "graduated" actually means durable.
9. As a learner, I want my existing review history preserved when the scheduler is upgraded, so that the migration does not reset my spaced-repetition state.
10. As a learner, I want the review-due list to still work exactly as before from my perspective, so that `/feynman-review` keeps surfacing the right things, just on a smarter schedule.
11. As a learner, I want a concept I marked `Again` on review to re-appear very soon, so that a failed recall is addressed promptly.
12. As a learner, I want a concept I marked `Easy` on review to disappear for a long time, so that obvious material stops wasting my sessions.
13. As a learner, I want my per-concept mastery trajectory to feed the cross-project coach memory, so that the coach can ground its qualitative observations in actual data.
14. As a learner, I want the partial-credit state to be visibly distinct from a full pass in `/feynman-status`, so that I know which concepts still need reinforcement even though I advanced.
15. As a coach (agent), I want the scoring rubric for each of the five dimensions to spell out exactly when to award credit, so that my grading is consistent across learners and sessions.
16. As a coach, I want a structured mastery trajectory I can query, so that I do not have to re-read concept notes to detect a recurring weakness.
17. As a coach, I want the scheduler to accept a rating I derive from the learner's score, so that I do not have to invent a separate review-grade.
18. As a coach, I want invalid state transitions (e.g. advancing out of `CONDITIONAL_PASS` without a reinforcement pass) to be rejected mechanically, so that I cannot accidentally let a shaky concept drift.
19. As a maintainer, I want the state extension split into modules with clear responsibilities, so that adding a new scoring or scheduling rule does not require editing an 83 KB file.
20. As a maintainer, I want each module to be independently testable through the existing tool harness, so that I can refactor with confidence.
21. As a maintainer, I want the review-scheduler logic to be a pure, dependency-light module, so that I can unit-test scheduling directly without spinning up the full tool registry.
22. As a maintainer, I want the data-shape migration to be explicit and versioned, so that future changes to `reviews.json` do not silently break older project directories.
23. As a maintainer, I want the FSRS integration isolated behind one module boundary, so that swapping the scheduler library later does not ripple through the tools.
24. As a maintainer, I want the existing test suite to keep passing unchanged after the module split, so that the split is provably behavior-preserving.
25. As a maintainer, I want new tests for FSRS scheduling, partial credit, and mastery trajectory to use the same harness as existing tests, so that there is one test seam for the whole engine.
26. As a learner, I want the dashboard site to reflect the new schedule and mastery data, so that the generated project site stays a faithful view of my state.
27. As a learner, I want `feynman_list_concepts` to optionally include the mastery trajectory, so that the coach can load only what it needs without pulling the whole index.
28. As a learner, I want the coach to treat a `CONDITIONAL_PASS` concept as still-open during `/feynman-continue`, so that resuming a project does not silently skip reinforcement work.
29. As a learner, I want a concept's misconceptions from every prior round to be retained in its trajectory, so that the coach can see whether the same misconception keeps recurring.
30. As a learner, I want the target retention the scheduler aims for to be configurable per project, so that I can tune aggressiveness for exam-prep vs. casual learning.

## Implementation Decisions

### Module split (structural prerequisite)

The single state extension is split into focused modules behind one registration entry. The registration entry stays the single public surface Pi discovers; tools keep their existing names and parameter shapes. Proposed module boundary:

- `progress` — `progress.json` reads/writes, state-machine transition validation, `pi.appendEntry("feynman-progress")` checkpoints.
- `concept-note` — concept-note Markdown rendering, section updates, correction-round tracking, `### Update` guards.
- `coach-memory` — `SOUL.md` section extraction/strip/retract, evidence and occurrence-count enforcement.
- `review-scheduler` — FSRS-backed scheduling, rating mapping, due/overdue computation, graduation decision.
- `concept-index` — `concept-notes/index.json` upsert/rebuild, per-concept outcome summary, mastery-trajectory access.

The registration entry imports these and wires `pi.registerTool`. No tool is renamed, no parameter is removed. This split lands first and must be behavior-preserving (verified by the existing suite passing unchanged).

### FSRS scheduling

The fixed-cadence scheduler (`REVIEW_CADENCE_DAYS = [1, 3, 7, 30]`, `stage` 0–4, `REVIEW_GRADUATED_STAGE = 4`) is replaced by an FSRS-backed scheduler. The community-standard `ts-fsrs` library is the implementation; it is application-agnostic and only requires the host to record review events and supply a 4-level rating (`Again` / `Hard` / `Good` / `Easy`).

The existing 5-dimension score is mapped to an FSRS rating at `record_score` time and again at `record_review` time:

```
scoreToRating(average):
  average >= 9            -> Easy
  7   <= average < 9      -> Good
  6   <= average < 7      -> Hard
  average <  6            -> Again
```

This keeps a single source of truth (the rubric score) and avoids asking the agent to produce a second, parallel review grade.

The `ReviewSchedule` shape is extended to carry FSRS state (additive, existing fields retained for migration):

```
type ReviewSchedule = {
  // legacy, retained for backfill and dashboard continuity
  stage?: number;
  // FSRS state, populated after first review
  stability?: number;       // days of durable memory
  difficulty?: number;      // FSRS difficulty
  retrievability?: number;  // current recall probability
  last_rating?: "Again" | "Hard" | "Good" | "Easy";
  // unchanged semantics
  next_review_at: string;
  last_reviewed_at?: string;
  state?: "learning" | "review" | "relearning" | "graduated";
};
```

`graduated` is redefined by a stability threshold (e.g. `stability >= 100` days) rather than a fixed stage index, configurable per project via a `retention_target` and `graduation_stability_days` on the project record. The existing `isReviewDue` / `daysOverdue` semantics are preserved as derivations over `next_review_at`, so `feynman_review_due` and `feynman_record_review` keep their external behavior.

### Structured mastery trajectory

A per-concept review-event history is persisted in `reviews.json` (already the durable review log), extended so each event carries the FSRS rating, the full 5-dimension scores, and the misconceptions recorded that round:

```
type ReviewEvent = {
  recorded_at: string;
  rating: "Again" | "Hard" | "Good" | "Easy";
  scores: { accuracy, simplicity, completeness, exampleAbility, transferAbility };
  average: number;
  passed: boolean | "conditional";
  misconceptions: string[];
  stability_after?: number;
  next_review_at: string;
};
```

`concept-notes/index.json` entries keep `last_outcome` and `last_score` (unchanged shape) and gain a pointer to their trajectory plus a derived `mastery` summary (`{ reviews: number, trend: "improving"|"flat"|"declining", stability, retrievability, recurring_misconceptions: string[] }`). `feynman_list_concepts` gains an optional `includeTrajectory` flag so the coach can opt into the full history only when needed, preserving the existing token-frugal default.

Weakness detection (story 7, 16) is a derivation over the trajectory: a concept whose `trend` is `declining` or whose `recurring_misconceptions` is non-empty is surfaced at `/feynman-status`. Cross-project weakness aggregation stays out of scope for this spec (see Out of Scope) — only per-project trajectory and derived summaries land here.

### Score calibration: partial credit

The binary gate `passed = average >= 7 && minScore >= 6` is extended with a narrow near-miss band that produces a third outcome, `CONDITIONAL_PASS`, instead of automatic `CORRECTING`:

```
passed       = average >= 7  && minScore >= 6
conditional  = NOT passed
              && average >= 6.5
              && minScore  >= 5.5
              && correction_rounds >= 1
failed       = otherwise  -> CORRECTING  (unchanged)
```

A `CONDITIONAL_PASS` advances the learner to the next concept (so `current_state` moves to `LEARNING_CONCEPT` like a pass) but tags the concept `needs_reinforcement` and pushes it to the front of the review queue with a short FSRS interval (treated as `Hard` for scheduling). The state machine gains a guarded transition: a `CONDITIONAL_PASS` concept must clear a later review with at least `Good` before it can be marked fully `passed` and lose the `needs_reinforcement` tag. `feynman_validate_transition` rejects advancing past a `CONDITIONAL_PASS` concept without that clearance, so the strictness guarantee is preserved mechanically rather than by prompt.

The `passed` field on score results widens from `boolean` to `boolean | "conditional"`. Tool call sites that branch on `passed` are updated; the `details` payload keeps `passed` for back-compat and adds `outcome: "passed" | "conditional" | "remediating"`.

### Rubric atomization

Each of the five scoring dimensions gets an explicit, atomic "award credit when…" rubric in the `feynman-coach` skill, plus a short list of acceptable alternate phrasings/paths per dimension (e.g. `transferAbility` accepts an alternate analogy that still exercises the same abstraction). This is a skill-text change, not a tool change; it is what mitigates the LLM grader's over-strict tendency (valid partial reasoning or alternate correct approaches being penalized). The tool-level `passed`/`conditional`/`failed` gate is the mechanical backstop; the rubric is the calibration.

### Migration and back-compat

- On first read of a `reviews.json` or `index.json` written by the legacy scheduler, the scheduler backfills `stability`/`difficulty`/`retrievability` from the existing `stage` using a conservative initial-stability estimate (treat `stage k` as `stability ≈ REVIEW_CADENCE_DAYS[k]`), so no learner's schedule is reset.
- The legacy `stage` field is retained on disk for one release so the dashboard site and any external readers keep working; it is derived from `stability` for display.
- `feynman_rebuild_concept_index` recomputes `mastery` summaries from `reviews.json` when rebuilding, so out-of-band edits still converge.

### Out-of-scope adjacent work (explicitly not touched)

- Search-provider abstraction (Tavily stays the only provider).
- Natural-language activation of the protocol injection (slash-command activation stays the trigger).
- Cross-project weakness aggregation into `SOUL.md` (per-project trajectory and summaries land here; writing structured findings back into `SOUL.md` is a later spec).
- Knowledge-graph restructuring of the outline (the outline remains the curriculum spine; only per-concept mastery data is structured).

## Testing Decisions

**Single seam: the existing `tool.execute` harness.** All new behavior is verified through the same pattern already used in the state test suite — register tools via the harness, call `tool.execute(toolCallId, params, signal, onUpdate, ctx)` directly, assert on the returned `details` payload and the on-disk JSON. No new test runner, no new harness, no new seam is introduced.

Good tests here test external behavior only:
- After `record_score` with an `Easy`-band average, `next_review_at` is further out than after a `Hard`-band average for the same concept. (Asserts on the returned schedule, not on FSRS internals.)
- A `CONDITIONAL_PASS` outcome is returned when the average is in `[6.5, 7)` with `minScore >= 5.5` and at least one correction round; the concept is tagged `needs_reinforcement` and its review interval is short.
- Advancing past a `CONDITIONAL_PASS` concept without a later `Good`-or-better review is rejected by `feynman_validate_transition`.
- `feynman_list_concepts` with `includeTrajectory` returns the timestamped review events; without it, the response shape is identical to today.
- `feynman_review_due` returns concepts whose FSRS-computed `next_review_at` has passed, including `needs_reinforcement` ones first.
- A legacy `reviews.json` with only `stage` is read without error and produces a sensible `next_review_at` after backfill.
- The module split introduces no behavior change: the entire existing state test suite passes unchanged against the split modules.

Prior art for these tests is the existing state test file: it already registers tools via a harness, drives `tool.execute` directly, and asserts on `details` plus on-disk JSON under a temp `HOME`. New tests extend the same file (or a sibling using the identical harness) and follow the same `createHarness()` + `call()` convention.

The `review-scheduler` module's pure functions (rating mapping, due computation, graduation decision) may additionally be unit-tested directly for clarity, but that is a secondary convenience — the contract is still proven through the single tool seam above.

## Out of Scope

- Cross-project weakness aggregation into `SOUL.md` (structured per-project trajectory and derived summaries are in scope; writing findings back into `SOUL.md` is not).
- Natural-language activation of the protocol injection.
- Search-provider abstraction beyond Tavily.
- Restructuring the outline into a graph-structured curriculum.
- Any change to the concept-note Markdown template structure (only the correction-round count and misconception retention are read; the template is untouched).
- UI/dashboard redesign beyond keeping the generated site consistent with the new schedule and mastery fields.

## Further Notes

- **Why FSRS over SM-2 or the fixed ladder:** FSRS predicts recall probability and can target a configurable retention level, so schedules adapt to per-concept difficulty rather than treating all concepts identically. It is the current community default (2024–2025) and has a mature TypeScript implementation, keeping the integration surface small.
- **Why partial credit instead of lowering the threshold:** Lowering `average >= 7` to `>= 6.5` globally would let weak concepts through silently. The `CONDITIONAL_PASS` band keeps the full-pass bar at `7/6` while acknowledging near-misses with a tracked reinforcement obligation, preserving rigor.
- **Why split modules in the same spec as the scheduler change:** the scheduler, score gate, and mastery trajectory all live in the same file and share the same migration of `reviews.json`. Splitting first (behavior-preserving) then layering the engine changes on top keeps each diff reviewable and lets the existing suite act as the refactor's safety net.
- **Rating is derived from the rubric score, not collected separately:** this avoids a second grading channel the agent would have to maintain, and keeps the rubric as the single source of truth for both pass/fail and scheduling.
- **Target retention and graduation stability are per-project config,** not global constants, so exam-prep projects can aim higher than casual-learning ones without code changes.
- **Backward compatibility is a hard requirement:** no learner's existing `~/.pi/feynman-projects/` directory may require manual repair after upgrade. The backfill path is the first thing tested.
