# 🌊 Bala Bay Water Level — Daily Email Notification

Sends a daily email with the current water level at Bala Bay (Lake Muskoka, Station 02EB015), compared to the 5-year July average, with a 7-day trend indicator and sparkline.

## How it works

1. A GitHub Actions workflow runs every morning at ~7am ET
2. It fetches the latest water level from Environment Canada's open data API
3. It computes the delta vs the 5-year July average and the 7-day trend
4. It sends a clean HTML email via Resend to you and your dad

**Cost: $0.** GitHub Actions is free for public repos, and Resend's free tier covers 100 emails/day.

---

## Setup (one-time, ~10 minutes)

### Step 1: Create a Resend account

1. Go to [resend.com](https://resend.com) and sign up (free)
2. In the dashboard, go to **API Keys** → **Create API Key**
3. Copy the key (starts with `re_...`) — you'll need it in Step 3

> **Optional but recommended:** To send from a custom address (like `bala@yourdomain.com`), add and verify your domain in Resend under **Domains**. Otherwise, emails will come from `onboarding@resend.dev` which works fine but may land in spam initially.

### Step 2: Create the GitHub repo

1. Go to [github.com/new](https://github.com/new)
2. Name it something like `bala-bay-notifier`
3. Make it **Public** (required for free GitHub Actions minutes)
4. Upload the files from this project:
   - `notify.mjs` (in the root)
   - `.github/workflows/daily-notify.yml` (in the `.github/workflows/` folder)

### Step 3: Add your secrets

In your GitHub repo:

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** and add these three:

| Secret name | Value | Example |
|---|---|---|
| `RESEND_API_KEY` | Your Resend API key | `re_abc123...` |
| `EMAIL_TO` | Comma-separated email addresses | `pedro@example.com,dad@example.com` |
| `EMAIL_FROM` | Sender address (optional) | `Bala Bay <onboarding@resend.dev>` |

> For `EMAIL_FROM`: if you haven't verified a custom domain in Resend, use `Bala Bay <onboarding@resend.dev>`.

### Step 4: Test it

1. Go to **Actions** tab in your repo
2. Click **Daily Bala Bay Water Level** on the left
3. Click **Run workflow** → **Run workflow**
4. Watch it run — you should get an email within a minute!

### Step 5: Done

The workflow will now run automatically every morning. GitHub will email you if it ever fails.

---

## What the email looks like

```
🌊 Bala Bay: 224.87m (+3.2cm vs July)

Current Level: 224.872 m

vs 5-Year July Average: +3.2 cm
  Slightly above normal · July avg: 224.840m

7-day trend: +0.8 cm ↗ rising

[sparkline of last 14 days]
```

---

## Customization

**Change the schedule:** Edit `.github/workflows/daily-notify.yml` and modify the cron expression. Use [crontab.guru](https://crontab.guru) to build the schedule.

**Add more recipients:** Update the `EMAIL_TO` secret with additional comma-separated addresses.

**Change the station:** Edit `notify.mjs` and change the `STATION` constant. Find station IDs at [wateroffice.ec.gc.ca](https://wateroffice.ec.gc.ca/search/real_time_e.html).

---

## Data source

All data comes from Environment Canada's MSC Open Data OGC API:
- **Realtime readings:** [api.weather.gc.ca/collections/hydrometric-realtime](https://api.weather.gc.ca/collections/hydrometric-realtime)
- **Historical daily means (HYDAT):** [api.weather.gc.ca/collections/hydrometric-daily-mean](https://api.weather.gc.ca/collections/hydrometric-daily-mean)
