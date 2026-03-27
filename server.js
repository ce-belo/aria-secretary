const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const twilio = require('twilio');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Data directory — uses a mounted volume path on Railway, falls back to local for dev
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// Base URL for OAuth callbacks — set APP_URL env var on Railway
const BASE_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
  }
  // Environment variables override file values (used in cloud deployment)
  if (process.env.ANTHROPIC_KEY)        cfg.anthropicKey       = process.env.ANTHROPIC_KEY;
  if (process.env.TWILIO_ACCOUNT_SID)   cfg.twilioAccountSid   = process.env.TWILIO_ACCOUNT_SID;
  if (process.env.TWILIO_AUTH_TOKEN)    cfg.twilioAuthToken    = process.env.TWILIO_AUTH_TOKEN;
  if (process.env.TWILIO_FROM)          cfg.twilioFrom         = process.env.TWILIO_FROM;
  if (process.env.WHATSAPP_NUMBER)      cfg.whatsappNumber     = process.env.WHATSAPP_NUMBER;
  if (process.env.GOOGLE_CLIENT_ID)     cfg.googleClientId     = process.env.GOOGLE_CLIENT_ID;
  if (process.env.GOOGLE_CLIENT_SECRET) cfg.googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (process.env.USER_NAME)            cfg.userName           = process.env.USER_NAME;
  if (process.env.MORNING_TIME)         cfg.morningTime        = process.env.MORNING_TIME;
  if (process.env.EVENING_TIME)         cfg.eveningTime        = process.env.EVENING_TIME;
  return cfg;
}

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.completionLog) data.completionLog = [];
    return data;
  }
  return { tasks: [], completedTasks: [], schedules: [], debrief: [], completionLog: [] };
}

function saveData(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('saveData error:', err.message);
  }
}

function saveConfig(config) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('saveConfig error:', err.message);
  }
}

// ── Twilio ──────────────────────────────────────────────────────────────────
function getTwilioClient() {
  const cfg = loadConfig();
  if (!cfg.twilioAccountSid || !cfg.twilioAuthToken) return null;
  return twilio(cfg.twilioAccountSid, cfg.twilioAuthToken);
}

async function sendWhatsApp(message) {
  const cfg = loadConfig();
  const client = getTwilioClient();
  if (!client) throw new Error('Twilio not configured');
  await client.messages.create({
    from: `whatsapp:${cfg.twilioFrom}`,
    to: `whatsapp:${cfg.whatsappNumber}`,
    body: message
  });
}

// ── Google Calendar ──────────────────────────────────────────────────────────
async function getCalendarEvents(days = 1, from = 0) {
  const cfg = loadConfig();
  if (!cfg.googleCredentials?.tokens) return [];
  try {
    const auth = new google.auth.OAuth2(
      cfg.googleCredentials.client_id,
      cfg.googleCredentials.client_secret,
      `${BASE_URL}/auth/google/callback`
    );
    auth.setCredentials(cfg.googleCredentials.tokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const timeMin = new Date(now);
    timeMin.setHours(0, 0, 0, 0);
    timeMin.setDate(timeMin.getDate() + from);
    const timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + days);
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return (res.data.items || []).map(e => ({
      title: e.summary,
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      description: e.description || ''
    }));
  } catch (err) {
    console.error('Calendar error:', err.message);
    return [];
  }
}

// ── Anthropic / Claude ───────────────────────────────────────────────────────
async function callClaude(systemPrompt, userMessage) {
  const cfg = loadConfig();
  const anthropic = new Anthropic({ apiKey: (cfg.anthropicKey || '').replace(/\s+/g, '') });
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });
  return res.content[0].text;
}

