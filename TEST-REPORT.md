# Dead Drop: test report

Updated 2026-10-12 07:00 UTC. Everything below was run on this box against the **live Tari Ootle Esmeralda testnet** (indexer `ootle-indexer-a.tari.com`, network v0.45.0) or locally where marked. No mocks in the live runs. tTARI is testnet money with no value.

**Deployed on Esmeralda**
- Crypt template: `57d02c26b94121ce11a8ad9b93e9ac19e8acea190b5d12f16a6e420e41c25bd7`
- Crypt component: `component_2ef70ea3131676f968c035d6162f4d1dfd5894d1dfae4fd700d3e2a2f669d479` (dose 2 tTARI, cap 12 tTARI per epoch)
- Cauldron vault: `vault_2e8a1bd9ca585a54ec6d0c44e700c106152644016ddea9012a994e0245ad9967`
- App: https://dead-drop.sites.tab.bot/ (the deployed files were checked byte-for-byte against the build with GET)

## Summary

| Suite | Where | Result |
|---|---|---|
| Template engine tests (`cargo test`, real Ootle engine via `tari_template_test_tooling`) | local | **14 / 14 pass** (last run 2026-10-12 05:34 UTC; the template source has not changed since) |
| `cargo fmt --check`, `cargo clippy` | local | clean |
| App unit tests (`vitest`: KDF, link codec, condition trees, CBOR, answer normalisation) | local | **15 / 15 pass** (07:00 UTC) |
| Live protocol end-to-end (`npm run e2e -- all`) | Esmeralda | **14 / 14 checks pass** (05:38 UTC, epoch 12159-12160) |
| Live return-to-sender (`npm run e2e -- return`) | Esmeralda | refused at epochs 12160 and 12161, **accepted at 12162** |
| Live browser end-to-end (`scripts/ui-e2e.cjs`, two fresh browsers, the deployed site) | Esmeralda + live site | **7 / 7 pass** (06:55 UTC) |
| Accessibility (axe-core, WCAG 2 A/AA + best practice, 6 pages × desktop + mobile) | local build | **0 violations** (the first run in this pass found 6 kinds of issue across the 12 page/viewport combinations) |
| Horizontal overflow at 390 px | local build | none on any page |

That is **23 live testnet checks** (14 + 2 + 7), all passing.

## Live protocol run (05:38 UTC)
Log: `app/.e2e/run-2026-10-12T05-38-35-386Z.json`.

| Check | Result | Transaction |
|---|---|---|
| crypt is deployed | PASS |  |
| summon: a fresh ghost receives a hidden dose from the cauldron | PASS | `3404e4d9ad42c192…` |
| summon: the chain record names neither the ghost's address nor its public key | PASS |  |
| bury: the drop is a single stealth UTXO with a two-leaf condition tree | PASS | `09609dfa573a9b05…` |
| x-ray: the on-chain output holds no amount, no secret and no answer in the clear | PASS |  |
| peek: a wrong answer cannot decrypt the drop | PASS |  |
| peek: the right answer reveals the secret and the hidden amount, locally | PASS |  |
| raise: the drop moves to the solver's ghost (value minus fee) | PASS | `b0c57ab9c2ce9e3e…` |
| raise: the drop is spent and can't be raised twice | PASS |  |
| witching hour (closed window): the template's spend script refuses the raise | PASS |  |
| witching hour (open window): raise succeeds | PASS | `6fae1f2e200ef4ef…` |
| bury #2 (left for return-to-sender) | PASS | `8c1514f3a3d0e531…` |
| graveyard: the grave is posted as a public event (epitaph + root, no amount, no owner) | PASS | `115fc9938c16d1c5…` |
| graveyard: the indexer lists the new grave | PASS |  |

## Return to sender (the timelock leaf)
The drop buried in the run above with `returnsAt = 12161` was used here:
- 06:06 UTC, epoch 12160: the network refused it: `Spend condition not met: builtin predicate not satisfied: AfterEpoch(12161)`.
- 06:28 UTC, epoch 12161: refused again with the same error. **`AfterEpoch(n)` is strict**, so the sender can take a drop back only once the epoch is past `n`. The UI said "reaches" and offered the button one epoch early; fixed (it now waits until the epoch is past, and the text says so).
- 06:56 UTC, epoch 12162: **accepted**. The sender's one-time refund key took it back (tx `46365460cbe161dfbca0711e675083196a300005d59dc6f18f9f4d9f5177407b`).

## Live browser run on the deployed site (06:55 UTC)
Two separate browser contexts (two fresh ghosts, no wallet, no extension):

| Check | Result |
|---|---|
| UI bury (auto-summon for an empty ghost, then bury) | PASS (131s ) |
| UI wrong answer is refused locally | PASS  |
| UI right answer decrypts the secret in the browser | PASS (Meet me at the old oak at midnight. Bring a lantern.) |
| UI raise into the solver's ghost | PASS (62s) |
| solver ghost now holds tTARI | PASS (0.49 tTARI) |
| X-ray shows the drop as spent | PASS  |
| no page errors | PASS  |

Screenshots: `app/.e2e/ui-live/`. The bury took 131 s (summon from the crypt, then bury, two transactions), the raise 62 s.

