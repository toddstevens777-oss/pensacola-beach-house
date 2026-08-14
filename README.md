# Pensacola Beach House Calendar

A small shared scheduling tool for the Stevens, Furr, and Wagner families —
421 Fort Pickens Road, Pensacola Beach, FL 32561. Brett (Furr) publishes a
batch of Thursday→Wednesday weeks a few months at a time; each family can
request weeks they want, and Brett finalizes who gets which week. Anything
nobody claims just shows **Open**.

Photos live in `public/images/` (hero shot on login, sunset background,
boardwalk banner on the Calendar tab, kitchen photo on the Documents tab) —
swap any of those four files to change what's shown, no code changes needed
as long as the filename stays the same.

## How it works

- **Periods**: Brett (logged in as Furr) clicks **+ New period**, gives it a
  label (e.g. "Fall 2026") and a date range. The app automatically generates
  every Thursday→Wednesday week inside that range.
- **Requesting**: Any family can click a week and either request it or mark
  themselves unavailable — the two are mutually exclusive, and either can
  come with a short private note. That note is only visible to the family
  who wrote it and to Brett (Furr) — other families just see *that* you
  responded, not why. The general "Notes" thread underneath stays visible to
  everyone — that's the back-and-forth channel for negotiating swaps.
- **Finalizing**: Only the Furr login can assign a week to a family or
  reopen it. Finalized weeks are locked (no more responses) until Brett
  reopens them. Furr also gets a **📋 Summary** button on each period — a
  table of every week against all three families' status and notes, so
  assignments don't require opening each week one at a time.
- **Documents tab**: placeholder for now — it's where financial statements
  and other treasurer documents can go in a later phase.

## Running it locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open http://localhost:3000. A SQLite database file will be created at
`data/beachhouse.db` the first time you run it — that's where everything
(periods, weeks, requests, comments) is stored.

### Login

Each family has its **own** password (you pick your family name from a
dropdown at login, then enter that family's password). Anyone logged in as
**Furr** gets scheduling admin controls (create periods, finalize weeks) —
that's separate from the password system below.

Family passwords aren't set via environment variables — they're set through
a small admin page at **`/admin.html`** (also linked quietly at the bottom
of the login screen), gated by a master **admin key** that only you, the
treasurer, know. That's the "backdoor": if a family forgets their password,
you go to `/admin.html`, enter the admin key, and set a new one for them —
no need to know their old password. Families can also change their own
password any time from inside the app (top-right "Change password") without
needing you.

Set the admin key and session secret before starting the app:

```bash
ADMIN_RESET_KEY="something-only-you-know" SESSION_SECRET="a-long-random-string" npm start
```

If you don't set `ADMIN_RESET_KEY`, it defaults to `change-me-admin-key` —
**change this before you do anything else**, since it's the master key to
every family's password.

**First-time setup:** after starting the server, go to `/admin.html`, enter
your admin key, and set an initial password for each of the three families.
Nobody can log in until you do this — there's no default family password
anymore. Text or call each family their initial password and let them know
they can change it themselves once they're in.

## Deploying so all three families can reach it

This is a normal Node.js app with a SQLite file for storage, so it needs a
host that keeps a persistent disk (not a "serverless function" host, which
would wipe the database on every request). Two easy, cheap options:

### Option A: Render (recommended, simplest)

1. Push this folder to a GitHub repo (private is fine).
2. In Render, click **New → Web Service**, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add a **persistent disk** (Render calls it a "Disk") mounted at `/data`,
   and set an environment variable `DATA_DIR=/data` — or just use a small
   paid instance ($7/mo "Starter") which keeps its disk between deploys.
   Render's free tier disks get wiped on redeploy, so for a calendar people
   actually rely on, the small paid tier is worth it.
5. Set environment variables `ADMIN_RESET_KEY` and `SESSION_SECRET` in the
   Render dashboard.
6. Render gives you a URL like `pensacola-beachhouse.onrender.com` — share
   that link with the Furrs and Wagners.

### Option B: Railway

Same idea — connect the repo, add a volume for `/data`, set the two env
vars, deploy. Railway's usage-based free tier is often enough for a
low-traffic family app.

If you'd rather not manage hosting yourself at all, tell me and I can walk
through either setup interactively, or we can talk about a version backed by
a hosted database instead of a local SQLite file (which would run on
Vercel's free tier).

## What's next

You mentioned wanting to expand this into a small treasurer hub — financial
statements, shared documents, etc. The app already has a **Documents** tab
stubbed out in the nav so that's a natural next phase: we'd add file
storage (uploads) and a simple list/download view, gated behind the same
login.