// ── Briefing / Debriefing ────────────────────────────────────────────────────
async function generateMorningBriefing() {
  const data = loadData();
  const events = await getCalendarEvents();
  const today = todayStr();
  const habits = data.tasks.filter(t => t.type === 'habit' && !t.completed);
  const tasks = data.tasks.filter(t => t.type !== 'habit' && !t.completed);

  const system = `You are a personal secretary sending a WhatsApp morning briefing. 
Be warm, concise, and motivating. Use emojis sparingly. Format for WhatsApp (no markdown headers).
Start with a greeting and today's date.`;

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = `Today is ${dateStr}.
Daily habits to complete: ${JSON.stringify(habits.map(h => h.title))}
Tasks & deadlines: ${JSON.stringify(tasks.map(t => ({ title: t.title, priority: t.priority, deadline: t.deadline })))}
Calendar events: ${JSON.stringify(events)}
Create a concise morning briefing covering: greeting, calendar overview, today's habits, top priority tasks, and an encouraging note.`;

  return await callClaude(system, prompt);
}

async function generateEveningDebrief(userReflection) {
  const data = loadData();
  const completed = data.tasks.filter(t => t.completed && isToday(t.completedAt));
  const pending = data.tasks.filter(t => !t.completed);

  const system = `You are a personal secretary conducting an evening debrief via WhatsApp.
Be warm, reflective, and forward-looking. Use emojis sparingly. Format for WhatsApp.`;

  const prompt = `Completed today: ${JSON.stringify(completed)}
Still pending: ${JSON.stringify(pending)}
User reflection: ${userReflection}
Generate a warm debrief: celebrate wins, acknowledge what wasn't done without judgment, and suggest top 3 priorities for tomorrow.`;

  return await callClaude(system, prompt);
}

async function generateBatchReminder(tasks) {
  const system = `You are a personal secretary sending a brief WhatsApp reminder.
Be friendly and action-oriented. Use 1-2 emojis max. Keep it concise.`;

  if (tasks.length === 1) {
    const task = tasks[0];
    const prompt = `Send a reminder for this task: "${task.title}". Priority: ${task.priority}.`;
    return await callClaude(system, prompt);
  }

  const taskList = tasks.map(t => `- ${t.title} (${t.priority} priority)`).join('\n');
  const prompt = `Send a single combined reminder for these ${tasks.length} tasks:\n${taskList}\nList all tasks clearly in one short message.`;
  return await callClaude(system, prompt);
}

