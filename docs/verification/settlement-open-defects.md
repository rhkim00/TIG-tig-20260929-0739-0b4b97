# Settlement: what must be closed before this is wired

`apps/cli/src/settle.ts` decides whether a worker is paid. **Nothing in production calls it.**
`grep -rn runSettlementPass apps/cli/src/main.ts apps/cli/src/work.ts` returns nothing, so today's
behaviour is unchanged: the requester types `tig approve`, or the 48-hour timer settles. Today's harm is zero.

It is parked here rather than iterated further because two rounds have not converged:

| round | fixed | found by adversarial verification |
|---|---|---|
| 1 | 7 defects | 22 (3 blocking) |
| 2 | those 22 | 18 (6 blocking), **all new** |

Round two's own two chokepoints are the clearest example of why. It introduced `standDown()`
(ask the server where the reward went) and `stopWatching()` (say it once, then stay quiet) — and the
give-up path routes to `stopWatching()`, so the moment that most needs the question never asks it.

The file is 2,381 lines and carries the task listing, the pass budget, the lock, evidence gathering,
the mechanical rules, the AI reading, the decision, delivery, retry policy, record persistence and the
screen text. Each round's fix lands in one of those and breaks another. Whoever picks this up should
consider whether delivery and retry belong outside the file before closing the list below.

**Read `automatic-validation-decision.md` first.** The blocking question is not whether a diff is enough
to pay, but what happens when tig cannot tell — today that is "pay the worker", and the worker chooses
when to trigger it. Fixing the list below without deciding that will not converge.

A product decision is also open and changes what this code should be: **whether reading a diff, without
running anything, is sufficient grounds to move money.** The user deferred it deliberately.

---

## BLOCKING (6)

### B1 — /data1/rhkim-work/TaskHub/apps/cli/src/settle.ts:1763

The class is NOT closed. The round-2 report names two chokepoints and they do not meet: standDown() is the place that asks the server where the reward went, but it is reachable only from deliver(). retire()/stopWatching() is the place that gives up on a task, and it never asks. A verdict that was POSTed and whose answer was lost leaves through retire(), not standDown(), so tig abandons it asserting the reward never moved.

**Failure:** Task with 30 h of review left. tig refuses on M6 (secret). Pass 1 POSTs; the server commits the refund and the answer is lost on the wire (AbortSignal.timeout, no status). tig correctly prints the hedged line: 'tig cannot tell whether Tokenisgold received this settlement... It may have arrived... tig sends this refusal again on its next run with the same key.' Pass 2 re-POSTs, same outcome; attempts reaches 3. Pass 3: nextSettlementStep returns giveUp, settleOnce takes `retire(gaveUpLine(...))` at :1763, which goes to stopWatching and makes ZERO server calls. Screen: 'tig read this result 3 times without reaching a conclusion and will not read it again; putting the same change to the same model again is your AI usage, not new information.' plus stoppedWatchingLine: 'tig will not check this result again... without an answer the reward is paid to the worker at the review deadline.' Every clause is false: tig read it once and no AI ever ran (aiMayRun was false), the reason was two unanswered POSTs and not an inconclusive reading, and the 40 TIG is already back in the requester's wallet, so it will never be paid at the deadline. The record is left {state:'skipped', decision:'issue', settledAt:null} — the only local trace says no money moved.

**Reproduced:** Ran /tmp/claude-1002/-home-rhkim/e149a803-cc9a-480c-b2da-0a5a7287779f/scratchpad/r2/qA.ts (real settleOnce, 4 passes, POST commits then throws a 15s-timeout Error with no status). Output: pass1/pass2 'decided/issue' with the hedged 'It may have arrived' line; pass3 'skipped/issue' printing gaveUpLine + stoppedWatchingLine; 'A pass4 record: {"state":"skipped","decision":"issue","settledAt":null,"attempts":3}'; 'A server: {"state":"REFUNDED","posts":2,"gets":0}'; 'A any line mentions the reward may have moved? false'. gets=0 proves the server was never asked. Same class reproduced from a second entry point in qB.ts B1 (a decided verdict whose row later arrives with review_due_at null): record 'skipped/issue/settledAt:null', server '{"state":"REFUNDED","posts":1,"gets":0}', screen 'without an answer the reward is paid to the worker at the review deadline'.

### B2 — /data1/rhkim-work/TaskHub/apps/cli/src/settle.ts:1690

