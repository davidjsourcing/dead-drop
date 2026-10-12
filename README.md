# Dead Drop 🪦

**Bury a secret on Tari. Only the right words can raise it.**

Dead Drop hides a message *and* some tTARI inside a single stealth output on the Tari Ootle. Nobody watching the chain can see how much is in it, who it's for, or what it says. You share a link with a riddle on it. Whoever answers the riddle can read the secret in their browser and raise the tTARI into their own wallet. If nobody answers in time, it comes back to you.

- **Play it:** {{APP_URL}} (Esmeralda testnet, nothing to install; the crypt gives your browser ghost its first tTARI)
- **Watch it (2:30):** {{VIDEO_URL}}
- **Template on Esmeralda:** `{{TEMPLATE}}` · **Crypt component:** `{{CRYPT}}`
- Built for the Tari October 2026 build contest, "Spooky Secrets". MIT licensed.

## What makes it private: five Ootle features, one output

| Layer | Ootle feature | What it hides |
|---|---|---|
| Hidden weight | Pedersen commitment + Bulletproofs+ range proof | the amount |
| No name on the stone | stealth one-time address | who the drop is for (the address is derived from the *answer*, not from anyone's wallet) |
| A sealed letter | encrypted output memo | the secret message |
| The words, never spoken | spend-condition tree (MAST, TIP-0006) with an `AccessRule` leaf | the answer: claiming needs a **signature** from the answer-derived key, so the answer never appears on-chain or in the mempool |
| Return to sender / time capsule / witching hour | `BeforeEpoch` / `AfterEpoch` builtins + a custom WASM spend script (`witching_hour`, a `TemplateFunction` leaf) | when it can be raised, and a refund path that only reveals a one-time key |

The **X-ray** page reads any drop twice: once exactly as the public indexer returns it, once with the answer. Same output, two readings.

## How it works

```
 bury (sender's browser)                                   raise (solver's browser)
 ───────────────────────                                   ────────────────────────
 answer ──scrypt(salt)──► answer keypair                   answer ──scrypt(salt)──► same keypair
 stealth output:                                           decrypt memo + amount locally (wrong answer: nothing)
   to   = answer key (one-time address)                    spend RAISE leaf, signed by the answer key,
   memo = secret (encrypted to it)                         into the solver's own ghost
   pay_to = Conditions [                                  
     RAISE : sig(answer key) ∧ BeforeEpoch(deadline) [∧ AfterEpoch(open)] [∧ witching_hour(...)]
     RETURN: AfterEpoch(deadline) ∧ sig(one-time refund key)
   ]
 link = #/d/<commitment, salt, riddle, refund pubkey, epochs>   (URL fragment: never sent to any server)
```

The **Crypt** template (Rust → WASM, `template/src/lib.rs`, ~170 lines) adds what the chain doesn't give you for free:

1. **The cauldron (`summon`)**: a faucet for newcomers. The official Esmeralda faucet is empty, so the crypt hands a fixed dose to a brand-new browser ghost, and *the same transaction* turns it into a stealth output (amount hidden, owner unlinkable). It keeps no per-ghost state, so summonings can't be linked. Capped per epoch.
2. **The graveyard (`bury`)**: an optional public board of riddles. A grave is an event with the epitaph, condition root, commitment and epochs. Never an amount, an owner or an answer.
3. **The witching hour (`witching_hour`)**: a reusable spend script for something the builtins can't express, a *recurring* window: the drop can only be raised while `(epoch − offset) mod period < window`.

`app/src/core/` is a small TypeScript module for **script-path stealth spends** (building the witness, the balance proof and the signatures by hand), because the official SDK's high-level transfer only signs key-path spends today. Reuse it.

## What it hides, and what it doesn't (threat model)

**Hidden from everyone without the answer:** the amount, the secret, the answer itself, which wallet buried it, and which wallet raised it.

**Public:** that a stealth output exists; its condition-tree root; its epochs once it is spent (the revealed leaf); the fee; and, *only if you choose the public graveyard*, the riddle text and dates.

**Know these limits:**
- **A riddle is only as strong as its answer.** Anyone with the link can guess offline. We slow each guess with scrypt (N=2¹⁵, ~0.3 s in a browser), but "cat" falls in seconds. Use an answer your friend knows and a dictionary doesn't.
- **First solver wins.** Two people who both know the answer race; the chain takes whichever valid raise lands first. A solver can't steal from another solver's transaction, because the answer is never revealed: the raise is a signature.
- **No randomness is used for anything secret.** Template randomness on Ootle isn't adversarially safe; every secret here comes from the sender's own words and keys (commit, then reveal by signature).
- **Your ghost lives in your browser** (localStorage). Clear the site's data and it's gone. Back it up from the Ghost page. It's a testnet toy wallet, not a vault.
- **Timing and network metadata** (your IP to the indexer, when you submit) are outside what a ledger can hide.
- The crypt's dose and every grave are public by design.

## Run it

```bash
# template (Rust → WASM) and its engine tests
cd template && cargo test && cargo build --release --target wasm32-unknown-unknown

# web app + unit tests
cd app && npm ci && npm test && npm run build      # static site in app/dist

# live end-to-end run on Esmeralda (needs a funded walletd for the one-off funding step)
npm run e2e -- all
```

Tests and the latest live run are in [TEST-REPORT.md](../TEST-REPORT.md).

## Credits & honesty

Built by David J. I used an AI coding agent for much of the legwork (reading the Ootle docs and SDK, drafting code and tests); I directed the design and checked everything on the live testnet. Testnet tTARI has no value. MIT licence.
