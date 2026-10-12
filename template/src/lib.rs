//! # Dead Drop — the Crypt template
//!
//! Dead Drop lets anyone bury a secret on the Tari Ootle: a stealth tTARI output whose amount is a Pedersen
//! commitment, whose owner is a one-time key, whose memo is encrypted, and whose spend is gated by a condition tree
//! (MAST). The drop itself never touches this template — it is a native stealth UTXO. This template adds the three
//! things the chain does not give you for free:
//!
//! 1. **The cauldron** (`summon`): a newcomer's browser ghost has no funds, and the Esmeralda faucet is empty. The
//!    crypt hands each summoning a small fixed *dose*, which the same transaction turns into a **stealth** output to
//!    the ghost (amount hidden, owner unlinkable). Capped per epoch so nobody drains it in one go; `feed` refills it.
//! 2. **The graveyard** (`bury`): an optional public board. A grave is an epitaph (the riddle), the drop's condition
//!    root, commitment, epochs and public link — never an amount, an owner or the answer. One event; no state growth
//!    beyond a counter.
//! 3. **The witching hour** (`witching_hour`): a spend script (TIP-0006 `TemplateFunction` leaf) for a lock the
//!    native builtins cannot express — a *recurring* window. `AfterEpoch`/`BeforeEpoch` are absolute; this opens the
//!    crypt only while `(epoch - offset) mod period < window`, every period, forever.
//!
//! Written for the Tari October 2026 build contest ("Spooky Secrets"). MIT licensed.

use tari_template_lib::prelude::*;

/// Longest epitaph (riddle) a grave may carry, in bytes. Keeps the event small and the fee predictable.
pub const MAX_EPITAPH_BYTES: usize = 160;

/// Longest public drop link (the public parameters needed to try the riddle: commitment, salt, epochs, refund key).
pub const MAX_LINK_BYTES: usize = 480;

/// How many recent graves the crypt keeps in its own state, so a browser can read the graveyard with one substate
/// fetch (the public indexer does not index custom template events). Older graves fall off; their drops are unaffected.
pub const MAX_GRAVES: usize = 24;

/// The witching-hour window must be strictly shorter than its period, otherwise it is not a lock at all.
pub fn witching_phase_open(epoch: u64, period: u64, offset: u64, window: u64) -> bool {
    assert!(period > 0, "witching hour: period must be positive");
    assert!(
        window > 0 && window < period,
        "witching hour: window must be in 1..period"
    );
    let phase = (epoch % period + period - offset % period) % period;
    phase < window
}

/// The epoch budget rolls over when the epoch changes; returns the amount already spent in `now`'s epoch.
pub fn spent_in_epoch(last_epoch: u64, spent: Amount, now: u64) -> Amount {
    if now == last_epoch {
        spent
    } else {
        Amount::zero()
    }
}

/// A public signpost for a drop: its number, the epoch it was carved, and the drop's public link (riddle, commitment,
/// salt, epochs, one-time refund key). Never an amount, an owner or an answer.
#[derive(Debug, Clone, PartialEq, Eq, minicbor::Encode, minicbor::Decode, minicbor::CborLen)]
pub struct Grave {
    #[n(0)]
    pub id: u64,
    #[n(1)]
    pub epoch: u64,
    #[n(2)]
    pub link: String,
}

/// Appends a grave and drops the oldest beyond `MAX_GRAVES`.
pub fn push_grave(list: &mut Vec<Grave>, grave: Grave) {
    list.push(grave);
    if list.len() > MAX_GRAVES {
        let extra = list.len() - MAX_GRAVES;
        list.drain(0..extra);
    }
}

#[template]
mod dead_drop {
    use super::*;

    pub struct Crypt {
        /// Revealed tTARI waiting to be handed to new ghosts as stealth outputs.
        cauldron: Vault,
        /// What one summoning receives (the stealth output plus the revealed part that pays its own fee).
        dose: Amount,
        /// Most the cauldron hands out in a single epoch.
        epoch_cap: Amount,
        /// Epoch of the last summoning, and how much went out in it.
        last_epoch: u64,
        spent_this_epoch: Amount,
        /// Counters only — no per-ghost state, so a summoning never links two ghosts together.
        summonings: u64,
        graves: u64,
        fed_total: Amount,
        /// The most recent graves (bounded by `MAX_GRAVES`).
        recent_graves: Vec<Grave>,
    }