stopWatching() will overwrite a record in state 'settled' — the only local trace that money moved — with state 'skipped', and it takes no settlement lock. Its dedupe guard at :1662 only recognises an existing 'skipped' record, and the record it builds at :1683-:1694 copies `decision` and `settledAt` from the base without ever testing whether the base says the reward already moved.

**Failure:** Two tig processes on one computer (exactly what withSettlementLock exists for). Process A settles a task: the server REFUNDS 40 TIG, the record becomes {state:'settled', decision:'issue', settledAt:...}. Process B fetched its task list a second earlier, so its row still says AWAITING_REVIEW; the row carries no review_due_at (or is rejected by taskForSettlement — e.g. the documented '+09:00' offset case). runSettlementPass :2295/:2266 calls stopWatching for that row directly, outside settleOnce and outside the lock. The settled record is rewritten to state 'skipped' while settledAt stays non-null, so it now reads as neither settled nor unsettled, and the screen says 'tig will not check this result again. Read it on Tokenisgold: without an answer the reward is paid to the worker at the review deadline (tig approve <id> --yes, tig issue <id> --yes)' about a task that is already REFUNDED — and the two commands it offers will fail with REVIEW_CLOSED. nextSettlementStep then returns 'tig has already stopped on this result' for ever, so nothing ever repairs it.

**Reproduced:** Ran scratchpad/r2/qE.ts (real settleOnce then real runSettlementPass, one state dir). 'A: settled / issue | record: {"state":"settled","decision":"issue","settledAt":"2026-09-17T14:02:00.000Z"}' then 'B: outcomes 0 | record now: {"state":"skipped","decision":"issue","settledAt":"2026-09-17T14:02:00.000Z","by":"auto"}' with the stoppedWatchingLine quoted above. scratchpad/r2/qD.ts D2 additionally shows stopWatching completing a full write of a settled record from INSIDE another holder's withSettlementLock, i.e. the lock does not apply to it.

### B3 — apps/cli/src/settle.ts:1764

The attempts cap retires an UNDELIVERED VERDICT through retire()/stopWatching() instead of standDown(), so the one give-up that most needs the 'where did the money go' question never asks it, prints a sentence about AI readings that never happened, and leaves decision="issue" on a state="skipped" record — the exact shape standDown() documents as forbidden ('a record that keeps it reads as a refusal that never took place').

**Failure:** Deadline 40 h away. Pass 1 reads the result, M6 finds a secret, decides issue; the POST throws a plain Error with no status (offline / dropped answer) → record decided/issue, attempts=2. Pass 2 re-POSTs, same failure → attempts=3. Pass 3: nextSettlementStep sees attempts>=SETTLE_MAX_ATTEMPTS → giveUp → retire(gaveUpLine(3)). Screen: 'Checked, not settled — … tig read this result 3 times without reaching a conclusion and will not read it again; putting the same change to the same model again is your AI usage, not new information.' tig read it ONCE, reached a conclusion, and no AI ever ran (record.ai === null). GET count stays 0 for the whole life of the task although the POSTs had no status and may have landed, so tig never learns and never says it does not know. Record ends skipped/issue. Pass 4 with the network back: nothing is posted, ever — 37 h before the deadline the 48-hour rule now pays the worker the reward tig had refused for a secret.

**Reproduced:** Reproduced twice, live module: scratchpad/money/pG.ts (settleOnce ×4) and scratchpad/money/pI.ts (real runSettlementPass ×4, network restored on pass 4). pI output: 'pass 1: outcomes=["decided"] posts=1 gets=0 | record decided/issue attempts=2' / 'pass 2: … posts=2 gets=0 … attempts=3' / 'pass 3: outcomes=["skipped"] posts=2 gets=0 | record skipped/issue attempts=3' with the gaveUpLine sentence / 'pass 4 (network back): outcomes=["skipped"] posts=2 gets=0'. tests/settle.test.ts:2657 covers only the give-up on a result that could not be READ (evidence({fetched:false})), never the undelivered verdict, so the suite is green (63/63).

### B4 — apps/cli/src/settle.ts:1027

