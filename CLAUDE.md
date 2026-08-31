# Pensacola Beach House Calendar — project notes for Claude

Shared week-scheduling app for the Stevens, Furr, and Wagner families'
beach house at 421 Fort Pickens Road, Pensacola Beach, FL. Small, low-stakes
family tool — not a commercial product. Optimize for simplicity and
reliability over architecture.

## Stack

- Node.js (18+) + Express, server-rendered API consumed by vanilla JS in `public/`
- `better-sqlite3` for storage — single file at `data/beachhouse.db` (gitignored)
- No build step, no bundler, no framework on the frontend — plain HTML/CSS/JS
- No test suite currently exists

## Layout

- `server/index.js` — Express app, all routes (auth, periods/weeks, admin)
- `server/db.js` — SQLite schema + queries
- `server/auth.js` — family login, session cookies, admin-key reset flow
- `server/weeks.js` — generates Thursday→Wednesday week ranges from a period
- `public/index.html` / `app.js` / `style.css` — main calendar UI
- `public/admin.html` / `admin.js` — admin-key-gated page for setting family passwords
- `public/images/` — 4 swappable photos (hero, sunset bg, boardwalk banner, documents kitchen); keep filenames stable, just replace file contents to change them
- `data/` — SQLite db lives here at runtime; not committed

## Auth model

Three shared family logins (Stevens/Furr/Wagner), not per-person accounts.
Furr is the scheduling-admin family (can create periods, finalize/reopen
weeks). Family passwords are set via `/admin.html`, gated by `ADMIN_RESET_KEY`
(env var) — this is the "forgot password" backdoor, separate from each
family's own password. `SESSION_SECRET` signs the session cookie. Neither
secret lives in the repo — set in Render's dashboard env vars.

## Deploy pipeline (already working, don't reinvent)

- GitHub: `toddstevens777-oss/pensacola-beach-house` (private), `main` branch
- Render: web service, auto-deploys on push to `main`, persistent disk
  mounted at `/data` (`DATA_DIR=/data` env var) so the SQLite file survives
  redeploys
- `./deploy.sh "message"` is the standard way to ship a change: stages
  everything, commits, pushes to `main`. Render picks it up automatically
  (live within a minute or two). There is no staging environment or CI —
  push to `main` **is** the deploy.
- Given the low stakes (a family calendar), the established workflow is:
  make the change, run/verify locally if practical, then `./deploy.sh` directly
  — no feature-branch/PR ceremony needed unless Todd asks for one on a
  specific change.

## Working locally

```bash
npm install
ADMIN_RESET_KEY="..." SESSION_SECRET="..." npm start
```
App serves on http://localhost:3000. First run creates `data/beachhouse.db`.

## Conventions / things to remember

- Family notes on a week request are private to that family + Furr; the
  general "Notes" thread on a week is visible to everyone — don't blur
  that distinction when touching notes code.
- Finalized weeks lock out further responses until Furr (admin) reopens them.
- The "Documents" tab is an intentional stub for a future phase (treasurer
  docs/financials) — not a bug if it looks empty.
- Never commit real family passwords, the admin key, or the session secret
  anywhere in this repo (code, comments, or commit messages).