    impl Crypt {
        /// Opens a crypt with an empty cauldron. The signer becomes its owner (who alone may change the dose).
        pub fn new(dose: Amount, epoch_cap: Amount) -> Component<Self> {
            assert!(dose.is_positive(), "dose must be positive");
            assert!(epoch_cap >= dose, "epoch cap must cover at least one dose");
            let owner = CallerContext::transaction_signer_public_key();
            let access = AccessRules::new()
                .add_method_rule("feed", rule!(allow_all))
                .add_method_rule("summon", rule!(allow_all))
                .add_method_rule("bury", rule!(allow_all))
                .add_method_rule("set_dose", rule!(public_key(owner)))
                .default(rule!(allow_all));
            Component::new(Self {
                cauldron: Vault::new_empty(TARI_TOKEN),
                dose,
                epoch_cap,
                last_epoch: 0,
                spent_this_epoch: Amount::zero(),
                summonings: 0,
                graves: 0,
                fed_total: Amount::zero(),
                recent_graves: Vec::new(),
            })
            .with_owner_rule(OwnerRule::OwnedBySigner)
            .with_access_rules(access)
            .create()
        }

        /// Pours tTARI into the cauldron. Anyone may feed it.
        pub fn feed(&mut self, candy: Bucket) {
            assert_eq!(
                candy.resource_address(),
                TARI_TOKEN,
                "the cauldron only takes tTARI"
            );
            let amount = candy.amount();
            assert!(amount.is_positive(), "an empty bucket feeds no one");
            self.fed_total += amount;
            self.cauldron.deposit(candy);
            emit_event("deaddrop.feed", metadata!["amount" => amount.to_string()]);
        }

        /// Hands one dose to a new ghost as a revealed bucket. The caller's transaction feeds it straight into the
        /// native `StealthTransfer` instruction as its revealed input, producing a stealth output to the ghost's
        /// one-time address (amount hidden, owner unlinkable) plus a sliver that pays the fee. The only public number
        /// is the fixed dose; a summoning records no per-ghost state, so two summonings cannot be linked.
        pub fn summon(&mut self) -> Bucket {
            let now = Consensus::current_epoch();
            let spent = spent_in_epoch(self.last_epoch, self.spent_this_epoch, now);
            assert!(
                spent + self.dose <= self.epoch_cap,
                "the cauldron is resting until the next epoch"
            );
            assert!(
                self.cauldron.balance() >= self.dose,
                "the cauldron is empty"
            );
            self.last_epoch = now;
            self.spent_this_epoch = spent + self.dose;
            self.summonings += 1;
            emit_event(
                "deaddrop.summon",
                metadata!["n" => self.summonings.to_string(), "epoch" => now.to_string()],
            );
            self.cauldron.withdraw(self.dose)
        }

        /// Raises a public tombstone for a drop. Nothing here can move the drop's funds; it is a signpost.
        pub fn bury(
            &mut self,
            epitaph: String,
            condition_root: Hash32,
            commitment: Hash32,
            opens_at_epoch: u64,
            returns_at_epoch: u64,
            link: String,
        ) -> u64 {
            assert!(!epitaph.trim().is_empty(), "a grave needs an epitaph");
            assert!(epitaph.len() <= MAX_EPITAPH_BYTES, "epitaph too long");
            assert!(link.len() <= MAX_LINK_BYTES, "grave link too long");
            let now = Consensus::current_epoch();
            assert!(
                returns_at_epoch > now,
                "this drop has already returned to its sender"
            );
            assert!(
                opens_at_epoch < returns_at_epoch,
                "a drop must open before it returns"
            );
            self.graves += 1;
            push_grave(
                &mut self.recent_graves,
                Grave {
                    id: self.graves,
                    epoch: now,
                    link: link.clone(),
                },
            );
            emit_event(
                "deaddrop.grave",
                metadata![
                    "id" => self.graves.to_string(),
                    "epitaph" => epitaph,
                    "root" => condition_root.to_string(),
                    "commitment" => commitment.to_string(),
                    "opens" => opens_at_epoch.to_string(),
                    "returns" => returns_at_epoch.to_string(),
                    "link" => link,
                    "epoch" => now.to_string()
                ],
            );
            self.graves
        }

        /// Owner-only: change the dose and per-epoch cap.
        pub fn set_dose(&mut self, dose: Amount, epoch_cap: Amount) {
            assert!(dose.is_positive() && epoch_cap >= dose, "invalid dose");
            self.dose = dose;
            self.epoch_cap = epoch_cap;
        }

        /// The most recent graves, oldest first.
        pub fn recent_graves(&self) -> Vec<Grave> {
            self.recent_graves.clone()
        }

        pub fn stats(&self) -> (Amount, Amount, u64, u64) {
            (
                self.cauldron.balance(),
                self.dose,
                self.summonings,
                self.graves,
            )
        }

        /// Spend script: the crypt opens only during the witching hour — while `(epoch - offset) mod period < window`.
        /// Commit it as a `TemplateFunction` leaf with args `[period, offset, window]` (each CBOR-encoded u64).
        pub fn witching_hour(period: u64, offset: u64, window: u64, ctx: SpendContext) {
            assert!(
                witching_phase_open(ctx.current_epoch(), period, offset, window),
                "the crypt is sealed until the witching hour"
            );
        }
    }
}
