# AGC Prayer Chain — Setup (about 15 minutes, one time)

Two parts: (1) the **backend** goes in your Google account so all data lives in your Drive, (2) the **app** goes on a free web address so people can open it on iPhone and Android.

## What is in the app
- **Pick a Time** — every hour of every day of the month, first names only, coverage meter, "find the next open hour".
- **Pray Together** — group prayer times you announce for people anywhere in the world. Each person sees the time in their own time zone, taps Join (first name + optional country/city), and sees who else joined. Optional meeting link (Zoom, Meet, WhatsApp, etc.).
- **Requests** — the month's prayer requests, English and Nepali side by side.
- **My Hours** — your hours, "I prayed" check-in, add to phone calendar with a 10-minute alert.
- **Translate** — English ⇄ Nepali using Google Translate. Admins also get a "Translate to Nepali (draft)" button next to each request and group-time title.
- **Admin (the ⚙ button, top right)** — PIN protected: post requests, schedule group times, remove anyone from an hour, remove every hour under one first name (for pranks), save last month to Drive.
- The 🌍 menu at the top lets each person pick their own time zone. The chain's own zone (default Central) stays the main time; "🌍" lines show the viewer's time.

## Try it first (no setup)
Open `index.html` in a browser. With no backend connected it runs in **demo mode** with sample data on that device only (admin PIN `1234`; translation is switched off in demo mode).

## Step 1 — Backend in your Google account
1. Go to **script.google.com** (signed in as the Google account that owns your Drive) → **New project**.
2. Delete the sample code. Paste in all of `backend/Code.gs`. Click **Save**.
3. In the function dropdown choose **setup** → **Run**. Google asks you to authorize (this includes permission to use Google Translate). Because it is your own script you will see an "unverified app" warning: **Advanced → Go to project (unsafe) → Allow**.
4. Open **Execution log**. It prints **your admin PIN** and the link to the live data sheet. Write the PIN down. (Change it later in *Project Settings → Script properties → ADMIN_PIN*.)
5. **Deploy → New deployment → Web app**. **Execute as: Me**, **Who has access: Anyone** (not "Anyone with a Google account"). Click **Deploy** and copy the **Web app URL**.

`setup` creates in your Drive: *Executive Assistant Workspace / AGC Prayer Chain /* the live data sheet and an *Archive* folder, and schedules the monthly archive.

**Whenever you paste in an updated Code.gs:** Save → run **setup** once more (safe to repeat; it adds any new permissions, including permission to email you the monthly-save report) → **Deploy → Manage deployments → Edit → Version: New version → Deploy**. Skipping the new version means phones keep using the old code.

## Step 2 — Connect the app
1. In `index.html` find `const API_URL = '';` and paste the Web app URL between the quotes. (Or send it to Claude to do it.)
2. Put the app folder (`index.html`, `manifest.webmanifest`, `sw.js`, `icons/`) on a free host such as **GitHub Pages** or **Netlify Drop**.
   - GitHub Pages: create a public repository (for example `agc-prayer-chain`), upload those files, then *Settings → Pages → Deploy from a branch → main / root*. Your link will be `https://<your-username>.github.io/agc-prayer-chain/`. Nothing secret is in these files (the admin PIN stays in Google).
   - To update later: change the files in the repository; phones pick up the new version the next time they open the app.

## Step 3 — Install on phones
Tell people to **install first, then sign up for hours.** If they open the link inside WhatsApp, Messenger or Facebook, the app shows a notice to open it in Safari or Chrome instead; those built-in browsers forget who you are.
- **iPhone:** open the link in **Safari** → Share → **Add to Home Screen**. (The Safari tab and the Home Screen app do not share memory, so hours picked in one will not show as "yours" in the other.)
- **Android:** open in **Chrome** → menu → **Install app**, or tap the *Install the app* button.

## Each month
- Open **⚙ Admin**. Post the month's prayer requests (English + Nepali) and any group prayer times, then Save. Next month can be posted early. Use *Translate to Nepali (draft)* to get a starting point, then have a Nepali speaker check it before saving.
- On the 1st (about 1 AM) the previous month is saved to Archive as a sheet named `AGC Prayer Chain - YYYY-MM` — hours and who prayed, requests, group times with who joined, and a coverage summary — and cleared from the app. The Admin tab has a button to do this by hand.

## Settings (top of Code.gs)
`TZ` (default `America/Chicago`), `START_HOUR` / `END_HOUR` (default all 24 hours), `MAX_PER_DEVICE` (hours per phone, default 50), `MAX_TRANSLATIONS` (per phone per 6 hours, default 30; admin is exempt), `MAX_SESSIONS` (group times per month, default 40).

## Things to know
- Anyone with the link can use the app. Only first names are shown. Only the PIN holder can edit requests/group times or remove someone.
- **Admin PIN lockout:** after 5 wrong tries (by anyone) admin actions lock for 15 minutes.
- **A meeting link you add to a group time is visible to everyone who has the app.** Use a link you are comfortable sharing widely.
- Translation is machine translation. Treat it as a draft; have a Nepali speaker check anything important.
- No push notifications. Each person can tap **Add reminder** to put an hour or group time in their phone calendar with a 10-minute alert.
- People are recognized by phone, not by account. **My Hours** shows a *backup code*. Someone who switches phones, or uses both the Safari tab and the Home Screen app, copies the code and pastes it into *Restore* on the other one to get their hours back. Anyone with the code can manage those hours, so it should not be posted publicly.
- If someone is abusive, Admin → *Remove all hours under a first name* clears everything under that name for the month.
- **Clock-change days:** when the clocks change (for example Sunday, November 1, 2026, in Central Time), the day has 25 or 23 hours but the app always shows 24. On the 25-hour day the 1 AM hour happens twice and one pick covers both. Calendar reminders fire for the first.
- Slow or lost connections: the app gives up after 25 seconds and shows a plain message instead of freezing.
- To spare Google's limits, the app reads the sheet at most every 20 seconds no matter how many phones are open. A new pick appears on other phones within about 20 to 90 seconds.
- On the 1st the monthly save emails you at your Gmail either way ("saved" or "FAILED, here is what to do"). If you never get the email, check Apps Script → Triggers.
- A free Google script handles roughly 30 requests at once. A big burst right after an announcement may feel slow for a few seconds; nothing is lost.
- The PIN is not bank-level security.
