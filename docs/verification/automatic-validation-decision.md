# Automatic validation: the decision that has to come before more code

The requester-side automatic review is built and **not wired**. Nothing in production calls it:

```
$ grep -rn runSettlementPass apps/cli/src/main.ts apps/cli/src/work.ts
(nothing)
```

So today's behaviour is unchanged — the requester types `tig approve`, or the 48-hour timer settles —
and today's harm is zero. This document explains why we stopped adding code to it, and what has to be
decided before anyone starts again.

## The finding

The design rests on one asymmetry, and it is a good one:

> The AI may move a result from **hold** to **approve**. It may never move one toward a **refund**.
> Only the mechanical rules may take a worker's money back. When the reviewer cannot tell, it **holds**.

Holding was treated as the safe default, on the reasoning that nobody loses money while a decision waits.

**That reasoning is wrong, because a hold is not where the story ends.** At the 48-hour review deadline the
platform pays the worker (`apps/api/src/lifecycle.ts`, `settle(tx, task, "paid", "review_timeout")`). So:

> **hold → 48 hours → paid.** A hold is a slow approval that nobody reviewed.

That would be tolerable if holds were rare accidents. They are not: **the worker decides when one happens.**
Round two of the reviewer tightened the guard, and tightening it *widened* the set of holds — every one of
which the worker can trigger, deniably, with one file:

| what the worker commits | why it holds | how it looks |
|---|---|---|
| any image, or any non-UTF-8 file | tig cannot read the blob, so it is "unread" | added a logo |
| a file whose name addresses the reviewer | the name is treated as an injection attempt | named a file badly |
| a change that makes the model fill `risks` | the model's own caveat blankets every check | ordinary code |

Each of those reaches the deadline unread, and the deadline pays. One verifier reached `approve` on four
separate changes that did not do the work.

**This is why the guard work does not converge.** Making the reviewer stricter converts "approve" into
"hold", and "hold" is "pay". The safer the code gets against one attack, the more routes it opens to the
same outcome. No further round of defect-fixing changes that, because it is not a defect — it is the shape
of the system.

## The decision

The question we thought was open was *"is reading a diff, without running anything, sufficient grounds to
pay?"*. That is a real question but it is not the blocking one. The blocking one is:

> **What should happen when tig cannot tell?**

Today the answer is "pay the worker", and the worker chooses when to ask it.

| option | what it means | cost |
|---|---|---|
| **Stop the clock** | a hold suspends `review_due_at` until the reviewer or the requester resolves it | server change; a task can sit in escrow indefinitely unless a ceiling is added |
| **Require a human** | a hold never auto-pays; it waits for the requester, who is told what to look at | server change; the requester must actually come back, and today notifications are pull-only |
| **Refund on unread** | tig could not read it, so the worker is not paid | punishes an honest worker who committed a PNG; inverts the asymmetry the design exists to protect |
| **Leave it** | ambiguity pays the worker | the marketplace pays for work nobody verified, on the worker's own trigger |

The first two need a way to reach the requester that does not depend on them running `tig` again: `tig watch`
is a local file watcher and does not poll the server, and notices only appear on the next CLI run.

## Decided: leave it (rhkim00, 2026-09-17)

**Ambiguity pays the worker.** Neither the server nor the CLI changes; `review_due_at` keeps settling at
48 hours whatever the reviewer concluded. This is a deliberate acceptance, not an oversight, and what is
being accepted is specific:

> A worker who wants to be paid without doing the work can commit one file tig cannot read — an image, a
> non-UTF-8 source file — or give a file a name the reviewer treats as addressed to it. Either forces a
> hold, the hold reaches the deadline, and the deadline pays. Both are deniable.

That risk is bounded today because **nothing calls this code**, so the only path to payment is the requester
typing `tig approve` or the timer running out — exactly as before any of this was written. The acceptance
becomes live the moment `runSettlementPass` is wired into a command, and whoever does that wiring owns this
decision. The open defect lists below should be closed first; several of them are the same attack by other
routes and are worth closing whatever the payment policy is.

Revisit this if the marketplace ever carries rewards large enough to be worth gaming, or if holds turn out
to be common on honest work — the reviewer's round two widened what holds considerably, and nobody has
measured how often an ordinary result trips it.

## Where the code stands

Two rounds of adversarial verification on each half. Both closed their predecessor's list and both were
handed a new one, which is the pattern above rather than carelessness.

| | round 1 | round 2 |
|---|---|---|
| `settle.ts` (decide, settle) | fixed 7 → **22 found** (3 blocking) | fixed those 22 → **18 found** (6 blocking), all new |
| `result-review.ts` + `result-git.ts` | built → **16 found** (5 blocking) | **12 of 12 closed**, verified against their own probes → **22 found** (3 blocking) |

The reviewer's round two is genuinely better and worth keeping: the guard now asks one question of one list
(`shownPaths`), citations are tokenised and compared exactly, the model's free-text `note` no longer reaches
the changed-path test, an unreadable blob lands in `truncated`, and both fetches are `--depth 2`. Three
independent verifiers reproduced each closure rather than reading for it.

`settle.ts` is the harder problem and not only because of the decision above. It is 2,381 lines carrying the
task listing, the pass budget, the lock, evidence gathering, the mechanical rules, the AI reading, the
decision, delivery, retry policy, record persistence and the screen text. Round two's own two chokepoints
illustrate the cost: it added `standDown()` (ask the server where the reward went) and `stopWatching()`
(say it once, then stay quiet) — and the give-up path routes to `stopWatching()`, so the moment that most
needs the question never asks it. Before closing that list, consider whether delivery and retry belong
outside the file.

## Three findings worth keeping whatever is decided

**A refusal can rest on something the worker never sent.** M7 (`checkRefusedFiles`) refuses on
`untrackedNotShared`, which comes from `plan.json` on the requester's own machine. A refund is supposed to
rest on something read out of the worker's commit.

**The guard can check where, not what.** It can assert that a cited path was really changed and that the
cited line falls inside a hunk tig sent. It cannot assert that the claim is true *at* that line, and nothing
else does either. The cheapest attack — a citation that is real but does not say what it is claimed to say —
is untouched by both rounds.

**A file with no `@@` header slips the "was it shown" test.** An empty new file, or a mode change with no
content change, produces a complete hunk with no line ranges, so it is neither in `truncated` nor covered by
any range.

## The full defect lists

`docs/verification/settlement-open-defects.md` has the 18 from `settle.ts`, each with the scenario that
reproduces it. The reviewer's 22 are in the workflow output referenced from that file. Every one was
reproduced by a verifier driving the real exported functions, not read out of the source.