Moving the SETTLE_MAX_ATTEMPTS test in front of the `decided` branch (settle.ts:1027) put delivery under a cap meant for readings, and deliver() now spends that cap itself (`attempts: decided.attempts + 1`, settle.ts:2021). A verdict that was made and could not be delivered is now thrown away after three attempts: tig never re-POSTs it, never asks the server where the reward went, and prints a line that contradicts its own record. The pre-round-two module re-posted such a verdict for ever with the same stable key. This also punches a hole straight through the implementer's own chokepoint #4 — retire() gives up on delivering and is the one give-up path that never calls standDown()/serverState().

**Failure:** tig refuses a result on a mechanical rule (M8: the files on Tokenisgold do not match the result branch), the network is down. Pass 1 checks it and POSTs: attempts goes 0→1 for the reading and 1→2 for the failed POST, record decided/issue. Pass 2 re-POSTs, fails: attempts 3. Pass 3 (which can be a minute later — a `decided` record has no backoff at all, it is re-posted on every pass) hits the cap and calls retire(), which writes state "skipped" and prints "Checked, not settled — … tig read this result 3 times without reaching a conclusion and will not read it again; putting the same change to the same model again is your AI usage, not new information." over a record that still says decision=issue. tig reached a conclusion on pass 1; it just could not deliver it. From pass 4 on the task is silent for ever, no POST is ever sent again, and at review_due_at the deadline rule pays the worker the 40 TIG that tig had decided to return to the requester. Two minutes offline across three `tig` invocations is enough.

**Reproduced:** /tmp/claude-1002/-home-rhkim/e149a803-cc9a-480c-b2da-0a5a7287779f/scratchpad/lensX/a.test.ts, run against both modules (baseline = scratchpad/r2/settle.before.ts via SETTLE_MODULE). CURRENT: pass1 decided/issue attempts=2; pass2 decided/issue attempts=3; pass3 action=skipped, "tig read this result 3 times without reaching a conclusion…" + "tig will not check this result again…"; passes 4-5 print nothing and post nothing. BEFORE: all five passes decided/issue attempts=1, "Checked, not yet settled — … tig delivers this refusal on its next run." The full suite is green (63/63), so no existing test covers this.

### B5 — apps/cli/src/settle.ts:2163

The AI-slot deferral fix (attempts frozen at settle.ts:2124, nextAttemptAt set to `now` at settle.ts:2163) creates a held state that repeats for ever and that the attempts cap can never reach, so the pass has no fixed point. Every pass re-runs gatherEvidence (a git fetch with no timeout) and re-prints the whole M1–M9 block for each deferred result, and because those records are ready again on the very next pass they hold the front of the queue permanently — undoing D5, the starvation property the prompt said round one got right.

**Failure:** Four results are awaiting review. Sorted by deadline, T0 takes the one AI slot; T1 and T2 are deferred, and their records are written held / attempts 0 / nextAttemptAt = now. On the next pass nextSettlementStep answers "check" for both (attempts never rose, so the cap at :1027 is unreachable), they are fetched and fully re-printed again, and they fill the two remaining SETTLE_MAX_PER_PASS slots. T3 — which may be a brand-new submission — is never looked at: no settlement record is ever written for it, nothing is ever said about it, and the 48-hour rule pays its worker unread. Measured over 12 passes T3 was never once fetched; over 60 passes the pass still did 3 git fetches and 34 screen lines every time, with no sign of draining.

**Reproduced:** /tmp/claude-1002/-home-rhkim/e149a803-cc9a-480c-b2da-0a5a7287779f/scratchpad/lensX/b.test.ts (single task, budget {ai:0}): 8 passes, every one state=held attempts=0 next=<that pass's now> fetches=1..8, the same 11 lines re-printed each time; BEFORE: pass 1 only, then attempts=1, next=+1h, silence. lensX/b3.test.ts (10 waiting): CURRENT holds at 3 fetches / 34 lines per pass through pass 60; BEFORE falls to 1 fetch / 1 line by pass 10. lensX/d.test.ts test F (4 waiting): CURRENT "pass 1..12: fetched T0,T1,T2" and "T3 record: NONE — never looked at"; BEFORE "pass 2: fetched T0,T3", T3 record: held. lensX/f2.test.ts shows T1/T2 rewriting nextAttemptAt to the current pass clock with attempts stuck at 0.

### B6 — apps/cli/src/settle.ts:2316

