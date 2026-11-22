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
- Cite an ID with its gist each time you cite it, and cite it only where it applies. In running text, say the gist first and put the ID after it in parentheses: `upload a proof of income (FR-EX-01)`. The render draws the ID small and muted. In a table, the ID has its own first column.
- Open each main section of a document with one short sentence in the voice, before any table or list. A reader should feel a person wrote it.
- Write to a person, not to a form. Before a table, say in a sentence or two what it holds and why it matters. Say why a rule exists when the reason fits in one sentence.
- Explain a hard idea twice when it helps: first an image from everyday life (a cloakroom ticket, a library card), then the real thing with its real names. The image is exact, short, and never replaces the precise text: the IDs, the numbers and the requirements stay as they are.
- Headings and fixed words are in the language of the document. Translate the headings of D1, D2 and D3. Keep the English headings of the documents that code reads (the PLAN, the STACK tech sheet, the BIBLE, slice sheets).

## Size and audience

A document is read by a busy client, not by a lawyer with a free week. Each project document has a word budget, code blocks excluded and table words counted for half: D1 10,000, D2 9,000, D3 7,000, PLAN 7,000, STACK 6,000, BIBLE 8,000, unless `budgets:` in `recade/state.yaml` says otherwise. The dispatcher gives you the budget that holds for your document, and `recade docs size '<doc>' --project '<project folder>'` prints your words against it. Over the budget is a warning, over 150% of it an error.

- One idea, said once, in the place where it belongs. If two sections say the same thing, keep the better one and cite it from the other.
- Tables only for real tabular data: many items with the same attributes. Three bullets are not a table, and a paragraph is not a table with one row.
- Cite another document by ID with its gist instead of restating it.
- A decision, a provisional value or a rule is named once, where it applies, and listed once in the section for decisions. Do not repeat its ID in every section that touches it.
- When you are over the budget, cut. Do not summarise the cut, and do not move the words into another document.

## No humour at all

Plain is not cold. Keep the warm, direct sentences and the everyday images: an exact comparison is not a joke. Leave out only the jokes, in:

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

For a project document (D1, D2, D3, PLAN, STACK, BIBLE), also run `recade docs size '<doc>' --project '<project folder>'`. A `warn` line means you are over the budget: cut it. An `error` line (over 150%) must be fixed before you report.
