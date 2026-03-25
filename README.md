# Aria — Personal Secretary

Your AI-powered personal secretary with WhatsApp reminders, voice input, and Google Calendar integration.

---

## Features

- 🎙 **Voice Commands** — Add tasks, mark complete, trigger briefings by speaking
- 📱 **WhatsApp Messages** — Morning briefing, scheduled reminders, evening debrief
- 📅 **Google Calendar** — Pulls today's events to give context-aware briefings
- 🤖 **Claude AI** — Natural language understanding and message generation
- ⏰ **Smart Scheduling** — Set reminder times per task; automated daily schedule

---

## Setup (5 steps)

### 1. Install Node.js
Download from [nodejs.org](https://nodejs.org) (v18 or later)

### 2. Install dependencies
```bash
cd secretary-app
npm install
```

### 3. Get your API keys

**Anthropic (Claude AI):**
- Go to [console.anthropic.com](https://console.anthropic.com)
- Create an API key

**Twilio (WhatsApp):**
- Create a free account at [twilio.com](https://www.twilio.com)
- Go to Messaging → Try it Out → Send a WhatsApp Message
- Follow Twilio's sandbox setup (you'll send a join code to their WhatsApp number)
- Note your Account SID, Auth Token, and sandbox number (+14155238886 by default)

**Google Calendar:**
- Go to [console.cloud.google.com](https://console.cloud.google.com)
- Create a new project
- Enable the **Google Calendar API**
- Go to APIs & Services → Credentials → Create OAuth 2.0 Client ID
  - Application type: Web application
  - Authorized redirect URI: `http://localhost:3000/auth/google/callback`
- Note your Client ID and Client Secret

### 4. Start the server
```bash
npm start
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 5. Configure in the app
- Click **⚙ Setup** in the top right
- Enter your name, WhatsApp number (with country code, e.g. +1234567890)
- Enter your Anthropic API key
- Enter your Twilio credentials
- Enter Google credentials, then click **Save & Connect Google**
- Authorize Google Calendar access

---

## Voice Commands (examples)

| Say | Action |
|-----|--------|
| "Add a high priority task to review the report at 3pm" | Creates task with reminder |
| "Mark the report review as done" | Completes the task |
| "Send my morning briefing" | Sends WhatsApp briefing now |
| "How many tasks do I have?" | Shows count |

---

## Daily Flow

| Time | What Aria does |
|------|----------------|
| Your morning time (default 8am) | Sends WhatsApp briefing with calendar + top tasks |
| Throughout day | Sends task reminders at their scheduled times |
| Your evening time (default 9pm) | Sends prompt to reflect on your day |
| You reply in app | Click "Send Debrief" to get an AI-written summary + tomorrow's plan |

---

## Deploy (optional, for 24/7 running)

To run this beyond your local machine, deploy to a free service:

**Railway:** [railway.app](https://railway.app) — Connect GitHub repo, deploy automatically  
**Render:** [render.com](https://render.com) — Free tier available  

Set environment variables for your config instead of using the UI config file.

---

## Files

```
secretary-app/
├── server.js       — Node.js backend (Express + cron + Twilio + Google)
├── package.json    — Dependencies
├── public/
│   └── index.html  — Web frontend (voice, tasks, debrief UI)
├── config.json     — Your API keys (auto-created, never commit this!)
└── data.json       — Your tasks (auto-created)
```

---

## Privacy

- All data stays local in `config.json` and `data.json`
- API calls go to Anthropic (message generation) and Twilio (WhatsApp delivery)
- Google Calendar access is read-only