stopWatching() is permanent — nextSettlementStep answers `skip` for any "skipped" record with the same submission, for ever — but round two routed two recoverable conditions into it: a task Tokenisgold has not yet given a review deadline (settle.ts:2316) and a row this CLI's strict schema could not parse (settle.ts:2291). The chokepoint swallowed a case the pre-round-two module handled correctly. Round one's version of these branches printed a line and kept no record, so the task came back the moment the condition cleared.

**Failure:** Tokenisgold returns an AWAITING_REVIEW task whose review_due_at is still null (or whose row momentarily fails taskForSettlement — a review_due_at carrying a UTC offset, the example the new test itself uses). tig says its line once and writes state "skipped". The server then supplies the deadline / a readable row, with 40 hours of review left. On that pass and every pass afterwards nextSettlementStep returns {action:"skip", reason:"tig has already stopped on this result"}: the result is never read, never settled, and never mentioned again — total silence — and the deadline rule pays the worker. In the schema-drift case this is categorical rather than transient: if the API ever emits offset timestamps, every waiting result is retired on its first pass.

**Reproduced:** /tmp/claude-1002/-home-rhkim/e149a803-cc9a-480c-b2da-0a5a7287779f/scratchpad/lensX/c.test.ts test C and lensX/d.test.ts test G. CURRENT, C: pass1 prints the two lines; pass2 []; pass3 with reviewDueAt = NOW+40h -> said [] and posts 0, record still state "skipped". BEFORE, same script: pass3 -> "Refused and closed: 40.00 TIG is back in your wallet…" plus the full rule block, posts 1, record settled. Test G is identical for the offset row: pass 2 with a readable reviewDueAt settles it on BEFORE and is silent on CURRENT.

---

## SERIOUS (8)

### S1 — /data1/rhkim-work/TaskHub/apps/cli/src/settle.ts:1349

R2 is only half closed. providerLabel/approvalClause can no longer invent 'a local AI', but headline()'s settled+approve branch still describes tig's approval rather than the server's payment: it prints 'Checked and paid' and 'merging the pull request is still your decision' for a result tig REFUSED, because the branch reads only record.decision (the server's outcome) and never what tig itself decided. The replacement clause NO_AI_READING_CLAUSE asserts 'tig settled it on a rule it could prove by reading', which is false on this path — tig did not settle it and the rule it proved said refuse.

**Failure:** tig refuses on M6 alone (a secret in src/parse.ts); no AI runs, record.ai is null. The server answers the issue POST with 200 PAID (review_due_at reached, or clock skew: apps/api/src/lifecycle.ts reviewTask pays at the deadline whatever was posted) — or the requester approves on the web and the POST gets 409 REVIEW_CLOSED, after which standDown's GET returns PAID. Either way the record becomes settled/approve and the first line the requester reads is: 'Checked and paid: 40.00 TIG to the worker — <title>. 1 file changed on tig/results/x: no local AI read this change — tig settled it on a rule it could prove by reading, and nothing was run, and merging the pull request is still your decision.' The requester is invited to merge a change tig refused for containing a secret; the correcting sentence (overriddenLine / settledElsewhereLine) is only line 2, under a first line that contradicts it.

**Reproduced:** Ran scratchpad/r2/qC.ts. C2 (200 PAID on a mechanical refusal): record {state:settled, decision:approve, by:auto, ai:null}; line 1 exactly as quoted, line 2 'tig decided to refuse this result, and Tokenisgold paid the worker 40.00 TIG instead...'. C3 (409 REVIEW_CLOSED then GET PAID): same line 1, by:'user', line 2 settledElsewhereLine. deps.review throws in both runs, so no AI ran.

### S2 — /data1/rhkim-work/TaskHub/apps/cli/src/settle.ts:2010

The retry branch hedges only when `posted.code` is null. Any 5xx whose body is JSON carries a code (apps/api/src/app.ts's error handler sends {code:'INTERNAL_ERROR'}, a gateway's JSON error yields 'REQUEST_FAILED' via client.ts:121), so it takes the confident branch and asserts 'Tokenisgold would not take this settlement yet' — a claim the server refused the settlement, on the one status class the server itself marks retryable:true and where tig cannot know whether the write landed.

