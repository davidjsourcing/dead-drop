//! Engine tests for the Crypt template, run inside the real Ootle engine (tari_template_test_tooling).
use tari_template_lib::prelude::{Amount, ComponentAddress, Hash32};
use tari_template_test_tooling::TemplateTest;
use tari_template_test_tooling::support::assert_error::assert_reject_reason;
use tari_template_test_tooling::transaction::args;

fn open_crypt(
    test: &mut TemplateTest,
    dose: u64,
    cap: u64,
) -> (
    ComponentAddress,
    tari_template_test_tooling::crypto::RistrettoSecretKey,
    tari_template_lib::types::NonFungibleAddress,
    ComponentAddress,
) {
    let (account, owner_proof, key) = test.create_funded_account();
    let template = test.get_template_address("Crypt");
    let result = test.execute_expect_success(
        test.transaction()
            .call_function(
                template,
                "new",
                args![Amount::from(dose), Amount::from(cap)],
            )
            .build_and_seal(&key),
        vec![owner_proof.clone()],
    );
    let crypt = result.finalize.execution_results[0]
        .decode::<ComponentAddress>()
        .unwrap();
    (crypt, key, owner_proof, account)
}

#[test]
fn new_rejects_zero_dose() {
    let mut test = TemplateTest::my_crate();
    let (_acc, proof, key) = test.create_funded_account();
    let template = test.get_template_address("Crypt");
    let result = test.execute_expect_failure(
        test.transaction()
            .call_function(template, "new", args![Amount::zero(), Amount::from(10u64)])
            .build_and_seal(&key),
        vec![proof],
    );
    assert_reject_reason(result, "dose must be positive");
}

#[test]
fn new_rejects_cap_below_dose() {
    let mut test = TemplateTest::my_crate();
    let (_acc, proof, key) = test.create_funded_account();
    let template = test.get_template_address("Crypt");
    let result = test.execute_expect_failure(
        test.transaction()
            .call_function(
                template,
                "new",
                args![Amount::from(10u64), Amount::from(5u64)],
            )
            .build_and_seal(&key),
        vec![proof],
    );
    assert_reject_reason(result, "epoch cap must cover at least one dose");
}

#[test]
fn bury_emits_a_grave_and_counts() {
    let mut test = TemplateTest::my_crate();
    let (crypt, key, proof, _acc) = open_crypt(&mut test, 1_000_000, 10_000_000);
    let root = Hash32::from_array([7u8; 32]);
    let commitment = Hash32::from_array([9u8; 32]);
    let result = test.execute_expect_success(
        test.transaction()
            .call_method(
                crypt,
                "bury",
                args![
                    "What walks without legs?".to_string(),
                    root,
                    commitment,
                    0u64,
                    1_000u64,
                    "dd1.example".to_string()
                ],
            )
            .build_and_seal(&key),
        vec![proof.clone()],
    );
    let id = result.finalize.execution_results[0]
        .decode::<u64>()
        .unwrap();
    assert_eq!(id, 1);
    let topics: Vec<String> = result
        .finalize
        .events
        .iter()
        .map(|e| e.topic().to_string())
        .collect();
    let grave = result
        .finalize
        .events
        .iter()
        .find(|e| e.topic().ends_with("deaddrop.grave"))
        .unwrap_or_else(|| panic!("grave event missing; topics = {topics:?}"));
    assert_eq!(
        grave.payload().get_str("epitaph").unwrap(),
        "What walks without legs?"
    );
    assert_eq!(grave.payload().get_str("returns").unwrap(), "1000");
    // No amount, no owner ever appears in the public event.
    assert!(!grave.payload().contains_key("amount"));

    // The grave is also kept in the crypt's own state, readable with one substate fetch.
    let result = test.execute_expect_success(
        test.transaction()
            .call_method(crypt, "recent_graves", args![])
            .build_and_seal(&key),
        vec![proof],
    );
    let graves = result.finalize.execution_results[0]
        .decode::<Vec<dead_drop::Grave>>()
        .unwrap();
    assert_eq!(graves.len(), 1);
    assert_eq!(graves[0].id, 1);
    assert_eq!(graves[0].link, "dd1.example");
}

