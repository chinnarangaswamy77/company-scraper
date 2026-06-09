# Deployment Guide - Hosting on Railway (Persistent Node.js + PostgreSQL)

Since this application runs a **10-minute background job discovery scraper** inside the Node.js event loop and parses live data, it requires a **persistent server hosting environment**. 

**Railway** is the recommended platform because:
1. It hosts persistent Node.js servers 24/7, keeping your scraper active.
2. It provides native, one-click PostgreSQL database provisioning.
3. It deploys automatically upon code changes on your GitHub repository.

---

## Prerequisites
1. A **GitHub** account (with this repository pushed).
2. A **Railway** account (linked to GitHub via [railway.app](https://railway.app)).

---

## Step-by-Step Deployment Instructions

### Step 1: Push Your Code to GitHub
Ensure all your local changes (including status badges, theme contrast repairs, and duplicate cleaners) are committed and pushed to your GitHub repository:
```bash
git add .
git commit -m "feat: complete saas redesign with status badges, duplicate pruning, and 10min sync"
git push origin main
```

### Step 2: Create a New Project on Railway
1. Go to your [Railway Dashboard](https://railway.app).
2. Click **New Project** in the upper right.
3. Select **Deploy from GitHub repo**.
4. Choose this repository from your list.
5. Click **Deploy Now**. (The initial build will start).

### Step 3: Add PostgreSQL Database
1. Inside your Railway project canvas, click **+ Add** or **+ New** in the upper right.
2. Select **Database** > **Add PostgreSQL**.
3. Railway will provision a fully hosted PostgreSQL instance immediately.

### Step 4: Link PostgreSQL to Next.js Environment Variables
1. Click on your deployed **Next.js Web Service** card on the Railway canvas.
2. Go to the **Variables** tab.
3. Click **New Variable** and add:
   * **Name:** `PG_CONN_STRING`
   * **Value:** `${{Postgres.DATABASE_URL}}` *(This tells Railway to automatically bind the PostgreSQL database's connection string to your Next.js application variables).*
4. Click **Save**. Railway will automatically trigger a redeploy of your Next.js application with the database connected.

### Step 5: Configure Port & Generate Domain
1. In your **Next.js Web Service** card settings, go to the **Settings** tab.
2. Under **Networking**, click **Generate Domain** to get a public HTTP address (e.g. `your-app-production.up.railway.app`).
3. Under **Service**, ensure the Start Command is blank (it defaults to `npm run start` which is correct).

---

## Verification & Monitoring
Once the build is complete (indicated by a green checkmark next to your deployment):
1. Click your public Railway URL to open your live dashboard.
2. Go to the **Companies Directory** and click **Trigger Scrape** or watch the live logs at the bottom.
3. To view database records, you can click on the **PostgreSQL** card on your Railway project canvas and use the **Data** viewer tab to see live rows.