**Failure:** The POST reaches the API, reviewTask commits the transfer, and a 502/504 from the reverse proxy (JSON error body) or a 500 raised after COMMIT comes back. postSettlement rethrows (not 4xx), deliver()'s catch makes {outcome:'retry', code:'INTERNAL_ERROR'}, and the screen prints 'Checked, not yet settled — <title>. Tokenisgold would not take this settlement yet (INTERNAL_ERROR: The request could not be completed.); tig delivers this refusal on its next run.' The reward has already moved; the line states the opposite. Contrast the code===null path one line below, which correctly prints undeliveredUnknownLine ('It may have arrived...'). A stable idempotency key makes the re-POST safe, but the screen is not: the requester is told the settlement was rejected.

**Reproduced:** Ran scratchpad/r2/qC.ts C1 with ApiError(500, 'INTERNAL_ERROR: The request could not be completed.') — the exact shape apps/cli/src/client.ts:119 builds from apps/api/src/app.ts:96-127. Output: 'decided/issue' and 'Checked, not yet settled — Fix the CSV importer's date parsing. Tokenisgold would not take this settlement yet (INTERNAL_ERROR: The request could not be completed.); tig delivers this refusal on its next run.'

### S3 — /data1/rhkim-work/TaskHub/apps/cli/src/settle.ts:1779

The entry deadline guard decides from the local clock alone and retires the task permanently without ever asking the server. A clock that is ahead of the server's turns into an irreversible give-up, and the correcting clock never brings the task back because stopWatching wrote state 'skipped', which nextSettlementStep skips for ever.

**Failure:** The review deadline is 10 real hours away; this computer's clock is 10 h 05 m fast (a laptop resumed from suspend, a container with no NTP, a manually set clock). step.action is 'check', due-now <= SETTLE_DEADLINE_MARGIN_MS, so settleOnce retires with DEADLINE_TOO_CLOSE_DETAIL and prints 'Not checked by tig — <title>. The 48-hour review deadline is too close for tig to settle this itself; the deadline rule decides it.' — a claim about the server's clock read off tig's own — plus 'tig will not check this result again.' No GET is made, although a single GET would have returned AWAITING_REVIEW and proved the deadline had not passed (standDown does exactly this GET, but this path does not reach standDown). After the clock is corrected, with 9 hours still left, the next pass is silent and the result is never read: the worker is paid unread at the deadline.

**Reproduced:** Ran scratchpad/r2/qF.ts: 'F pass1 (clock fast): skipped / null | GETs: 0' with the two lines quoted; 'F pass2 (clock fixed, 9h left): skipped / null | record: {"state":"skipped","decision":null} | said: 0'; 'F total GETs to Tokenisgold: 0'. deps.api throws if a POST is attempted, and gatherEvidence/review are never called.

### S4 — apps/cli/src/settle.ts:2021

attempts is incremented twice in the pass that first decides — once by the reading path (:2124) and once by deliver()'s retry branch (:2021) — so a verdict the server never took gets exactly ONE re-POST before the cap retires it.

**Failure:** With SETTLE_MAX_ATTEMPTS=3, a verdict made in pass 1 whose POST fails retryably reaches attempts=2 in that same pass and attempts=3 in pass 2; pass 3 gives up. Two failed POSTs — an hour of an unreachable network, one expired token, one 429 burst — permanently retire a verdict that was still deliverable for 37 more hours. The bound the comment argues for ('three such results took every slot a new submission ever had') is a bound on pass slots, not a reason to count a reading and a delivery as the same attempt.

**Reproduced:** scratchpad/money/pI.ts: one pass with one reading and one POST leaves attempts=2 ('pass 1: … posts=1 … attempts=2'). Same run reaches the cap on pass 2 and retires on pass 3. Read at apps/cli/src/settle.ts:2124 (`base.attempts + (aiDeferred ? 0 : 1)`) and :2021 (`attempts: decided.attempts + 1`), both executed in the single lock body of pass 1.

### S5 — apps/cli/src/settle.ts:1885

standDown()'s not-settled branch writes state="skipped" — terminal for that submission in nextSettlementStep — but never prints stoppedWatchingLine, so the rule 'a task tig has stopped watching is told exactly once' holds at the stopWatching chokepoint and not at the standDown one.

**Failure:** Deadline 40 h away, POST answered 409 IDEMPOTENCY_CONFLICT, GET says the task is still AWAITING_REVIEW. tig records skipped and will never touch the task again (nextSettlementStep → skip 'tig has already stopped on this result'), but the screen says only that re-sending could never change the answer and that the task is AWAITING_REVIEW. Nothing says tig has stopped, nothing names `tig approve/issue <id> --yes`, nothing says the deadline will pay the worker. The requester reads a line about a task still awaiting them and reasonably assumes tig is still watching it. Same gap on the ALREADY_SETTLED/REVIEW_CLOSED branches whenever the GET cannot name a settled state.

