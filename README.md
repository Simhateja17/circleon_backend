# CircleOn AI Backend

## Email OTP authentication

Email authentication is passwordless. The frontend requests and verifies a verification code through Express; Express stores the resulting Supabase access and refresh tokens in HTTP-only cookies.

For hosted Supabase, configure **Authentication → Email Templates → Magic Link** to send a code rather than a link. The template must use `{{ .Token }}` and must not use `{{ .ConfirmationURL }}`. For example:

```html
<h2>Your CircleOn AI sign-in code</h2>
<p>Enter this code to continue:</p>
<p style="font-size: 24px; font-weight: 700; letter-spacing: 4px;">{{ .Token }}</p>
<p>This code expires soon. If you did not request it, you can ignore this email.</p>
```

The relevant API routes are:

- `POST /api/auth/otp/request` with `{ email, intent: "login" | "signup" }`
- `POST /api/auth/otp/verify` with `{ email, token }`
- `GET /api/auth/google` for Google OAuth
- `POST /api/auth/logout`

## API logs

Every failed `/api/*` request is logged by PM2 with a request ID, endpoint, status, duration, origin, and returned error message. Tokens, cookies, and request bodies are not logged.

Set `LOG_API_REQUESTS=true` in the backend environment to also log successful API requests while debugging. Leave it `false` in normal production operation.

## Public free-lead preview

`POST /api/free-lead-preview` accepts the five targeting answers plus a company
name and work email. It searches and enriches up to nine candidates, keeps the
strongest three with usable work emails, and sends a branded research report to
the requester. Preview records are separate from authenticated workspace leads;
the flow does not contact the prospects.

Apply `db/2026-08-30-free-lead-preview.sql`, set the `FREE_LEAD_PREVIEW_*`
SMTP variables, and expose the lead-enrichment webhook at `/api/apollo/webhook` through `APOLLO_WEBHOOK_URL`.
The production PM2 config runs the preview worker separately from the API.
