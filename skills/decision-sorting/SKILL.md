---
name: decision-sorting
description: Who settles an open question of the framing, the owner or the team, in the two modes of the decisions setting (ask and trust). The trust test for a DEC and for a stack layer, how the team closes a DEC, and the short summary at each gate. Load it before you sort, ask or close a decision.
---

# Decision sorting

This is the one place that says who settles an open decision during the framing. The commands and the agents cite it. Use it with `writing-voice` for every line the owner reads.

## Two modes

The setting `decisions` of `recade/state.yaml` holds the mode (`recade state show --json`, field `decisions`). The owner picks it in `/recade:new` and changes it with `recade state set decisions <ask|trust>`.

- `ask`, the default: every owner DEC is asked to the owner. A project without the key is `ask`.
- `trust`: the team decides what is reversible and costs nothing. The owner gets only the decisions that cost money, bind the client or cannot be undone.

In both modes a question is sorted first as it opens: `owner` (costly, binding for the client, irreversible, legal, or it changes the scope, the budget or the calendar) becomes a DEC, and `team` (reversible, a technical detail or a convention) goes to `decisions/TEAM.md` and is never a DEC. The trust test below is a second sort. It runs on the DECs, right before they are asked.

## The trust test

In trust mode, read each open DEC before you ask it. It goes to the owner when any one of these is true:

1. **It costs money.** An option needs a licence, a paid service or a hosting tier, or its Cost cell names an amount the client pays.
2. **It binds the client.** It sets or changes the scope, a date, a legal term, or a promise to a third party (a contract, a partner, a public commitment).
3. **It cannot be undone cheaply.** Going back later costs more than a few days of work, or loses data, users or trust.

It also goes to the owner when its file holds no clear recommended option, and when it supersedes another DEC (its front matter has `supersedes:`). A DEC the owner reopened is never sorted again. When in doubt, it goes to the owner.

Otherwise the team takes the recommended option and closes the DEC itself:

`recade decision close '<DEC-nn>' --choice '<letter>' --by team --why '<one line>'`

The letter is the one written in the file for the recommended option. The reason says, in one plain line, why the test lets the team decide: `No cost, binds no one, undone in a day.` The command records a team decision (TD) in `decisions/TEAM.md` with that reason, writes `By: team (TD-nn)` in the Decision box of the DEC, and closes it. Then the DEC is applied like any closed DEC.

Only the dispatching command runs this, and only in trust mode. An agent never closes a DEC.

## The stack in trust mode

The layers are sorted by the same test, with what the analyst knows of the finalists:

- A layer goes to the owner when its finalists differ in money (a licence, a paid service, a hosting tier) or in lock-in (what leaving the option later costs). It is asked as in `stack-selection`: the top 5, then one question.
- A layer with no spike has no finalists (in the short track, a layer whose leader is clear). Compare its top 3 ranked options instead: the layer goes to the owner when they differ in money or in lock-in.
- Any other layer is `team`: the analyst takes rank 1, records it with `recade decision team add --doc 'STACK'` and its reason, and no question is asked.
- A layer imposed by a source or by the owner stays imposed.

In ask mode, language, framework, database, data access and hosting are always the owner's. In both modes the owner passes G2-stack.

## At each gate

The summary stays short. Three parts, in this order, in `languages.chat`:

1. **Decided by the team.** One line for each team decision of the phase: its gist and what was taken, as in `Weekly payouts (TD-03): option B, no cost and reversible.`
2. **What you must answer.** The DECs that went to the owner, asked as the command says.
3. **Details on request.** One line: the DEC files and `decisions/TEAM.md` hold the reasons, and the owner can ask to see any of them.

Then the owner may challenge any team decision. A line that closed a DEC is reopened with `recade decision team challenge '<TD-nn>' --reopen`: it opens a new DEC, a copy whose box is open again, that supersedes the closed one, and the owner answers it. A line that closed no DEC follows the command: the author opens a DEC, then `recade decision team challenge '<TD-nn>' --dec '<DEC-nn>'`.

## What never changes

- The owner says yes at every gate, G0 to G5. Trust mode skips questions, never a gate.
- The guards, the scopes of the slices and the rule that no agent merges are the same in both modes.
- A closed DEC is never edited. A challenge opens a new one.
