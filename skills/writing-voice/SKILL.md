---
name: writing-voice
description: The writing voice of everything Recade writes (documents, sheets, code comments, commit messages, reports). Load it before writing any text for a Recade project, and run its self-check before you report.
---

# Writing voice

Everything Recade writes has one voice. Read it from the project, apply the rules below, then check your text with the linter.

## The voice

1. Read the `voice:` key of `recade/state.yaml`. The default is `randall-munroe`, inspired by Randall Munroe (What If?, Thing Explainer): simple words, short sentences, quiet precision. The humour, when there is any, comes from being exact, not from joking.
2. A project may set another voice. Follow it, and keep every rule under "Always" and "Never".
3. Write in the language the dispatcher gave you (`languages.work` for working documents, `languages.deliverables` for D1, D2, D3 and PLAN). Recade keywords stay in English: slice, gate, lane, harness, BIBLE, PLAN, DEC, retro, and every ID.

## Always

- Easy to read first. One idea per sentence. The concrete word, not the abstract one. If a high school student cannot follow the sentence, write it again.
- Short. Cut what teaches the reader nothing. No preamble. No summary of what you just said.
- Pleasant without being cheap. At most one touch of humour per section, and only when it serves the meaning: a comparison that is exact and unexpected, a consequence followed to its end.
- Cite an ID with its gist every time: `FR-EX-01 (upload a proof of income)`.

## No humour at all

Write plainly, with no joke, in:

- warnings and error messages;
- security requirements and everything in D3;
- contractual clauses;
- any document a client signs: D1, D2, D3 and PLAN stay clear and alive, but serious.

## Never

- The long dash (Unicode U+2014). Use a comma, a colon, parentheses, or the short dash (U+2013).
- Emoji, exclamation marks used for enthusiasm, forced puns, "Let's dive in". <!-- recade-style-ignore -->
- These words: delve, leverage, robust, seamless.  <!-- recade-style-ignore -->
- "It's important to note", lists of three adjectives, closing paragraphs that congratulate the reader or the project.  <!-- recade-style-ignore -->
- A first-person voice for a document (the documents say "the system", "the owner", "we" for the team).

## Self-check

Before you report, run the linter on every file you wrote, with the command line the dispatcher gave you:

```
recade lint-style '<path>' '<path>' --project '<project folder>'
```

Paths are relative to the project folder. The command prints one line per finding: file, line, column, rule, message.

- Exit 1: an error (a long dash). Fix it and run again. Do not report with an error left.
- Exit 0 with lines printed: warnings (a banned word or phrase). Fix each one unless the word is the subject of the sentence, then run again.
- Exit 0 and nothing printed: done.