**Reproduced:** scratchpad/money/pH.ts case 2, live module: "gets: 1 | outcome: skipped / null | record: skipped / null", "says 'will not check this result again'? false". settlementLines only appends stoppedWatchingLine for state=="held" with nextAttemptAt===null (apps/cli/src/settle.ts:1402), and standDown's print() at :1885 goes through it with state "skipped".

### S6 — apps/cli/src/settle.ts:2324

`if (unnamed) say(unreadableTasksLine(unnamed))` at settle.ts:2324 keeps no record of having said it, so it repeats on every pass for ever. This is R20's defect — the one the prompt named as a round-one regression and asked for a third option — rebuilt at the branch immediately next to the one that was fixed. The `unnamed` counter is also incremented outside any budget, before the SETTLE_MAX_LOOKED_PER_PASS cap. The sentence additionally mixes number: "1 task … so tig did not check it; read them on Tokenisgold".

**Failure:** One row in /v1/tasks?mine=true fails even the loose shape (a non-uuid id, or a requesterId this CLI cannot parse). Every `tig` run — every wizard prompt, every watch cycle — prints "1 task waiting for your review could not be read from Tokenisgold at all…" again, with nothing the requester can do to make it stop and nothing new in it. A line about money repeated on every pass is the noise that hides the real warning, which is the reason round two rewrote the null-deadline branch in the first place.

