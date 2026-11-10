//! Paylink — payment links on NEAR.
//!
//! A payee records what they are owed. A payer settles it by sending NEP-141
//! tokens with the link id in `msg`. The *token contract* is what invokes
//! [`Contract::ft_on_transfer`], so payment status is written by the token
//! contract — there is no method anywhere in this file that lets a user assert
//! "this link was paid" without actually paying.
//!
//! Money out: `claim` is callable by anyone but can only ever pay the invoice's
//! payee (minus a fixed 0.5% fee to a fee account set once in `new`). That lets
//! the frontend trigger it the moment a link is paid, so the payee does
//! nothing.
//!
//! Units: all timestamps are **milliseconds since the Unix epoch**. Nanoseconds
//! (NEAR's native `env::block_timestamp()` unit) overflow JavaScript's
//! `Number`, which every browser caller would hit, so the boundary converts
//! once: `env::block_timestamp() / 1_000_000`.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near, require,
};

/// Storage stake taken when an invoice is created. Covers the state it writes
/// (~0.002 NEAR at current prices) plus the payee's token registration
/// (`PAYEE_REGISTRATION_DEPOSIT`) with headroom, so nobody can drain this
/// contract's balance by spamming empty invoices.
const CREATE_STORAGE_STAKE: NearToken = NearToken::from_millinear(10); // 0.01 NEAR

const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const CLAIM_CALLBACK_GAS: Gas = Gas::from_tgas(10);
const STORAGE_DEPOSIT_GAS: Gas = Gas::from_tgas(10);

/// NEP-145 deposit attached per registration so an account can hold a token
/// balance. The test token's minimum is 0.00125 NEAR; 0.01 NEAR leaves headroom
/// for any other token, and `registration_only: true` makes the token keep only
/// its minimum and refund the difference.
const STORAGE_DEPOSIT_PER_TOKEN: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

/// Deposit sent to register an invoice's payee on the invoice's token, paid out
/// of the creation stake. Already-registered payees get it refunded in full.
const PAYEE_REGISTRATION_DEPOSIT: u128 = 5_000_000_000_000_000_000_000; // 0.005 NEAR

/// Fee taken from the payee's payout at `claim`, in basis points (50 = 0.5%).
/// A constant, not state: it can only change through a visible code upgrade.
pub const FEE_BPS: u128 = 50;
const BPS_DENOMINATOR: u128 = 10_000;

const MAX_DESCRIPTION_LEN: usize = 280;
const MAX_LINK_ID_LEN: usize = 64;
const MIN_LINK_ID_LEN: usize = 4;

/// Lifecycle of an invoice.
///
/// `Expired` is never stored: it is derived on read from `expires_at`, so a
/// link that quietly ages out is reported honestly without a background job
/// having to rewrite it.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "UPPERCASE")]
pub enum Status {
    Open,
    Paid,
    Claimed,
    Expired,
}

/// One invoice. Borsh-serialized at rest, JSON-serialized when read.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Link {
    pub link_id: String,
    /// Who is owed the money. `claim` always pays this account, whoever calls it.
    pub creator: AccountId,
    /// Invoiced amount, in the token's base units.
    pub amount: U128,
    /// The one NEP-141 token this invoice denominated in.
    pub token: AccountId,
    pub description: String,
    /// ms since epoch.
    pub created_at: u64,
    /// ms since epoch. `None` = never expires.
    pub expires_at: Option<u64>,
    pub status: Status,
    pub paid_by: Option<AccountId>,
    /// What actually arrived — may exceed `amount` if the payer overpaid.
    pub paid_amount: Option<U128>,
    pub paid_at: Option<u64>,
    pub claimed_at: Option<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// link id -> invoice. The hot path: point lookups only.
    links: LookupMap<String, Link>,
    /// creator -> their link ids. Only the requesting creator's list is loaded.
    by_creator: LookupMap<AccountId, Vec<String>>,
    /// Token contracts this deployment accepts. Set once in [`Contract::new`];
    /// there is deliberately no setter, so widening it requires a visible
    /// code upgrade rather than a quiet call.
    allowed_tokens: LookupSet<AccountId>,
    /// Receives the fee at `claim`. Set once in [`Contract::new`], no setter.
    fee_account: AccountId,
}

/// Split a credited amount into `(payee payout, fee)`.
///
/// The fee is `amount * FEE_BPS / 10_000`, rounded down, computed so it cannot
/// overflow even for `u128::MAX`. `payout + fee == amount` always, and the
/// payout is never zero for a non-zero amount.
pub fn split_fee(amount: u128) -> (u128, u128) {
    let fee =
        amount / BPS_DENOMINATOR * FEE_BPS + (amount % BPS_DENOMINATOR) * FEE_BPS / BPS_DENOMINATOR;
    (amount - fee, fee)
}

/// JSON args for a NEP-141 `ft_transfer`.
fn ft_transfer_args(receiver: &AccountId, amount: u128) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "receiver_id": receiver,
        "amount": U128(amount),
    }))
    .expect("args serialize")
}

