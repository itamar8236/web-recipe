# Login, admin and guests

Built in, stored in D1. Endpoints are in [API → Auth](./01_api.md#auth).

## Passwords and sessions

- Passwords are stored only as a salted PBKDF2-SHA256 hash (WebCrypto,
  `src/password.js`), with its iterations and salt, so the cost can be raised later. Never
  logged.
- **One session row per device** (`src/session.js`). Two cookies, both HttpOnly,
  SameSite=Lax, 10 years, `Secure` on https: `device` (a random id, kept across logouts)
  and `session` (a random secret; only its SHA-256 is stored, in `sessions.token_hash`).
  Login upserts the device's row, so rows grow only with new devices; logout deletes it.
- Logins never expire. Changing your own username or password keeps every existing login,
  on every device, and doesn't ask for the old password: the owner's choice, since the
  session already proves who it is.
- Sign-up is open until 50 users exist, and never makes an admin.

## Admin login as a user

The one admin is set in the database (`users.is_admin`). `POST /api/admin/impersonate` sets
`sessions.acting_as_user_id` on this device's row; the schema's triggers refuse it for
anyone but the admin. From then on `getSessionUser` returns that user for **everything**
(account, tags, recipes, Browse, imports and model caps), exactly as if they had logged in,
while `user_id` still says who really logged in. That user is never the admin, so the admin
endpoints answer 403 until the device logs out; logging out deletes the row, so the next
login starts clean. The frontend reloads fully after switching, so no screen keeps the
admin's data.

## Guests

A guest uses the app with nothing reaching the database: their tags and recipes live in
memory in `frontend/lib/api.js` and are gone on reload ([Web UI → Data layer](./08_web-ui.md#data-layer)).
Imports, the AI tools and Browse need an account; the frontend doesn't call them for a
guest, and the backend refuses them anyway, since a guest has no session.

## Login flow in the frontend

- `Shell` wraps the app in `AuthProvider` (`components/Auth.js`), which asks
  `GET /api/auth/me` once on load. Its status is `loading`, `error`, `anonymous`, `guest`
  or `user`.
- `anonymous` (a 401) shows `LoginScreen` **in place of the page**, with no `/login` route,
  so after logging in the user is on the page they opened.
- `error` (offline, a server error, `next dev` with no backend) never shows the login
  screen, since the user may well be logged in: it shows the reason, "Try again" and
  "Continue as guest".
- A wrong username or password shows one generic message, never which one was wrong.
- Every change of who uses the app (log in, sign up, log out, guest) calls `setGuestMode`
  and empties the guest's memory, so one person's data never shows for the next. Any
  request answering `not_logged_in` brings back the login screen. If logout fails, the user
  stays logged in and is told so.
- Cookies need the API's origin, so login works only on the Worker, never on `next dev`
  (`local-dev` skill).

## Known gaps and accepted trade-offs

- There is no login rate limit, and a password may be one character.