function isToday(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

// ── Daily Reset ──────────────────────────────────────────────────────────────
function runDailyReset() {
  const data = loadData();
  const today = todayStr();

  // Skip if already done today
  if (data.lastResetDate === today) {
    console.log('Daily reset: already done for today');
    return;
  }

  // Tasks: completed tasks stay completed — they do NOT roll back to pending.
  // Uncompleted tasks naturally carry over since they are already pending.
  // Habits: no action needed — completedDates tracking auto-resets each new date.

  data.lastResetDate = today;
  saveData(data);
  console.log(`Daily reset (${today}): habits will auto-reset via date tracking, completed tasks stay done`);
}

// ── Scheduler ────────────────────────────────────────────────────────────────

function isWithinActiveWindow(task) {
  const start = task.activeStart || '00:00';
  const end   = task.activeEnd   || '23:59';
  const now   = new Date();
  const cur   = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return cur >= sh * 60 + sm && cur <= eh * 60 + em;
}

function calculateNTimes(activeStart, activeEnd, n) {
  const [sh, sm] = (activeStart || '08:00').split(':').map(Number);
  const [eh, em] = (activeEnd   || '22:00').split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  const step = (endMin - startMin) / (n + 1);
  const times = [];
  for (let i = 1; i <= n; i++) {
    const total = Math.round(startMin + step * i);
    const h = Math.floor(total / 60);
    const m = total % 60;
    times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return times;
}

function todayStr() {
  return new Date().toISOString().substring(0, 10);
}

function isHabitDoneToday(task) {
  return (task.completedDates || []).includes(todayStr());
}

function shouldRemindNow(task) {
  if (task.completed) return false;
  if (task.type === 'habit' && isHabitDoneToday(task)) return false;
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const currentTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const repeat = task.repeat || 'none';

  if (repeat === 'hourly') return m === 0 && isWithinActiveWindow(task);
  if (repeat === 'interval') {
    const mins = task.intervalMinutes || (parseInt(task.intervalHours, 10) * 60) || 60;
    const totalMin = h * 60 + m;
    return totalMin % mins === 0 && isWithinActiveWindow(task);
  }
  if (repeat === 'ntimes') {
    const times = calculateNTimes(task.activeStart, task.activeEnd, parseInt(task.ntimesCount) || 3);
    return times.includes(currentTime);
  }
  if (repeat === 'custom') return (task.reminderTimes || []).includes(currentTime);
  // none / daily
  return task.reminderTime === currentTime;
}

function initSchedules() {
  const cfg = loadConfig();

  // Morning briefing
  if (cfg.morningTime) {
    const [h, m] = cfg.morningTime.split(':').map(Number);
    cron.schedule(`${m} ${h} * * *`, async () => {
      try {
        const briefing = await generateMorningBriefing();
        await sendWhatsApp(briefing);
        console.log('Morning briefing sent');
      } catch (err) { console.error('Briefing error:', err.message); }
    });
  }

  // Evening debrief trigger
  if (cfg.eveningTime) {
    const [h, m] = cfg.eveningTime.split(':').map(Number);
    cron.schedule(`${m} ${h} * * *`, async () => {
      try {
        const msg = "🌙 Good evening! Time for your daily debrief. How did today go? What did you accomplish, and what's on your mind for tomorrow? Reply here or open the app to record your debrief.";
        await sendWhatsApp(msg);
        console.log('Evening debrief prompt sent');
      } catch (err) { console.error('Debrief error:', err.message); }
    });
  }

  // Midnight reset: move completed tasks back to pending for the new day
  cron.schedule('0 0 * * *', runDailyReset);

  // Single every-minute job that batches all due reminders into one message
  cron.schedule('* * * * *', async () => {
    try {
      const data = loadData();
      const dueTasks = data.tasks.filter(t => shouldRemindNow(t));
      if (dueTasks.length === 0) return;
      const message = await generateBatchReminder(dueTasks);
      await sendWhatsApp(message);
      console.log(`Sent batch reminder for ${dueTasks.length} task(s): ${dueTasks.map(t => t.title).join(', ')}`);
    } catch (err) { console.error('Reminder error:', err.message); }
  });
}

// ── API Routes ───────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  // Don't expose secrets fully
  res.json({
    hasTwilio: !!(cfg.twilioAccountSid && cfg.twilioAuthToken),
    hasAnthropicKey: !!cfg.anthropicKey,
    hasCalendar: !!cfg.googleCredentials?.tokens,
    whatsappNumber: cfg.whatsappNumber || '',
    morningTime: cfg.morningTime || '08:00',
    eveningTime: cfg.eveningTime || '21:00',
    userName: cfg.userName || ''
  });
});

app.post('/api/config', (req, res) => {
  const existing = loadConfig();
  const updated = { ...existing, ...req.body };
  saveConfig(updated);
  // Reinitialize schedules
  initSchedules();
  res.json({ success: true });
});

app.get('/api/tasks', (req, res) => {
  const data = loadData();
  res.json(data.tasks);
});