/// JSON args for a NEP-145 registration-only `storage_deposit`.
fn register_args(account: &AccountId) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "account_id": account,
        "registration_only": true,
    }))
    .expect("args serialize")
}

#[near]
impl Contract {
    /// Initialise the contract. Only the contract account itself can call this
    /// (`#[private]`), so a stranger cannot initialise it first if it was
    /// deployed without an init call. Deploy and init in one command.
    ///
    /// Registers this contract and the fee account as balance holders with every
    /// allowlisted token.
    ///
    /// Registration is not optional. NEP-141's reference implementation panics
    /// when either side of a transfer is unregistered, so without it every
    /// incoming payment (`ft_transfer_call` to this contract) and every
    /// `claim` (`ft_transfer` from this contract, plus the fee transfer) would
    /// fail. The attached deposit funds two NEP-145 storage balances per
    /// allowlisted token.
    #[init]
    #[private]
    #[payable]
    pub fn new(allowed_tokens: Vec<AccountId>, fee_account: AccountId) -> Self {
        require!(
            !allowed_tokens.is_empty(),
            "at least one token must be allowed"
        );

        let needed = STORAGE_DEPOSIT_PER_TOKEN
            .saturating_mul(2)
            .saturating_mul(allowed_tokens.len() as u128);
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(needed),
            "attach at least 0.02 NEAR per allowlisted token so the contract and the fee account can register with them"
        );

        let mut allowed = LookupSet::new(b"a");
        for token in &allowed_tokens {
            allowed.insert(token.clone());
            for who in [env::current_account_id(), fee_account.clone()] {
                let _ = Promise::new(token.clone()).function_call(
                    "storage_deposit".to_string(),
                    register_args(&who),
                    NearToken::from_yoctonear(STORAGE_DEPOSIT_PER_TOKEN),
                    STORAGE_DEPOSIT_GAS,
                );
            }
        }