## Bugs found and fixed in this pass
1. **Return button one epoch early** (see above): `AfterEpoch` is strict. Fixed in My drops and in the graveyard's "returnable" state.
2. **Offering larger than the first dose burned a summon.** A new ghost asked to offer 3 tTARI summoned 2, then failed. Now it checks before summoning, and the form tells newcomers the limit ("offer up to 1.9").
3. **My drops never showed "raised".** The status was saved but the row didn't update; it now updates live.
4. **Empty toast pill** visible at the bottom of every page; hidden now.
5. **Sky gradient ended at one screen height** on long pages; it now lives on a fixed layer.
6. **Mobile had no navigation** (the nav was hidden under 820 px); it's now a scrollable row.
7. Accessibility: low-contrast hint and footer text, no `h1` on inner pages, an unlabeled input, an empty table header, links distinguished only by colour, skipped heading levels. All fixed; axe reports 0.

## Oct 13 additions: Midnight Grave, privacy receipt, hunt page

- **Indexer upgrade check.** The public indexer now reports v0.46.0 (was 0.45 on Oct 12). Chain reads (epoch, graves, crypt stats, cauldron balance 31 tTARI) still work with the app's 0.45 WASM SDK, and so do bury, post-grave and dry-run raise (below).
- **Midnight Grave seeded** (`scripts/midnight.ts`, epoch 12222, 15:18 UTC): 1 tTARI drop with an `AfterEpoch(13031)` raise condition and return after 13660, posted as public grave #8. Bury tx `a8399084e0a263bfd30c5339b32346d915b7c3b2f4e0e1b7bf9db5a31e4f3efa`, grave tx `5f235693ba5e3e49e4a562c667b44412391e31e9b3538d884f18f6b40626af21`.
- **The lock holds.** Straight after seeding, the script opened the drop with the right answer (the memo decrypted) and tried to raise it into a fresh key. The network refused at the dry run: `the network would reject this: {"ExecutionFailure":{"code":"InvalidProof","message":"At instruction #1: Spend condition not met: builtin predicate not satisfied: AfterEpoch(13031)"}}`. Nothing was spent.
- **Unit tests: 20/20** (5 new: the privacy audit finds nothing in a real stealth output and does catch a leaked amount or secret in decimal, hex, upper-case and byte-array form; the indexer URL; `AfterEpoch` strictness in the countdown; epoch time estimate).
- **Browser run, local build and then the deployed site** (`scripts/ui-oct13.cjs`, real Chromium, live testnet): **8/8 both times.** Hunt page lists the 3 steps and the finale; the Midnight Grave reads SEALED from the chain; the raise page shows the time-lock line; the right answer prints a privacy receipt with 5 rows, all "not in public data"; clicking Raise shows the validators' refusal `AfterEpoch(13031)`; X-ray with an answer prints a clean 3-row receipt; the hunt page has no horizontal overflow at 390 px; no page errors.
- **Fix:** epoch labels assumed 60-minute epochs. Measured: epoch 12161 at Oct 12 06:28 UTC, 12222 at Oct 13 15:10 UTC, so about 32 minutes on average (epochs are irregular: 12222 lasted more than 25 minutes on Oct 13). Labels now use 32 and say "≈".

## What is not tested (honest gaps)
- Weak answers can be brute-forced offline (scrypt N=2^15 slows this down but doesn't stop it). That is by design and stated in the README.
- The witching-hour window was tested at the epoch it opened and outside it, not across a full 24-epoch cycle.
- Some small test drops from early failed runs (before the e2e saved its drops) cannot be returned because their refund keys were never stored. They hold a few tTARI between them, testnet only.
- One older crypt (v1, `component_5b6254dd…`) still holds about 34 tTARI. The template has no withdraw, so it stays there. The app uses v2 only.
- CI (GitHub Actions) runs the unit tests and the template build on every push; live testnet runs are manual, because they spend testnet coins and need epochs to pass.

## How to reproduce
```
cd template && cargo test                       # 14 engine tests
cd app && npm ci && npx vitest run              # 15 unit tests
cd app && npm run e2e -- all                    # live run (needs a funded bank ghost in app/.e2e/keys.json)
cd app && npm run e2e -- return                 # after the return epoch has passed
BASE=https://dead-drop.sites.tab.bot/ node scripts/ui-e2e.cjs   # live browser run
```


## Oct 30 2026 re-check (submit day)
- **Indexer v0.47 changed its response shape** (the substate now sits under `state.up`). The app read the old shape, so the graveyard and hunt pages showed no graves and an answered riddle said "the grave is already empty". Fixed in `core/chain.ts` and `core/drop.ts` (accept both shapes; a spent output has no `up`).
- After the fix: 20/20 unit tests; `ui-e2e.cjs` **7/7** against the live testnet (bury with auto-summon 24 s, wrong answer refused, right answer decrypts, raise 12 s, X-ray shows spent); `ui-oct13.cjs` **8/8** on the deployed site (hunt, Midnight lock, privacy receipt, validators' `AfterEpoch(13031)` refusal, mobile layout, no page errors).
- **Epoch length re-measured:** epoch 12222 (Oct 13 15:18 UTC) → 12733 (Oct 30 13:05 UTC) = ~48 min per epoch, not ~32. The Midnight Grave therefore opens around Nov 9, not Halloween; labels updated.
