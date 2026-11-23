# Bacolor Civil ID: website + backend

One Node.js server that shows your website **and** answers its `/api/*` calls. Residents and admins now share a real database instead of each browser's `localStorage`.

```
server/   the backend (API, database, security)
public/   your website (Homepage, Login, Register..., admin pages)
tests/    automated tests   ->  npm test
```

Website addresses: `/` is the resident homepage, `/admin` is the staff sign-in.

## Run it on your computer (needs Node 22.13 or newer)
```
cp .env.example .env      # then open .env and set ADMIN_PASSWORD (and ADMIN_SIGNUP_CODE if you want staff sign-up)
npm install
npm run dev               # open http://localhost:3000
npm test
```
With `DATABASE_URL` empty it saves to a local file `data/bacolor.sqlite`.
If you don't set `ADMIN_PASSWORD`, a random one is printed in the terminal the first time.

## Publish it for free: Render (hosting) + Neon (database)

Why this pair: Render runs Node servers for free, but its free *database* expires after 30 days and its disk is wiped on every restart, so the data must live somewhere else. Neon's free Postgres has no expiry (checked Nov 2026; limits change, so glance at their pricing pages).

1. **GitHub**: create a repository and upload this whole folder (the `.gitignore` keeps secrets out).
2. **Neon** (neon.com): sign up, create a project, copy the **connection string** (starts with `postgresql://`).
3. **Render** (render.com): *New > Web Service* > pick your repo.
   Build command `npm install`, start command `npm start`, instance type **Free**.
   (Or use *New > Blueprint*; `render.yaml` fills these in.)
4. In Render > **Environment**, add:
   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string |
   | `ADMIN_PASSWORD` | a strong password for the main admin |
   | `ADMIN_SIGNUP_CODE` | a secret code for new staff (leave out to disable staff sign-up) |
   | `NODE_VERSION` | `22` |
5. Deploy. Your site is at `https://<name>.onrender.com`, staff sign in at `/admin`. Tables are created automatically.

**Free-tier behaviour to expect**
- Render puts a free service to sleep after 15 minutes without visitors; the next visit takes about a minute to wake up.
- Neon's database also naps when idle and wakes in a moment. Nothing is lost.
- Photos are stored in the database. Neon's free storage is about 0.5 to 1 GB, which is a few thousand residents.

Not suitable for this project: GitHub Pages / Netlify / Cloudflare Pages (static only, no backend), and Cloudflare Workers' free plan (10 ms CPU per request is too little for safe password hashing).

## What changed in your website files
- `JavaScript/portal.js`: the fake `api()` (localStorage) is replaced by real calls to `/api/...`; the dead demo-storage code was removed.
- `dashboard.js`: loads residents from the server, fetches photos only when a record is opened, saves verification, profile and password on the server. "Load sample records" was removed.
- `script.js`, `index.html`: admin sign-in uses the server. The visible `admin / admin123` hint is gone. Sign-up needs the access code. Sign in by username (names aren't unique).
- `forgot.html` was missing from the upload, so it was created.
- Passwords are hashed (scrypt), sessions are random tokens, logins are rate-limited.

## Things you should decide before real residents use it
1. **Auto-verification**: a resident who uploads *any* image as their ID is marked Verified (that is how your site worked). Set `AUTO_VERIFY=false` so staff must approve everyone.
2. **Forgot password uses only the date of birth.** Anyone who knows a resident's number and birthday can take over the account. Set `ALLOW_DOB_PASSWORD_RESET=false` until SMS/email codes are added.
3. **Family links**: anyone who knows a person's name and mobile number can link them and then sees that person's Civil ID number, barangay and face photo. A "the other person must accept" step would fix this.
4. **Real IDs and the Data Privacy Act (RA 10173)**: storing government ID photos needs a privacy notice, consent, and backups. Free tiers are for a demo/pilot.