        Self {
            links: LookupMap::new(b"l"),
            by_creator: LookupMap::new(b"c"),
            allowed_tokens: allowed,
            fee_account,
        }
    }

    // ── payee ────────────────────────────────────────────────────────────

    /// Record an invoice. Holds no funds and grants nobody a withdrawal; it
    /// only writes down what someone is owed, and registers the creator on the
    /// invoice's token — a best-effort call that `claim` repeats before
    /// paying out, so the payout cannot fail for want of an account.
    #[payable]
    pub fn create_link(
        &mut self,
        link_id: String,
        amount: U128,
        token: AccountId,
        description: String,
        expires_at: Option<u64>,
    ) -> Link {
        let creator = env::predecessor_account_id();

        require!(
            env::attached_deposit() >= CREATE_STORAGE_STAKE,
            "attach at least 0.01 NEAR to cover storage"
        );
        require!(
            self.allowed_tokens.contains(&token),
            "this token is not accepted"
        );
        require!(amount.0 > 0, "amount must be greater than zero");
        require!(
            !description.trim().is_empty() && description.len() <= MAX_DESCRIPTION_LEN,
            "description must be 1-280 characters"
        );
        require!(
            link_id.len() >= MIN_LINK_ID_LEN && link_id.len() <= MAX_LINK_ID_LEN,
            "link id must be 4-64 characters"
        );
        require!(self.links.get(&link_id).is_none(), "link id already used");

        let now = now_ms();
        if let Some(exp) = expires_at {
            require!(exp > now, "expiry must be in the future");
        }

        // Fire and forget: if the creator is already registered the token
        // refunds this in full; if the call fails for any reason, creating
        // the invoice still succeeds — `claim` re-runs this registration
        // before every payout, so a failed attempt here never strands money.
        let _ = Promise::new(token.clone()).function_call(
            "storage_deposit".to_string(),
            register_args(&creator),
            NearToken::from_yoctonear(PAYEE_REGISTRATION_DEPOSIT),
            STORAGE_DEPOSIT_GAS,
        );

        let link = Link {
            link_id: link_id.clone(),
            creator: creator.clone(),
            amount,
            token,
            description,
            created_at: now,
            expires_at,
            status: Status::Open,
            paid_by: None,
            paid_amount: None,
            paid_at: None,
            claimed_at: None,
        };

        self.by_creator
            .entry(creator)
            .or_default()
            .push(link_id.clone());
        self.links.insert(link_id, link.clone());

        link
    }

    // ── payer ────────────────────────────────────────────────────────────
    //
    // Reached only through `ft_transfer_call`, so `predecessor_account_id` is
    // the token contract and cannot be spoofed by a user.

    /// NEP-141 receiver hook. Returns the number of tokens *not* consumed:
    /// returning `amount` hands everything back to the sender (the token
    /// contract refunds automatically), returning `0` means it was all used.
    ///
    /// Every rejection path returns the full amount, so a failed payment costs
    /// the payer nothing — including the payee who tries to settle their own
    /// link, which is refused outright.
    #[payable]
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();

        // Accept only allowlisted token contracts. Without this, any contract
        // calling `ft_on_transfer` could mark an invoice paid for free.
        if !self.allowed_tokens.contains(&token) {
            return amount;
        }

        // `msg` names exactly one link. Anything unrecognised is refunded.
        // Cloned out of the map so the borrow ends before the write-back below.
        let Some(mut link) = self.links.get(&msg).cloned() else {
            return amount;
        };

        // Wrong token for this invoice, or already settled.
        if link.token != token || link.status != Status::Open {
            return amount;
        }

        // The payee cannot pay their own link. A payment link exists to be
        // paid by somebody else; letting the creator through would let anyone
        // manufacture their own `PAID` state, and `claim` would hand the
        // tokens straight back minus the fee. Refunded like every other
        // rejection — the link stays `OPEN` until a real payer arrives.
        if sender_id == link.creator {
            return amount;
        }

        // Underpaid, or too late. Refund in full.
        if amount.0 < link.amount.0 {
            return amount;
        }
        if let Some(exp) = link.expires_at {
            if now_ms() >= exp {
                return amount;
            }
        }

        link.status = Status::Paid;
        link.paid_by = Some(sender_id);
        link.paid_amount = Some(amount);
        link.paid_at = Some(now_ms());
        self.links.insert(msg, link);

        // Everything received is credited. Nothing is retained for us.
        U128(0)
    }

    // ── payout ───────────────────────────────────────────────────────────

    /// Release a paid invoice to its payee, less the 0.5% fee. Callable by
    /// anyone — the money can only go to the invoice's payee and the fee
    /// account, never to the caller — only while the link is `PAID`, and only
    /// once.
    ///
    /// Requires exactly 1 yoctoNEAR. Each `ft_transfer` needs 1 yocto; this
    /// contract covers the second one from its own balance.
    ///
    /// The payout and the fee go out as one batch to the token contract, so
    /// they succeed or fail together: `on_claimed` can put the invoice back to
    /// `PAID` and nothing is ever half-paid.
    ///
    /// Before any money moves, the payee is registered on the token again.
    /// `create_link`'s registration is fire-and-forget; this is the retry, so
    /// a registration that never landed cannot strand a paid invoice. The
    /// payout batch runs after it either way: if the payee is still
    /// unregistered the batch fails, `on_claimed` returns the invoice to
    /// `PAID`, and the next attempt — frontend or keeper — starts over.
    #[payable]
    pub fn claim(&mut self, link_id: String) -> Promise {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "attach exactly 1 yoctoNEAR"
        );

        let mut link = match self.links.get(&link_id).cloned() {
            Some(l) => l,
            None => env::panic_str("link not found"),
        };
        require!(link.status == Status::Paid, "link is not paid");

        let payee = link.creator.clone();
        let token = link.token.clone();
        let credited = link.paid_amount.unwrap_or(link.amount).0;
        let (payout, fee) = split_fee(credited);

        // Mark claimed *before* the transfer so a second claim cannot be
        // issued while this one is in flight. `on_claimed` reverts it to PAID
        // if the transfer fails, so nothing is ever stranded.
        link.status = Status::Claimed;
        link.claimed_at = Some(now_ms());
        self.links.insert(link_id.clone(), link);

        let one_yocto = NearToken::from_yoctonear(1);
        let mut transfers = Promise::new(token.clone()).function_call(
            "ft_transfer".to_string(),
            ft_transfer_args(&payee, payout),
            one_yocto,
            FT_TRANSFER_GAS,
        );
        // A zero-amount ft_transfer is rejected by NEP-141 tokens, so tiny
        // invoices (fee rounds to 0) skip the fee leg instead of failing.
        if fee > 0 {
            transfers = transfers.function_call(
                "ft_transfer".to_string(),
                ft_transfer_args(&self.fee_account, fee),
                one_yocto,
                FT_TRANSFER_GAS,
            );
        }

        // Register the payee first, then pay. `create_link` fires the same
        // registration without waiting for the result; this is the retry,
        // paid for out of the contract's own balance (an already-registered
        // payee is refunded in full). Success or failure, the payout batch
        // runs next — still unregistered means it fails, `on_claimed` sends
        // the invoice back to `PAID`, and the next attempt starts over.
        Promise::new(token)
            .function_call(
                "storage_deposit".to_string(),
                register_args(&payee),
                NearToken::from_yoctonear(PAYEE_REGISTRATION_DEPOSIT),
                STORAGE_DEPOSIT_GAS,
            )
            .then(transfers)
            .then(Promise::new(env::current_account_id()).function_call(
                "on_claimed".to_string(),
                serde_json::to_vec(&json!({ "link_id": link_id })).expect("args serialize"),
                NearToken::from_near(0),
                CLAIM_CALLBACK_GAS,
            ))
    }

    /// Settles `claim`. On failure the invoice returns to `PAID` so anyone can
    /// simply retry — the money is never lost and never double-sent.
    #[private]
    pub fn on_claimed(
        &mut self,
        link_id: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }

        if let Some(mut link) = self.links.get(&link_id).cloned() {
            if link.status == Status::Claimed {
                link.status = Status::Paid;
                link.claimed_at = None;
                self.links.insert(link_id, link);
            }
        }
        false
    }

    // ── reads ────────────────────────────────────────────────────────────

    pub fn get_link(&self, link_id: String) -> Option<Link> {
        let mut link = self.links.get(&link_id).cloned()?;
        link.status = self.effective_status(&link);
        Some(link)
    }

    pub fn get_links_by_creator(&self, creator: AccountId) -> Vec<Link> {
        let Some(ids) = self.by_creator.get(&creator) else {
            return Vec::new();
        };
        ids.iter()
            .filter_map(|id| self.links.get(id).cloned())
            .map(|mut l| {
                l.status = self.effective_status(&l);
                l
            })
            .collect()
    }

    pub fn is_token_allowed(&self, token: AccountId) -> bool {
        self.allowed_tokens.contains(&token)
    }

    /// Account that receives the fee at `claim`.
    pub fn fee_account(&self) -> AccountId {
        self.fee_account.clone()
    }

    /// Fee in basis points (50 = 0.5%). Lets the frontend show "you receive X".
    pub fn fee_bps(&self) -> u32 {
        FEE_BPS as u32
    }

    /// How many invoices a creator has. Cheap count for a dashboard header.
    pub fn link_count_by_creator(&self, creator: AccountId) -> u64 {
        self.by_creator
            .get(&creator)
            .map(|ids| ids.len() as u64)
            .unwrap_or(0)
    }
}