**Reproduced:** /tmp/claude-1002/-home-rhkim/e149a803-cc9a-480c-b2da-0a5a7287779f/scratchpad/lensX/c.test.ts test D: four consecutive runSettlementPass calls with a single unparseable row print the identical line on passes 1, 2, 3 and 4. The pre-round-two module printed nothing at all here (R17's silence), so this is a swap of one defect for the other, not a fix.

### S7 — tests/settle.test.ts:2805

"a result held only for the AI slot is checked on the very next run" asserts `assert.equal(held?.attempts, 0)` and that nextSettlementStep returns "check" 60 s later. That is not a test of the fix, it is the regression above written down as the intended contract: it pins the one property (attempts frozen) that makes the cap unreachable, and it never asserts that the loop ends or that the record eventually changes.

**Failure:** A future implementer who fixes the unbounded re-read by counting the deferred pass against the cap, or by holding the record until the pass that actually has a slot, will be stopped by a green-suite assertion that says the record must stay at attempts 0 and must be checkable again one minute later. The test locks in a state that repeats for ever and starves the queue.

**Reproduced:** tests/settle.test.ts:2777-2809, read in full. It bites against the pre-round-two module (it fails there, so it is not vacuous), but every assertion in it is satisfied by the looping behaviour demonstrated in lensX/b.test.ts and lensX/d.test.ts test F; nothing in the file asserts a bound on how many passes a deferred result may be re-fetched.

### S8 — tests/settle.test.ts:2718

"a task row this version of tig cannot read is still mentioned once" states a universal in its name but its fixture (reviewDueAt with a UTC offset) only exercises the branch where looseTask succeeds and stopWatching dedupes. The other half of the same `if (!task.success)` block — looseTask fails, `unnamed += 1`, unreadableTasksLine — has no test and repeats on every pass. This is exactly how D6 hid for a round: an assertion that covers one path under a name that claims all of them.

**Failure:** The suite is green and the report says "a task row this version of tig cannot read" is mentioned once, while a requester with one genuinely unnameable row sees the same money sentence on every single pass for ever. Anyone auditing the once-ness rule reads the test name, sees `assert.equal(run.said.length, before)`, and stops looking.

**Reproduced:** tests/settle.test.ts:2718-2731 read in full; the fixture is `awaitingReview({ reviewDueAt: "2026-09-19T14:02:00+09:00" })`, whose id/requesterId/state all parse, so it takes the stopWatching path at settle.ts:2285. The uncovered path is reproduced repeating in lensX/c.test.ts test D.

---

## MINOR (4)

### M1 — /data1/rhkim-work/TaskHub/apps/cli/src/settle.ts:1554

settledDecision() maps anything that is not exactly 'PAID'/'REFUNDED' to null, and postSettlement then throws the state string away, so the one fact the requester could act on is swallowed and the line asserts the server said nothing when it did. The resulting record (state 'settled', decision null) is also skipped by nextSettlementStep as 'already settled' for ever, so tig never re-asks even though one GET would resolve it — standDown's line 'Tokenisgold says this task is <state>' shows the module already knows how to print this.

**Failure:** A 200 whose body names a state this CLI does not map — a new server state ('CANCELLED', 'DISPUTED'), a differently-cased 'paid', a body shape that nests the task ({task:{state:'REFUNDED'}}). tig prints 'Settled, and tig cannot tell how — <title>. tig asked Tokenisgold to refuse this result, and Tokenisgold accepted the settlement without saying what it did with the 40.00 TIG' — but Tokenisgold did say ('CANCELLED'), and that word never reaches the screen or the record. Worse, for a 200 carrying state 'AWAITING_REVIEW' tig records state 'settled' with settledAt set and stops watching for good, although the body it just read says the money did not move.

**Reproduced:** Ran scratchpad/r2/qB.ts B2 with three bodies. All three give 'settled/null', record {state:'settled', decision:null, settledAt:set}, the same 'without saying what it did' line with no trace of the state string, and 'next step: {"action":"skip","reason":"already settled"}'. The AWAITING_REVIEW body produces the same settled record.

### M2 — apps/cli/src/settle.ts:2313

The null-reviewDueAt branch now retires the submission permanently: one pass that reads reviewDueAt as null forfeits tig's review of that result for good, even after the server reports the deadline correctly again.

**Failure:** A row comes back once with reviewDueAt null (an old row, a proxy that drops the field, an API shape change). runSettlementPass calls stopWatching → record skipped for that submissionCommit+taskVersion. Every later pass, with a perfectly good deadline on the row, gets nextSettlementStep → skip 'tig has already stopped on this result' and settles nothing; a result with a secret in it is paid by the 48-hour rule. The original checked it and left a held record it came back to. The requester is told once (so this is not the D7 silence), but 'said once' has been implemented as 'given up on for ever' rather than 'said once, retried when the reason goes away'.

**Reproduced:** scratchpad/money/pJ.ts, real runSettlementPass ×3 with the deadline restored from pass 2 on: 'pass 1 (reviewDueAt=null) … record skipped/null' + the two lines; 'pass 2 (reviewDueAt=2026-09-19T06:02:00.000Z): outcomes=["skipped"] posts=0'; 'pass 3 … posts=0'. Reachability is low against today's API (apps/api/src/lifecycle.ts:209 always sets review_due_at), the same reason R17 was rated minor.

### M3 — apps/cli/src/settle.ts:2021

A single pass can spend two attempts on one task: settle.ts:2124 counts the reading, and if that same pass's POST fails retryably settle.ts:2021 counts it again. With SETTLE_MAX_ATTEMPTS = 3 the cap is reached on the third pass rather than the fourth, and the count the requester is shown is not the number of passes or of readings.

**Failure:** The gaveUpLine printed at give-up reads "tig read this result 3 times without reaching a conclusion" for a result that was read exactly once and posted twice. The number in a money sentence does not correspond to anything the requester can observe.

**Reproduced:** /tmp/claude-1002/-home-rhkim/e149a803-cc9a-480c-b2da-0a5a7287779f/scratchpad/lensX/a.test.ts, pass 1: "action=decided state=decided decision=issue attempts=2" after one settleOnce call. Same in lensX/c.test.ts test E pass 1.

### M4 — tests/settle.test.ts:2831

"one pass does not read a record for every result that is waiting" asserts only `pass.looked === SETTLE_MAX_LOOKED_PER_PASS`. It never asserts anything about the ten waiting results beyond the cap, which now leave the pass with no record read, no outcome and nothing said — the silence the round's own third rule forbids. The cap is defensible (the list is deadline-sorted) but the test does not distinguish a bounded pass from a pass that drops tasks.

**Failure:** A requester with more than twenty waiting results never hears about the tail at all. As deadlines advance they sort forward, so the loss is bounded in practice, but nothing in the suite says so and a later change to the sort would turn it into permanent silence with the suite still green.

**Reproduced:** tests/settle.test.ts:2811-2833 read in full; the only assertions are on `pass.looked` and on the two constants' relative size. settle.ts:2348 breaks out of the loop before `looked += 1` and before any say().

---

