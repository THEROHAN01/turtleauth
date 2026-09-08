---
description: Write first-principles notes for a completed TurtleAuth submodule or module
argument-hint: [module/submodule, e.g. "1/4" or "module 1" — omit to infer from conversation]
allowed-tools: Read, Write, Edit, Bash(ls:*), Bash(find:*), Bash(cat:*), Bash(sed:*), Glob, Grep
---

# Take notes

Write learning notes for the TurtleAuth roadmap into `notes/`.

**Target:** $1 — if empty, infer from what we just covered in this conversation. If you
cannot infer it confidently, ask rather than guess.

## Source of truth

Write **only** from what was actually taught or built in this conversation, plus code now
in the repo. Do not invent coverage, pad from background knowledge, or write notes for
material we have not reached. A thin, accurate note beats a complete-looking fabricated one.

If a topic in the roadmap's checklist was not covered, leave it out — do not fill the gap.

## Where notes go

`notes/module-<n>-<module-slug>/<k>-<submodule-slug>/notes.md`

Folders already exist for every submodule of all six modules. Match the existing slug
exactly; never create a parallel folder. Check with `ls notes/` first.

If a `notes.md` already exists, **extend or revise it** rather than overwriting — we may
revisit a topic after building, and later understanding should sharpen the note, not
replace it. Preserve anything still correct.

## Voice and standard

Write as a **senior engineer reasoning from first principles**, for a reader who will build
and debug this system — not as a tutorial or a glossary.

Every note follows one arc:

1. **What was the problem?** The concrete constraint or failure that made this exist.
   Start here. A mechanism explained without its problem is unmemorable.
2. **What is the solution?** The mechanism, and *why it is shaped that way*.
3. **What are the limitations?** What it does **not** solve, what it costs, what it makes
   harder, and which later module picks up the slack.

Section 3 is non-negotiable. A note that only says how something works teaches the
what-not the judgment.

## Rules

- **Precise, not long.** Roughly 60–150 lines. Cut anything that doesn't change how you'd
  build, debug, or decide.
- **Compare in tables** when contrasting options (algorithms, flags, attack classes).
- **Show the shape** — small ASCII flows or code sketches for mechanisms. Illustrative
  pseudocode over copy-paste implementation.
- **Name the trade-off explicitly.** Every security control costs something (latency, CPU,
  UX, operational complexity). State it. If you cannot name a cost, you don't understand it yet.
- **Flag common misconceptions** where they exist, especially where the naive answer is
  wrong for a subtle reason.
- **Forward-link** to the module that resolves a limitation ("→ Module 3 rate limiting").
- Close with an **Interview answers** section — only for the roadmap's Day-N interview
  questions this submodule genuinely answers. Two or three sharp answers; skip the section
  if none apply.
- No filler: no "in today's fast-moving world", no restating the heading, no summary of the
  summary.

## After writing

Update `notes/README.md`: flip the entry's `[ ]` to `[x]` and make it a relative markdown
link to the new file. Keep the existing ordering and formatting.

Then report to the user, briefly:
- files written or revised (as clickable relative paths)
- anything from the roadmap's checklist for that submodule we have **not** yet covered, so
  the gap is visible rather than silently missing