impl Contract {
    /// An open invoice past its deadline reports `EXPIRED` rather than
    /// pretending it is still payable.
    fn effective_status(&self, link: &Link) -> Status {
        if link.status == Status::Open {
            if let Some(exp) = link.expires_at {
                if now_ms() >= exp {
                    return Status::Expired;
                }
            }
        }
        link.status
    }
}

fn now_ms() -> u64 {
    env::block_timestamp() / 1_000_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts, get_created_receipts};
    use near_sdk::testing_env;

    const TOKEN: &str = "usdc.fakes.testnet";
    const CONTRACT: &str = "paylink.testnet";
    const FEE_ACCOUNT: &str = "fees.testnet";

    fn token() -> AccountId {
        TOKEN.parse().unwrap()
    }

    fn fee_account() -> AccountId {
        FEE_ACCOUNT.parse().unwrap()
    }

    fn ctx(predecessor: &str) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        let who: AccountId = predecessor.parse().unwrap();
        builder
            .current_account_id(CONTRACT.parse().unwrap())
            .signer_account_id(who.clone())
            .predecessor_account_id(who);
        builder
    }

    fn setup() -> Contract {
        // `new()` is payable: it funds two NEP-145 storage balances per token
        // (this contract and the fee account).
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(CONTRACT.parse().unwrap())
                .attached_deposit(NearToken::from_yoctonear(STORAGE_DEPOSIT_PER_TOKEN * 2))
                .build()
        );
        Contract::new(vec![token()], fee_account())
    }

    /// A link for `amount` base units, never expiring.
    fn open_link_for(contract: &mut Contract, creator: &str, id: &str, amount: u128) -> Link {
        testing_env!(ctx(creator).attached_deposit(CREATE_STORAGE_STAKE).build());
        contract.create_link(
            id.to_string(),
            U128(amount),
            token(),
            "Brand identity".to_string(),
            None,
        )
    }

    /// A link for 100 base units, never expiring.
    fn open_link(contract: &mut Contract, creator: &str, id: &str) -> Link {
        open_link_for(contract, creator, id, 100)
    }

    /// Drive `ft_on_transfer` as the token contract would.
    fn pay(contract: &mut Contract, from: &str, amount: u128, msg: &str) -> U128 {
        testing_env!(ctx(TOKEN).build());
        contract.ft_on_transfer(from.parse().unwrap(), U128(amount), msg.to_string())
    }

    fn claim_as(contract: &mut Contract, caller: &str, id: &str) {
        testing_env!(
            ctx(caller)
                .attached_deposit(NearToken::from_yoctonear(1))
                .build()
        );
        let _ = contract.claim(id.to_string());
    }

    /// Every `(function, json args)` the contract queued toward `receiver`,
    /// flattened across receipts, in order.
    fn calls_to(receiver: &str) -> Vec<(String, near_sdk::serde_json::Value)> {
        let mut out = Vec::new();
        for receipt in get_created_receipts() {
            if receipt.receiver_id.as_str() != receiver {
                continue;
            }
            for action in receipt.actions {
                if let near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name, args, ..
                } = action
                {
                    out.push((
                        String::from_utf8(method_name).unwrap(),
                        near_sdk::serde_json::from_slice(&args).unwrap(),
                    ));
                }
            }
        }
        out
    }

    // ── fee maths ────────────────────────────────────────────────────────

    #[test]
    fn split_fee_is_half_a_percent_rounded_down() {
        assert_eq!(split_fee(10_000), (9_950, 50));
        assert_eq!(split_fee(1_000_000), (995_000, 5_000));
        // Below 200 base units the fee rounds to zero.
        assert_eq!(split_fee(1), (1, 0));
        assert_eq!(split_fee(199), (199, 0));
        assert_eq!(split_fee(200), (199, 1));
        assert_eq!(split_fee(399), (398, 1));
    }

    #[test]
    fn split_fee_never_overflows_or_loses_a_unit() {
        for amount in [
            0,
            1,
            199,
            200,
            9_999,
            10_000,
            10_001,
            u128::MAX / 2,
            u128::MAX,
        ] {
            let (payout, fee) = split_fee(amount);
            assert_eq!(payout + fee, amount, "amount {amount}");
            assert!(fee <= amount / 199, "fee too large for {amount}");
            if amount > 0 {
                assert!(payout > 0, "payout must not be zero for {amount}");
            }
        }
    }

    // ── creation ─────────────────────────────────────────────────────────

    #[test]
    fn create_link_records_an_open_invoice() {
        let mut c = setup();
        let link = open_link(&mut c, "alice.near", "lnk-one");

        assert_eq!(link.status, Status::Open);
        assert_eq!(link.amount, U128(100));
        assert_eq!(link.creator, "alice.near".parse::<AccountId>().unwrap());

        let fetched = c.get_link("lnk-one".to_string()).unwrap();
        assert_eq!(fetched.amount, U128(100));
        assert_eq!(c.link_count_by_creator("alice.near".parse().unwrap()), 1);
    }

    #[test]
    fn create_link_registers_the_creator_on_the_token() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-reg");

        let calls = calls_to(TOKEN);
        assert_eq!(calls.len(), 1, "one storage_deposit toward the token");
        assert_eq!(calls[0].0, "storage_deposit");
        assert_eq!(calls[0].1["account_id"], "alice.near");
        assert_eq!(calls[0].1["registration_only"], true);
    }

    #[test]
    #[should_panic(expected = "this token is not accepted")]
    fn create_link_rejects_a_token_that_is_not_allowlisted() {
        let mut c = setup();
        testing_env!(
            ctx("alice.near")
                .attached_deposit(CREATE_STORAGE_STAKE)
                .build()
        );
        c.create_link(
            "lnk-x".to_string(),
            U128(100),
            "evil.testnet".parse().unwrap(),
            "hi".to_string(),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "attach at least 0.01 NEAR")]
    fn create_link_requires_a_storage_stake() {
        let mut c = setup();
        testing_env!(ctx("alice.near").build());
        c.create_link(
            "lnk-y".to_string(),
            U128(100),
            token(),
            "hi".to_string(),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "attach at least 0.01 NEAR")]
    fn the_old_too_small_stake_is_now_rejected() {
        // The stake used to be 0.001 NEAR while the message promised 0.01.
        let mut c = setup();
        testing_env!(
            ctx("alice.near")
                .attached_deposit(NearToken::from_millinear(1))
                .build()
        );
        c.create_link(
            "lnk-z".to_string(),
            U128(100),
            token(),
            "hi".to_string(),
            None,
        );
    }

    #[test]
    fn the_stake_really_is_ten_millinear() {
        assert_eq!(
            CREATE_STORAGE_STAKE,
            NearToken::from_yoctonear(STORAGE_DEPOSIT_PER_TOKEN)
        );
    }

    #[test]
    #[should_panic(expected = "link id already used")]
    fn create_link_rejects_a_duplicate_id() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-dup");
        open_link(&mut c, "alice.near", "lnk-dup");
    }

    // ── payment ──────────────────────────────────────────────────────────

    #[test]
    fn payment_marks_paid_and_consumes_the_full_amount() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-pay");

        // Returning 0 means "all tokens used" — none come back to the payer.
        let unused = pay(&mut c, "bob.near", 100, "lnk-pay");
        assert_eq!(unused, U128(0));

        let link = c.get_link("lnk-pay".to_string()).unwrap();
        assert_eq!(link.status, Status::Paid);
        assert_eq!(
            link.paid_by.unwrap(),
            "bob.near".parse::<AccountId>().unwrap()
        );
        assert_eq!(link.paid_amount, Some(U128(100)));
        assert!(link.paid_at.is_some());
    }

    #[test]
    fn the_payee_cannot_pay_their_own_link() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-self");

        // Alice tries to settle her own invoice: everything comes back, the
        // link stays OPEN, and `paid_by` can never be the creator.
        assert_eq!(pay(&mut c, "alice.near", 100, "lnk-self"), U128(100));
        let link = c.get_link("lnk-self".into()).unwrap();
        assert_eq!(link.status, Status::Open);
        assert!(link.paid_by.is_none());

        // Somebody else still settles it — and pays themselves back the fee.
        assert_eq!(pay(&mut c, "bob.near", 100, "lnk-self"), U128(0));
        assert_eq!(c.get_link("lnk-self".into()).unwrap().status, Status::Paid);
    }

    #[test]
    fn an_unlisted_token_gets_a_full_refund_and_changes_nothing() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-fake");

        // A different contract claiming to be a token: everything comes back.
        testing_env!(ctx("faketoken.testnet").build());
        let unused = c.ft_on_transfer("bob.near".parse().unwrap(), U128(100), "lnk-fake".into());

        assert_eq!(unused, U128(100));
        assert_eq!(c.get_link("lnk-fake".into()).unwrap().status, Status::Open);
    }

    #[test]
    fn a_payment_that_names_no_link_is_refunded() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-real");
        assert_eq!(pay(&mut c, "bob.near", 100, "no-such-link"), U128(100));
        assert_eq!(c.get_link("lnk-real".into()).unwrap().status, Status::Open);
    }

    #[test]
    fn an_underpayment_is_refunded_in_full() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-short");

        assert_eq!(pay(&mut c, "bob.near", 99, "lnk-short"), U128(99));
        assert_eq!(c.get_link("lnk-short".into()).unwrap().status, Status::Open);
    }

    #[test]
    fn an_overpayment_is_credited_in_full() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-over");

        assert_eq!(pay(&mut c, "bob.near", 250, "lnk-over"), U128(0));
        let link = c.get_link("lnk-over".into()).unwrap();
        assert_eq!(link.status, Status::Paid);
        assert_eq!(link.paid_amount, Some(U128(250)));
    }

    #[test]
    fn paying_twice_does_not_double_credit() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-once");

        assert_eq!(pay(&mut c, "bob.near", 100, "lnk-once"), U128(0));
        // Second attempt is refused wholesale; the tokens come straight back.
        assert_eq!(pay(&mut c, "bob.near", 100, "lnk-once"), U128(100));
        assert_eq!(
            c.get_link("lnk-once".into()).unwrap().paid_amount,
            Some(U128(100))
        );
    }

    #[test]
    fn an_expired_invoice_cannot_be_paid() {
        let mut c = setup();
        testing_env!(
            ctx("alice.near")
                .attached_deposit(CREATE_STORAGE_STAKE)
                .block_timestamp(1_000_000_000) // 1000 s, in ns
                .build()
        );
        c.create_link(
            "lnk-old".into(),
            U128(100),
            token(),
            "late".into(),
            Some(1_500), // expires at 1500 ms
        );

        // Well past the deadline.
        testing_env!(ctx(TOKEN).block_timestamp(10_000_000_000).build());
        let unused = c.ft_on_transfer("bob.near".parse().unwrap(), U128(100), "lnk-old".into());

        assert_eq!(unused, U128(100));
        assert_eq!(
            c.get_link("lnk-old".into()).unwrap().status,
            Status::Expired
        );
    }

    #[test]
    fn an_expired_invoice_is_reported_as_expired_even_unpaid() {
        let mut c = setup();
        testing_env!(
            ctx("alice.near")
                .attached_deposit(CREATE_STORAGE_STAKE)
                .block_timestamp(1_000_000_000)
                .build()
        );
        c.create_link(
            "lnk-age".into(),
            U128(100),
            token(),
            "x".into(),
            Some(1_500),
        );

        testing_env!(ctx(TOKEN).block_timestamp(9_000_000_000).build());
        assert_eq!(
            c.get_link("lnk-age".into()).unwrap().status,
            Status::Expired
        );
    }

    // ── claiming ─────────────────────────────────────────────────────────

    #[test]
    fn a_stranger_can_trigger_claim_but_only_the_payee_is_paid() {
        let mut c = setup();
        open_link_for(&mut c, "alice.near", "lnk-open", 10_000);
        pay(&mut c, "bob.near", 10_000, "lnk-open");

        // Carol has nothing to do with this invoice.
        claim_as(&mut c, "carol.near", "lnk-open");
        assert_eq!(
            c.get_link("lnk-open".into()).unwrap().status,
            Status::Claimed
        );

        let calls = calls_to(TOKEN);
        // Registration runs first…
        assert_eq!(calls[0].0, "storage_deposit");
        let transfers: Vec<_> = calls.iter().filter(|(f, _)| f == "ft_transfer").collect();
        assert!(
            !transfers.is_empty(),
            "claim must queue transfers to the token"
        );
        for (_function, args) in transfers {
            let receiver = args["receiver_id"].as_str().unwrap();
            assert!(
                receiver == "alice.near" || receiver == FEE_ACCOUNT,
                "money went to {receiver}, which is neither the payee nor the fee account"
            );
            assert_ne!(receiver, "carol.near", "the caller must never be paid");
        }
    }

    #[test]
    fn claim_pays_the_payee_less_the_fee_in_one_batch() {
        let mut c = setup();
        open_link_for(&mut c, "alice.near", "lnk-fee", 10_000);
        pay(&mut c, "bob.near", 10_000, "lnk-fee");
        claim_as(&mut c, "alice.near", "lnk-fee");

        let transfers: Vec<_> = calls_to(TOKEN)
            .into_iter()
            .filter(|(f, _)| f == "ft_transfer")
            .collect();
        assert_eq!(transfers.len(), 2, "payout and fee");
        assert_eq!(transfers[0].1["receiver_id"], "alice.near");
        assert_eq!(transfers[0].1["amount"], "9950");
        assert_eq!(transfers[1].1["receiver_id"], FEE_ACCOUNT);
        assert_eq!(transfers[1].1["amount"], "50");

        // One receipt carrying both transfers: they succeed or fail together.
        // (The payee registration before them is its own receipt.)
        let payout_receipts = get_created_receipts()
            .into_iter()
            .filter(|r| {
                r.receiver_id.as_str() == TOKEN
                    && r.actions.iter().any(|a| {
                        matches!(
                            a,
                            near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. }
                                if method_name.as_slice() == b"ft_transfer"
                        )
                    })
            })
            .count();
        assert_eq!(payout_receipts, 1, "payout and fee must be a single batch");
    }

    #[test]
    fn claim_re_registers_the_payee_before_paying_out() {
        let mut c = setup();
        open_link_for(&mut c, "alice.near", "lnk-retry-reg", 10_000);
        pay(&mut c, "bob.near", 10_000, "lnk-retry-reg");
        claim_as(&mut c, "carol.near", "lnk-retry-reg");

        // Receipts toward the token, in order: the registration first —
        // `create_link`'s own registration is fire-and-forget, so this is the
        // retry that keeps a never-registered payee from stranding the payout.
        let to_token: Vec<_> = get_created_receipts()
            .into_iter()
            .filter(|r| r.receiver_id.as_str() == TOKEN)
            .collect();
        assert!(
            to_token.len() >= 2,
            "registration receipt then payout batch"
        );

        let first: Vec<(String, near_sdk::serde_json::Value)> = to_token[0]
            .actions
            .iter()
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name, args, ..
                } => Some((
                    String::from_utf8(method_name.clone()).unwrap(),
                    near_sdk::serde_json::from_slice(args).unwrap(),
                )),
                _ => None,
            })
            .collect();
        assert_eq!(first.len(), 1, "the registration is one call");
        assert_eq!(first[0].0, "storage_deposit");
        assert_eq!(first[0].1["account_id"], "alice.near");
        assert_eq!(first[0].1["registration_only"], true);

        // …and the payout batch in the receipt after it.
        let second: Vec<String> = to_token[1]
            .actions
            .iter()
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } => {
                    Some(String::from_utf8(method_name.clone()).unwrap())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            second,
            vec!["ft_transfer".to_string(), "ft_transfer".to_string()],
            "payout and fee follow the registration"
        );
    }

    #[test]
    fn claim_applies_the_fee_to_an_overpayment() {
        let mut c = setup();
        open_link_for(&mut c, "alice.near", "lnk-ov2", 10_000);
        pay(&mut c, "bob.near", 20_000, "lnk-ov2");
        claim_as(&mut c, "alice.near", "lnk-ov2");

        let transfers: Vec<_> = calls_to(TOKEN)
            .into_iter()
            .filter(|(f, _)| f == "ft_transfer")
            .collect();
        assert_eq!(transfers[0].1["amount"], "19900");
        assert_eq!(transfers[1].1["amount"], "100");
    }

    #[test]
    fn a_tiny_invoice_skips_the_fee_leg_instead_of_failing() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-tiny"); // 100 units: fee rounds to 0
        pay(&mut c, "bob.near", 100, "lnk-tiny");
        claim_as(&mut c, "alice.near", "lnk-tiny");

        let transfers: Vec<_> = calls_to(TOKEN)
            .into_iter()
            .filter(|(f, _)| f == "ft_transfer")
            .collect();
        assert_eq!(transfers.len(), 1, "no zero-amount fee transfer");
        assert_eq!(transfers[0].1["receiver_id"], "alice.near");
        assert_eq!(transfers[0].1["amount"], "100");
    }

    #[test]
    #[should_panic(expected = "link is not paid")]
    fn an_unpaid_link_cannot_be_claimed() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-wait");
        claim_as(&mut c, "alice.near", "lnk-wait");
    }

    #[test]
    #[should_panic(expected = "attach exactly 1 yoctoNEAR")]
    fn claim_requires_exactly_one_yocto() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-1y");
        pay(&mut c, "bob.near", 100, "lnk-1y");

        testing_env!(ctx("alice.near").build()); // no deposit
        let _ = c.claim("lnk-1y".into());
    }

    #[test]
    fn claim_marks_claimed_and_can_only_be_started_once() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-claim");
        pay(&mut c, "bob.near", 100, "lnk-claim");

        claim_as(&mut c, "alice.near", "lnk-claim");
        assert_eq!(
            c.get_link("lnk-claim".into()).unwrap().status,
            Status::Claimed
        );

        // A second claim, by anyone, is refused while the first is in flight.
        testing_env!(
            ctx("carol.near")
                .attached_deposit(NearToken::from_yoctonear(1))
                .build()
        );
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c2 = c;
            let _ = c2.claim("lnk-claim".into());
            c2
        }));
        assert!(result.is_err(), "second claim should have panicked");
    }

    #[test]
    fn a_failed_transfer_puts_the_invoice_back_to_paid() {
        let mut c = setup();
        open_link_for(&mut c, "alice.near", "lnk-retry", 10_000);
        pay(&mut c, "bob.near", 10_000, "lnk-retry");

        claim_as(&mut c, "alice.near", "lnk-retry");
        assert_eq!(
            c.get_link("lnk-retry".into()).unwrap().status,
            Status::Claimed
        );

        // The batch failed (say, the payee was not registered). The callback
        // runs as this contract itself.
        testing_env!(ctx(CONTRACT).build());
        assert!(!c.on_claimed("lnk-retry".into(), Err(PromiseError::Failed)));

        let link = c.get_link("lnk-retry".into()).unwrap();
        assert_eq!(link.status, Status::Paid, "must be claimable again");
        assert!(link.claimed_at.is_none());

        // And the retry queues the same full payout again: nothing was lost.
        claim_as(&mut c, "carol.near", "lnk-retry");
        let transfers: Vec<_> = calls_to(TOKEN)
            .into_iter()
            .filter(|(f, _)| f == "ft_transfer")
            .collect();
        assert_eq!(transfers[0].1["receiver_id"], "alice.near");
        assert_eq!(transfers[0].1["amount"], "9950");
    }

    #[test]
    fn a_successful_transfer_leaves_the_invoice_settled() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-done");
        pay(&mut c, "bob.near", 100, "lnk-done");

        claim_as(&mut c, "alice.near", "lnk-done");

        testing_env!(ctx(CONTRACT).build());
        assert!(c.on_claimed("lnk-done".into(), Ok(())));
        assert_eq!(
            c.get_link("lnk-done".into()).unwrap().status,
            Status::Claimed
        );
    }

    #[test]
    #[should_panic(expected = "link not found")]
    fn claiming_a_missing_link_panics() {
        let mut c = setup();
        claim_as(&mut c, "alice.near", "nope");
    }

    // ── reads ────────────────────────────────────────────────────────────

    #[test]
    fn a_creator_only_sees_their_own_links() {
        let mut c = setup();
        open_link(&mut c, "alice.near", "lnk-a1");
        open_link(&mut c, "alice.near", "lnk-a2");
        open_link(&mut c, "bob.near", "lnk-b1");

        let alice = c.get_links_by_creator("alice.near".parse().unwrap());
        let bob = c.get_links_by_creator("bob.near".parse().unwrap());

        assert_eq!(alice.len(), 2);
        assert_eq!(bob.len(), 1);
        assert!(
            alice
                .iter()
                .all(|l| l.creator == "alice.near".parse::<AccountId>().unwrap())
        );
    }

    #[test]
    fn unknown_creator_gets_an_empty_ledger_not_an_error() {
        let c = setup();
        assert!(
            c.get_links_by_creator("nobody.testnet".parse().unwrap())
                .is_empty()
        );
        assert_eq!(
            c.link_count_by_creator("nobody.testnet".parse().unwrap()),
            0
        );
    }

    #[test]
    fn the_allowlist_is_visible_to_callers() {
        let c = setup();
        assert!(c.is_token_allowed(token()));
        assert!(!c.is_token_allowed("other.testnet".parse().unwrap()));
    }

    #[test]
    fn the_fee_settings_are_visible_to_callers() {
        let c = setup();
        assert_eq!(c.fee_account(), fee_account());
        assert_eq!(c.fee_bps(), 50);
    }

    // ── construction ─────────────────────────────────────────────────────

    #[test]
    fn new_registers_the_contract_and_the_fee_account_on_every_token() {
        let _c = setup();

        let calls = calls_to(TOKEN);
        assert_eq!(calls.len(), 2);
        assert!(
            calls
                .iter()
                .all(|(f, a)| f == "storage_deposit" && a["registration_only"] == true)
        );
        let who: Vec<_> = calls
            .iter()
            .map(|(_, a)| a["account_id"].as_str().unwrap().to_string())
            .collect();
        assert!(who.contains(&CONTRACT.to_string()));
        assert!(who.contains(&FEE_ACCOUNT.to_string()));
    }

    #[test]
    #[should_panic(expected = "attach at least 0.02 NEAR per allowlisted token")]
    fn new_requires_a_deposit_to_fund_registration() {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(CONTRACT.parse().unwrap())
                .build()
        ); // no deposit attached
        Contract::new(vec![token()], fee_account());
    }

    #[test]
    #[should_panic(expected = "attach at least 0.02 NEAR per allowlisted token")]
    fn the_old_one_registration_deposit_is_no_longer_enough() {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(CONTRACT.parse().unwrap())
                .attached_deposit(NearToken::from_yoctonear(STORAGE_DEPOSIT_PER_TOKEN))
                .build()
        );
        Contract::new(vec![token()], fee_account());
    }

    #[test]
    fn an_empty_allowlist_is_refused_at_construction() {
        let result = std::panic::catch_unwind(|| Contract::new(vec![], fee_account()));
        assert!(result.is_err());
    }

    #[test]
    fn default_context_accounts_are_distinct() {
        // Guards the test harness itself: if `accounts()` ever collides with
        // the contract id, every predecessor assertion above silently passes.
        assert_ne!(accounts(0), accounts(1));
        assert_ne!(accounts(0).as_str(), CONTRACT);
    }
}
