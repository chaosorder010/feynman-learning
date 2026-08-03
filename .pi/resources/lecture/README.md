# Lecture Generation Standard (teach-style)

Feynman lectures are generated as short, self-contained HTML lessons following the
`teach` skill philosophy. This directory contains the canonical templates and styles.

## Workspace layout

Every concept (`feynman/` or `lessons/` directory under the project workspace) uses:

```
<workspace>/
├── assets/
│   ├── lecture.css          # shared stylesheet (copy from .pi/resources/lecture/)
│   └── katex/               # local KaTeX (katex.min.css/js + contrib/auto-render + fonts/)
├── reference/
│   ├── roadmap.html         # main-thread map: whole course, current node highlighted
│   └── glossary.html        # canonical terminology (tight definitions, cross-referenced)
├── n{N}-{lesson-1}.html     # one concept = 3 short lessons
├── n{N}-{lesson-2}.html
└── n{N}-{lesson-3}.html
```

## Rules (mandatory)

1. **Split into short lessons.** One concept = 2–3 lessons, each teaching ONE
   tightly-scoped point. Keep each lesson short and completable in minutes.
2. **Breadcrumb.** Every lesson has a `.crumb` line linking to `reference/roadmap.html`
   showing where the concept sits on the main thread.
3. **Interactive quizzes.** Each lesson has 2–3 `.quiz` blocks with instant feedback
   (click an option → correct/wrong highlighting + explanation). Every answer is the
   same length; never leak the answer through formatting.
4. **Term annotations.** On first appearance of a term, use `.term-link` with a `.tip`
   hover note. The full definition lives in `reference/glossary.html`.
5. **Professional body text.** Write standard terminology in the body. If an analogy
   helps, put it in a `.analogy` annotation block AFTER the professional statement —
   never let colloquial phrasing carry the concept itself.
6. **No colorful emoji icons** in headings or content. Plain text headings only.
7. **KaTeX formulas.** Render math with local KaTeX (no CDN). Formulas are centered,
   borderless, in `.formula` blocks.
8. **Primary resource.** Each lesson recommends one high-quality primary source.
9. **Followup reminder.** Each lesson ends with an invitation to ask the teacher.
10. **Cross-links.** Lessons link to prev/next; footer links to roadmap + glossary.

## Generation flow

1. Retrieve source material first (project sources/ — never generate from memory).
2. Build or update `reference/roadmap.html` (project outline → node list).
3. Build or update `reference/glossary.html` (terms used so far, grouped).
4. Write lessons one at a time, opening each in the browser after generation.
5. At the end of the concept, the learner restates (teacher mode) — stuck points are
   weak points to remediate.

## KaTeX setup

```
assets/katex/
├── katex.min.css
├── katex.min.js
├── contrib/auto-render.min.js
└── fonts/                  # all woff2 fonts from the KaTeX dist
```

Copy from a previous workspace or `npx katex@0.16.22` (npm pack → dist/).