#[test]
fn the_graveyard_keeps_only_the_most_recent_graves() {
    let mut list = Vec::new();
    for id in 1..=(dead_drop::MAX_GRAVES as u64 + 5) {
        dead_drop::push_grave(
            &mut list,
            dead_drop::Grave {
                id,
                epoch: 0,
                link: format!("l{id}"),
            },
        );
    }
    assert_eq!(list.len(), dead_drop::MAX_GRAVES);
    assert_eq!(list.first().unwrap().id, 6);
    assert_eq!(list.last().unwrap().id, dead_drop::MAX_GRAVES as u64 + 5);
}

#[test]
fn bury_rejects_empty_and_long_epitaphs() {
    let mut test = TemplateTest::my_crate();
    let (crypt, key, proof, _acc) = open_crypt(&mut test, 1_000_000, 10_000_000);
    let root = Hash32::from_array([1u8; 32]);
    let r = test.execute_expect_failure(
        test.transaction()
            .call_method(
                crypt,
                "bury",
                args!["   ".to_string(), root, root, 0u64, 10u64, String::new()],
            )
            .build_and_seal(&key),
        vec![proof.clone()],
    );
    assert_reject_reason(r, "a grave needs an epitaph");
    let long = "x".repeat(161);
    let r = test.execute_expect_failure(
        test.transaction()
            .call_method(
                crypt,
                "bury",
                args![long, root, root, 0u64, 10u64, String::new()],
            )
            .build_and_seal(&key),
        vec![proof.clone()],
    );
    assert_reject_reason(r, "epitaph too long");
    let r = test.execute_expect_failure(
        test.transaction()
            .call_method(
                crypt,
                "bury",
                args!["ok".to_string(), root, root, 0u64, 10u64, "l".repeat(481)],
            )
            .build_and_seal(&key),
        vec![proof.clone()],
    );
    assert_reject_reason(r, "grave link too long");
}

#[test]
fn bury_rejects_a_drop_that_opens_after_it_returns() {
    let mut test = TemplateTest::my_crate();
    let (crypt, key, proof, _acc) = open_crypt(&mut test, 1_000_000, 10_000_000);
    let root = Hash32::from_array([1u8; 32]);
    let r = test.execute_expect_failure(
        test.transaction()
            .call_method(
                crypt,
                "bury",
                args!["late".to_string(), root, root, 50u64, 40u64, String::new()],
            )
            .build_and_seal(&key),
        vec![proof],
    );
    assert_reject_reason(r, "a drop must open before it returns");
}

#[test]
fn only_the_owner_can_change_the_dose() {
    let mut test = TemplateTest::my_crate();
    let (crypt, key, proof, _acc) = open_crypt(&mut test, 1_000_000, 10_000_000);
    // owner succeeds
    test.execute_expect_success(
        test.transaction()
            .call_method(
                crypt,
                "set_dose",
                args![Amount::from(2_000_000u64), Amount::from(20_000_000u64)],
            )
            .build_and_seal(&key),
        vec![proof],
    );
    // a stranger is refused
    let (_a, stranger_proof, stranger_key) = test.create_funded_account();
    test.execute_expect_failure(
        test.transaction()
            .call_method(
                crypt,
                "set_dose",
                args![Amount::from(9u64), Amount::from(9u64)],
            )
            .build_and_seal(&stranger_key),
        vec![stranger_proof],
    );
}

#[test]
fn feed_fills_the_cauldron() {
    let mut test = TemplateTest::my_crate();
    let (crypt, key, proof, account) = open_crypt(&mut test, 1_000_000, 10_000_000);
    let tari = tari_template_lib::prelude::TARI_TOKEN;
    test.execute_expect_success(
        test.transaction()
            .call_method(account, "withdraw", args![tari, Amount::from(5_000_000u64)])
            .put_last_instruction_output_on_workspace("candy")
            .call_method(crypt, "feed", args![Workspace("candy")])
            .call_method(crypt, "stats", args![])
            .build_and_seal(&key),
        vec![proof],
    );
}

#[test]
fn witching_phase_math() {
    use dead_drop::witching_phase_open as open;
    // period 24, offset 0, window 1: open only at epochs ≡ 0 (mod 24)
    assert!(open(0, 24, 0, 1));
    assert!(open(48, 24, 0, 1));
    assert!(!open(1, 24, 0, 1));
    assert!(!open(23, 24, 0, 1));
    // offset shifts the window
    assert!(open(12_157, 24, 12_157 % 24, 2));
    assert!(open(12_158, 24, 12_157 % 24, 2));
    assert!(!open(12_159, 24, 12_157 % 24, 2));
}

