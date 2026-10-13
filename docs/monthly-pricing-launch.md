# CircleOn monthly pricing implementation

Nine SGD monthly plans are defined in `../shared/pricing.json`, with identical frontend/backend copies checked by backend tests. Managed sending domains, inbox provisioning and warm-up are excluded. Customers connect their own verified mailbox. Existing legacy subscriptions remain supported.

## Configuration and release

1. Applied `backend/db/2026-10-12-monthly-pricing.sql` and `backend/db/2026-10-13-pricing-trigger-privileges.sql` to CircleOn project `nxwzconvigksaxtyozay` through Supabase MCP on 13 October 2026, as authorized. No Docker was used for this validation. Preserve the earlier voice work; its separate full migration has not been applied by this pricing task.
2. Configure existing Supabase service credentials, Stripe secret/webhook keys and `FRONTEND_URL`. Run `npm run billing:configure-prices` in the backend explicitly in Stripe **test mode** first; this creates the new catalogue without changing legacy prices.
3. Configure a dedicated Stripe customer portal with payment-method updates and invoice history enabled, subscription changes and cancellation disabled. Set `STRIPE_MONTHLY_PORTAL_CONFIGURATION_ID`. Monthly customers use CircleOn's cancellation and tier-change controls so trial cancellation, retention selection and founding schedules remain consistent. Legacy portal behavior is retained.
4. Deliver signed Stripe events to the existing raw-body webhook. Include checkout completion/expiry, subscription lifecycle, invoice.created, invoice.paid, invoice.payment_failed and invoice_payment.paid. invoice.created must reach the service before automatic finalization so setup and closed-period overages can be attached. Failed deliveries must retry.
5. Run exactly one `npm run worker:billing` process. Configure `BILLING_SMTP_URL` and `BILLING_FROM_EMAIL` for owner reminders and weekly reports. Without SMTP, notifications stay in the durable outbox. Final canceled-subscription overages wait for connected calls to finish before issuing their final invoice.
6. Set `CIRCLEON_ADMIN_USER_IDS` to authorized authenticated user UUIDs. Review `/admin`: legal approval, founding availability, company trial exceptions, voice readiness/fallback and optional demo URL. GST collection and compliance claims default off. Singapore incorporation alone does not establish GST registration. Checkout stays closed until legal readiness is explicitly enabled.
7. For inbound routing set `API_PUBLIC_URL` to the exact public API origin and `BILLING_TWILIO_ACCOUNT_TOKENS` to a JSON map of carrier account SID to signing token. Configure the customer's own Twilio number webhook to `/api/billing/inbound/<workspace-id>`. Retell credentials, number provisioning and a customer fallback number must be verified before marking voice ready. Carrier charges are separate.

## Acceptance still required before launch

Use Stripe test clocks and signed events to exercise trial conversion/cancellation, setup collection, six paid founding months, failed first payment and 48-hour release, extensions, upgrades, scheduled downgrades, overages including final cancellation invoices, and duplicate/out-of-order delivery. Verify an authenticated owner and teammate, invitation acceptance, real SMTP delivery, carrier fallback and completed Retell calls. Real-schema quota and membership/RLS checks passed directly against the connected pre-release production database; their synthetic rows were rolled back.

The local public-page browser check used mocked catalogue availability because the configured remote API rejected localhost CORS. It proves local rendering and plan selection, not live checkout or production provider setup.

## Operational boundaries

Human Pro review calls and support response commitments require an operator; the worker sends the review reminder. Invitation links are shared by the owner through `/team-invite`. Self-service tier changes remain within the current product family; family migrations require an operator. The existing voice provisioning code is retained; workspace-wide single-agent consolidation and a provider-backed Apollo credit-pool dashboard are now implemented; see pricing-implementation-audit.md for evidence and remaining acceptance gates. Calls spanning renewal split exact answered seconds across recorded paid periods; late invoice adjustments charge only previously uninvoiced overage.

## Verified on the connected database

`backend/test/monthly-pricing-production.sql` and `backend/test/monthly-pricing-rls.sql` passed against the real schema. They cover founding capacity, company trial reuse, hard trial limits, paid spend caps, earned email bundles, verified lead deduplication, uploads, owner seats, combined campaign limits, four-step sequences, call concurrency, failed payments, teammate access and cross-workspace isolation. Assertions check the expected error messages so unrelated schema errors cannot masquerade as limit enforcement. All synthetic rows roll back.

After testing, the original counts remain: 9 auth users, 7 workspaces, 7 billing rows, 29 campaigns and 223 leads. The 7 existing subscriptions remain on legacy plans (4 Atelier and 3 Maison). Nine new plan records are installed, with zero founding reservations and usage rows left by tests. Checkout legal readiness remains disabled.

Backend tests: 106 passed. Previously verified frontend tests: 26 passed; production build passed.

Local Stripe secret and webhook keys are placeholders. Billing SMTP, sender identity, admin allowlist and restricted monthly portal configuration are missing. Supply these through the deployment's secret configuration before provider acceptance. No Stripe catalogue creation, customer messages, deployment, commit or push was performed.