app.post('/api/tasks', (req, res) => {
  const data = loadData();
  const task = {
    id: Date.now().toString(),
    type: req.body.type || 'task',                 // 'habit' | 'task'
    title: req.body.title,
    description: req.body.description || '',
    priority: req.body.priority || 'medium',
    deadline: req.body.deadline || null,           // ISO date (tasks only)
    completedDates: [],                            // tracks daily completion (habits only)
    reminderTime: req.body.reminderTime || null,
    reminderTimes: req.body.reminderTimes || [],
    repeat: req.body.repeat || 'none',
    intervalMinutes: req.body.intervalMinutes || null,
    ntimesCount: req.body.ntimesCount || 3,
    activeStart: req.body.activeStart || '08:00',
    activeEnd: req.body.activeEnd || '22:00',
    completed: false,
    createdAt: new Date().toISOString()
  };
  data.tasks.push(task);
  saveData(data);
  res.json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const data = loadData();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const wasCompleted = data.tasks[idx].completed;
  data.tasks[idx] = { ...data.tasks[idx], ...req.body };
  const now = new Date().toISOString();
  if (req.body.completed) data.tasks[idx].completedAt = now;
  // Log completion if task just became completed
  if (!wasCompleted && req.body.completed) {
    if (!data.completionLog) data.completionLog = [];
    data.completionLog.push({
      taskId: data.tasks[idx].id,
      title: data.tasks[idx].title,
      type: data.tasks[idx].type || 'task',
      completedAt: now,
      date: todayStr()
    });
  }
  saveData(data);
  res.json(data.tasks[idx]);
});