#[test]
#[should_panic(expected = "window must be in 1..period")]
fn witching_rejects_window_equal_period() {
    dead_drop::witching_phase_open(5, 10, 0, 10);
}

#[test]
fn epoch_budget_rolls_over() {
    use dead_drop::spent_in_epoch;
    assert_eq!(
        spent_in_epoch(5, Amount::from(30u64), 5),
        Amount::from(30u64)
    );
    assert_eq!(spent_in_epoch(5, Amount::from(30u64), 6), Amount::zero());
}

fn feed(
    test: &mut TemplateTest,
    crypt: ComponentAddress,
    account: ComponentAddress,
    key: &tari_template_test_tooling::crypto::RistrettoSecretKey,
    proof: &tari_template_lib::types::NonFungibleAddress,
    amount: u64,
) {
    let tari = tari_template_lib::prelude::TARI_TOKEN;
    test.execute_expect_success(
        test.transaction()
            .call_method(account, "withdraw", args![tari, Amount::from(amount)])
            .put_last_instruction_output_on_workspace("candy")
            .call_method(crypt, "feed", args![Workspace("candy")])
            .build_and_seal(key),
        vec![proof.clone()],
    );
}

#[test]
fn summon_hands_out_exactly_one_dose_and_respects_the_epoch_cap() {
    let mut test = TemplateTest::my_crate();
    let (crypt, key, proof, account) = open_crypt(&mut test, 1_000_000, 2_000_000);
    feed(&mut test, crypt, account, &key, &proof, 10_000_000);
    let tari = tari_template_lib::prelude::TARI_TOKEN;
    // two summonings fit in the epoch cap; the dose lands in the summoner's account here (in the app it becomes a
    // stealth output via the native StealthTransfer instruction in the same transaction)
    for _ in 0..2 {
        let (ghost, ghost_proof, ghost_key) = test.create_funded_account();
        test.execute_expect_success(
            test.transaction()
                .call_method(crypt, "summon", args![])
                .put_last_instruction_output_on_workspace("dose")
                .assert_bucket_contains_exactly("dose", tari, Amount::from(1_000_000u64))
                .call_method(ghost, "deposit", args![Workspace("dose")])
                .build_and_seal(&ghost_key),
            vec![ghost_proof],
        );
    }
    // the third in the same epoch is refused
    let (ghost, ghost_proof, ghost_key) = test.create_funded_account();
    let r = test.execute_expect_failure(
        test.transaction()
            .call_method(crypt, "summon", args![])
            .put_last_instruction_output_on_workspace("dose")
            .call_method(ghost, "deposit", args![Workspace("dose")])
            .build_and_seal(&ghost_key),
        vec![ghost_proof],
    );
    assert_reject_reason(r, "the cauldron is resting until the next epoch");
}

#[test]
fn summon_from_an_empty_cauldron_fails_cleanly() {
    let mut test = TemplateTest::my_crate();
    let (crypt, _key, _proof, _account) = open_crypt(&mut test, 1_000_000, 2_000_000);
    let (ghost, ghost_proof, ghost_key) = test.create_funded_account();
    let r = test.execute_expect_failure(
        test.transaction()
            .call_method(crypt, "summon", args![])
            .put_last_instruction_output_on_workspace("dose")
            .call_method(ghost, "deposit", args![Workspace("dose")])
            .build_and_seal(&ghost_key),
        vec![ghost_proof],
    );
    assert_reject_reason(r, "the cauldron is empty");
}

#[test]
fn feed_refuses_an_empty_bucket() {
    let mut test = TemplateTest::my_crate();
    let (crypt, key, proof, account) = open_crypt(&mut test, 1_000_000, 2_000_000);
    let tari = tari_template_lib::prelude::TARI_TOKEN;
    let r = test.execute_expect_failure(
        test.transaction()
            .call_method(account, "withdraw", args![tari, Amount::zero()])
            .put_last_instruction_output_on_workspace("candy")
            .call_method(crypt, "feed", args![Workspace("candy")])
            .build_and_seal(&key),
        vec![proof],
    );
    assert_reject_reason(r, "an empty bucket feeds no one");
}
