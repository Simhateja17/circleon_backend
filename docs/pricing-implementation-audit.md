# CircleOn pricing implementation audit — 13 October 2026

Status: core implementation and agent additions integrated; launch acceptance remains incomplete.

## Implemented and checked

- Nine approved SGD plans, founding offer, trials, setup fees, owner seats, campaign quotas, usage and overage controls; managed domains/inboxes/warm-up excluded.
- Apollo provider-backed credit dashboard with distinct pool balances, 80% warnings, verification timestamps and a clearly identified manual fallback. Per-client CircleOn lead counts are separate from provider charges.
- One shared Retell agent per monthly workspace. Atomic service-only provisioning claims avoid duplicate creates. Campaign instructions and supported voice/language overrides travel with each call rather than modifying shared prompts. Legacy campaign provisioning is retained.
- Owner-approved inbound instructions, inbound fallback, durable Twilio call identity and fail-closed signed webhook verification.
- Dedicated restricted monthly billing portal setup, read-only readiness check, standalone billing worker deployment entry and persistent final-invoice settlement recovery.

## Audit findings corrected

1. Final invoice could remain in draft after usage rows had been marked billed: persistent settlement state now resumes finalization.
2. Final invoice could race a completed call's ledger update: settlement waits for the call's ledger event.
3. Fractional seconds rounded once per call: call duration and ledger now preserve numeric seconds and round once when calculating monthly minutes.
4. Failed inbound provider registration occupied a concurrency slot: failures release queued state and pending retries fall back safely.
5. Retell payload replacement erased Twilio retry identity: a dedicated SID column retains it across webhooks.
6. Legacy agent provisioning used ON CONFLICT targets that no longer had full unique constraints: explicit scoped insert/update paths replace them.
7. Final overage invoice omitted configured automatic tax: tax follows the GST setting.
8. Retell signature verification used the wrong contract and allowed missing secrets: timestamped HMAC verification now fails closed, checks freshness and exact raw body.
9. Sequence policies missed teammates because email_sequences has no workspace_id: explicit campaign-derived membership policy added.

10. Call completion waited for analysis before recording billing: signed call-ended events now meter immediately; ledger failure requests a webhook retry.
11. Late usage was lost after a period was marked billed: durable invoice claims and committed amounts now bill positive adjustments with idempotent provider item keys.
12. Calls spanning renewal were attributed to the completion month: historical paid periods and atomic per-call allocations now retain the correct fractional duration in each period.

## Verification evidence and limits

Backend: 106 tests pass. Frontend: 26 existing tests pass and production build passes, including new routes. Mobile Apollo dashboard renders at 390px with no page horizontal overflow and displays its 80% alert; browser used mocked API fixtures, not real provider credit data.

Supabase MCP applied reviewed voice prerequisites and pricing extensions. Real-schema transactional tests pass for quotas, shared agent claims, exact fractional seconds and member isolation. Synthetic rows rolled back; retained counts remain 9 users, 7 workspaces, 29 campaigns and 223 leads. Existing subscriptions remain active on 4 Atelier and 3 Maison plans. The voice prerequisite intentionally backfilled one already blocked/do-not-call lead to suppressed.

MCP migration calls in the same second collided in migration-history identifiers. Explicit transaction wrappers had committed some schema changes before those history insert failures. Actual schema was inspected, and a consolidated idempotent migration reconciled provider credits, settlements, exact seconds and inbound identity. Database state and history must be checked rather than inferring failure means no DDL ran.

## Remaining launch acceptance

- Renewal-boundary metering is implemented and verified: subscription period history snapshots the paid allowance, exact answered duration splits across periods, and invoice claims charge only the positive uninvoiced delta. Late completions after a final invoice create a new settlement revision. Real-schema assertions cover split duration, webhook retries, committed and pending invoice retries, and late-only adjustments. These tests rolled back all synthetic data.
- A real provider call must validate that dynamic prompt interpolation and overrides behave as intended, not merely that supported request fields are sent.
- Stripe checkout, conversion, six paid founding months, setup charge, upgrade/downgrade, failed payment recovery and final invoices require test-mode end-to-end acceptance.
- SMTP delivery, carrier routing/fallback and dashboard acceptance with actual owner/member accounts remain unverified.
- Human review calls, support commitments, provider licence and legal approvals require operator confirmation.
- Code has not been committed, pushed or deployed. The readiness check rejects local placeholder Stripe keys, missing billing sender/SMTP, admin allowlist and restricted portal ID. GCP authentication is expired.

No launch-readiness claim is made. Configure external services only after the user reviews these results.
