# Challenges

What went wrong, per sprint — and what the wrong turn taught.

`discussions/` records what we decided **before** building. `notes/` records the concepts.
This folder records **what the plan did not survive contact with**: the errors, the dead
ends, the tooling that behaved differently than documented, and the bugs whose visible
symptom pointed somewhere other than the cause.

## Why keep this separately

A clean repo is a lie about how it was built. Three concrete reasons this file exists:

1. **The same trap recurs.** A version-pinning mistake or a silently-mistargeted write
   will happen again in a later sprint, in a new disguise.
2. **Debugging approach is the transferable skill.** Which probe collapsed the search
   space matters more than the fix itself.
3. **Interviews ask about failure.** "Tell me about a bug that took a while" is answered
   badly from memory and well from notes written the same day.

## Format

Each entry:

- **Symptom** — what was actually observed, not the eventual diagnosis
- **What we assumed** — including the wrong assumptions, kept honestly
- **Root cause** — what was really happening
- **Fix**
- **Lesson** — the transferable part; the reason the entry is worth keeping
- **Cost** — roughly how long it took, so the expensive ones stand out

Entries are written **during or immediately after** the sprint. Written later, the
confusion is already forgotten and only the tidy version survives — which is the part
worth the least.

## Index

| Sprint | Module | Challenges |
|---|---|---|
| 1 | Authentication Foundations | [sprint-1.md](sprint-1.md) — 6 entries |
