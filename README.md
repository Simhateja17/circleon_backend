# Barsha Backend

## Email OTP authentication

Email authentication is passwordless. The frontend requests and verifies a verification code through Express; Express stores the resulting Supabase access and refresh tokens in HTTP-only cookies.

For hosted Supabase, configure **Authentication → Email Templates → Magic Link** to send a code rather than a link. The template must use `{{ .Token }}` and must not use `{{ .ConfirmationURL }}`. For example:

```html
<h2>Your Barsha AI sign-in code</h2>
<p>Enter this code to continue:</p>
<p style="font-size: 24px; font-weight: 700; letter-spacing: 4px;">{{ .Token }}</p>
<p>This code expires soon. If you did not request it, you can ignore this email.</p>
```

The relevant API routes are:

- `POST /api/auth/otp/request` with `{ email, intent: "login" | "signup" }`
- `POST /api/auth/otp/verify` with `{ email, token }`
- `GET /api/auth/google` for Google OAuth
- `POST /api/auth/logout`