// Toggle habit completion for today
app.post('/api/tasks/:id/toggle-today', (req, res) => {
  const data = loadData();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const task = data.tasks[idx];
  const today = todayStr();
  const dates = task.completedDates || [];
  const wasAlreadyDone = dates.includes(today);
  data.tasks[idx].completedDates = wasAlreadyDone
    ? dates.filter(d => d !== today)
    : [...dates, today];
  // Log completion when marking done (not when un-marking)
  if (!wasAlreadyDone) {
    if (!data.completionLog) data.completionLog = [];
    data.completionLog.push({
      taskId: task.id,
      title: task.title,
      type: 'habit',
      completedAt: new Date().toISOString(),
      date: today
    });
  }
  saveData(data);
  res.json(data.tasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const data = loadData();
  data.tasks = data.tasks.filter(t => t.id !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

app.post('/api/send-briefing', async (req, res) => {
  try {
    const briefing = await generateMorningBriefing();
    await sendWhatsApp(briefing);
    res.json({ success: true, message: briefing });
  } catch (err) {
    console.error('Send briefing error:', err.message, err.status, err.cause);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-debrief', async (req, res) => {
  try {
    const debrief = await generateEveningDebrief(req.body.reflection || '');
    await sendWhatsApp(debrief);
    res.json({ success: true, message: debrief });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/voice-command', async (req, res) => {
  try {
    const { transcript } = req.body;
    const data = loadData();
    const tasks = data.tasks;

    const system = `You are a personal secretary AI. Parse the user's voice command and return a JSON response.
Respond ONLY with valid JSON. No other text.
Possible actions:
- add_task: { action: "add_task", title, description, priority (low/medium/high), reminderTime (HH:MM or null), reminderTimes (array of HH:MM, only if repeat=custom), repeat ("none"|"daily"|"hourly"|"interval"|"ntimes"|"custom"), intervalHours (number, only if repeat=interval), ntimesCount (number, only if repeat=ntimes), activeStart (HH:MM, default "08:00"), activeEnd (HH:MM, default "22:00") }
- modify_task: { action: "modify_task", taskTitle, updates: { title?, priority?, reminderTime?, reminderTimes?, repeat?, intervalHours?, ntimesCount?, activeStart?, activeEnd?, description? } }
- complete_task: { action: "complete_task", taskTitle }
- list_tasks: { action: "list_tasks" }
- send_briefing: { action: "send_briefing" }
- send_debrief: { action: "send_debrief", reflection }
- general_response: { action: "general_response", message }
Examples: "remind me to drink water every hour" → repeat:hourly. "remind me to workout every day at 7am" → repeat:daily, reminderTime:"07:00". "remind me every 2 hours" → repeat:interval, intervalHours:2. "remind me 3 times a day" → repeat:ntimes, ntimesCount:3. "remind me at 9am, 1pm and 6pm" → repeat:custom, reminderTimes:["09:00","13:00","18:00"].`;

    const prompt = `Current tasks: ${JSON.stringify(tasks.map(t => ({ id: t.id, title: t.title, completed: t.completed })))}
User said: "${transcript}"
Parse this into a secretary action.`;

    const response = await callClaude(system, prompt);
    const parsed = JSON.parse(response.replace(/```json|```/g, '').trim());
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/calendar', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 1, 30);
    const from = Math.max(parseInt(req.query.from) || 0, 0);
    const events = await getCalendarEvents(days, from);
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Productivity ──────────────────────────────────────────────────────────────
app.get('/api/productivity', (req, res) => {
  const data = loadData();
  const log = data.completionLog || [];
  const { from, to } = req.query;
  const filtered = log.filter(e => {
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    return true;
  });
  // Group by date
  const byDate = {};
  filtered.forEach(e => {
    if (!byDate[e.date]) byDate[e.date] = { tasks: 0, habits: 0, items: [] };
    byDate[e.date].items.push(e);
    if (e.type === 'habit') byDate[e.date].habits++;
    else byDate[e.date].tasks++;
  });
  const tasksDone  = filtered.filter(e => e.type !== 'habit').length;
  const habitsDone = filtered.filter(e => e.type === 'habit').length;
  const dates = Object.keys(byDate).sort();
  const bestDay = dates.reduce((best, d) =>
    !best || (byDate[d].tasks + byDate[d].habits) > (byDate[best].tasks + byDate[best].habits) ? d : best, null);
  res.json({ total: filtered.length, tasksDone, habitsDone, byDate, bestDay, log: filtered });
});

app.post('/api/productivity/report', async (req, res) => {
  try {
    const data = loadData();
    const log = data.completionLog || [];
    const { from, to, period } = req.body;
    const filtered = log.filter(e => {
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
      return true;
    });
    const tasksDone  = filtered.filter(e => e.type !== 'habit').length;
    const habitsDone = filtered.filter(e => e.type === 'habit').length;
    // Count frequency per title
    const freq = {};
    filtered.forEach(e => { freq[e.title] = (freq[e.title] || 0) + 1; });
    const topItems = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
    // Count active days
    const activeDays = new Set(filtered.map(e => e.date)).size;
    const system = `You are Aria, a warm and insightful personal productivity coach.
Analyse the user's task completion data and give them an encouraging, honest report.
Be concise, specific, and motivating. Format for WhatsApp-style plain text (no markdown).`;
    const prompt = `Period: ${period || `${from} to ${to}`}
Total completions: ${filtered.length} (${tasksDone} tasks, ${habitsDone} habit check-ins)
Active days: ${activeDays}
Most completed items: ${JSON.stringify(topItems)}
Full log: ${JSON.stringify(filtered.slice(-100))}
Write a warm productivity report: highlight their wins, point out patterns, and give one or two suggestions for the next period.`;
    const report = await callClaude(system, prompt);
    res.json({ report, stats: { total: filtered.length, tasksDone, habitsDone, activeDays, topItems } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google OAuth
app.get('/auth/google', (req, res) => {
  const cfg = loadConfig();
  if (!cfg.googleClientId || !cfg.googleClientSecret) {
    return res.status(400).json({ error: 'Google credentials not configured' });
  }
  const auth = new google.auth.OAuth2(
    cfg.googleClientId, cfg.googleClientSecret,
    `${BASE_URL}/auth/google/callback`
  );
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.readonly']
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const cfg = loadConfig();
    const auth = new google.auth.OAuth2(
      cfg.googleClientId, cfg.googleClientSecret,
      `${BASE_URL}/auth/google/callback`
    );
    const { tokens } = await auth.getToken(req.query.code);
    cfg.googleCredentials = {
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      tokens
    };
    saveConfig(cfg);
    res.redirect('/?calendar=connected');
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.redirect('/?calendar=error&msg=' + encodeURIComponent(err.message));
  }
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Personal Secretary running at ${BASE_URL} (port ${PORT})`);
  runDailyReset();   // catch up if server was off at midnight
  initSchedules();
});
