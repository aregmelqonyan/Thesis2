const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const survey = require('./survey');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'responses.json');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Permanent copy in Google Sheets (see google-apps-script/Code.gs). Hosting disks like Render free are wiped on restart.
const SHEET_URL = process.env.GOOGLE_SHEET_URL || '';
const SHEET_SECRET = process.env.SHEET_SECRET || '';

// ---------- Storage (JSON file, serialized writes) ----------

async function readAll() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

let writeQueue = Promise.resolve();

function append(record) {
  const job = writeQueue.then(async () => {
    const all = await readAll();
    all.push(record);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2));
    await fs.rename(tmp, DATA_FILE); // atomic replace, never a half-written file
  });
  writeQueue = job.catch(() => {});
  return job;
}

// ---------- Google Sheets ----------

const allQuestions = survey.sections.flatMap((s) => s.questions);
const optionLabel = (q, v) => q.options?.find((o) => o.value === v)?.label ?? v;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function displayValue(q, answers) {
  const v = answers[q.id];
  if (v === undefined) return '';
  const other = answers[`${q.id}_other`] ? ` (${answers[`${q.id}_other`]})` : '';
  switch (q.type) {
    case 'single': return optionLabel(q, v) + (v === 'other' ? other : '');
    case 'multi': return v.map((x) => optionLabel(q, x) + (x === 'other' ? other : '')).join('; ');
    case 'consent': return v ? 'Այո' : '';
    default: return v;
  }
}

// One readable spreadsheet row: [header, value] pairs in a fixed order.
function toColumns(record) {
  const cols = [];
  for (const q of allQuestions) {
    if (q.type === 'likert') q.rows.forEach((row) => cols.push([row.label, record.answers[q.id]?.[row.id] ?? '']));
    else cols.push([q.label, displayValue(q, record.answers)]);
  }
  cols.push(['Տևողություն (վրկ)', Math.round(record.meta.durationMs / 1000)]);
  cols.push(['Սարք', record.meta.pointer === 'touch' ? 'Հեռախոս / պլանշետ' : 'Համակարգիչ']);
  return cols;
}

// Runs in the background so the participant never waits for Google. Retries; the script skips duplicate ids.
async function sendToSheet(record) {
  const body = JSON.stringify({ secret: SHEET_SECRET, record, columns: toColumns(record) });
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(SHEET_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const data = await res.json();
      if (data.ok) return;
      if (data.error === 'unauthorized') throw Object.assign(new Error('SHEET_SECRET does not match the script'), { fatal: true });
      throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      console.error(`Google Sheets save failed for ${record.id} (attempt ${attempt}/5): ${err.message}`);
      if (err.fatal) return;
      await sleep(3000 * attempt);
    }
  }
}

async function readSheet() {
  const res = await fetch(`${SHEET_URL}?secret=${encodeURIComponent(SHEET_SECRET)}`);
  const data = await res.json();
  if (!Array.isArray(data.responses)) throw new Error(data.error || `HTTP ${res.status}`);
  return data.responses;
}

// ---------- Validation against the survey schema ----------

const isVisible = (item, answers) => !item.showIf || item.showIf.in.includes(answers[item.showIf.field]);
const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function checkQuestion(q, value) {
  const values = (q.options || []).map((o) => o.value);

  switch (q.type) {
    case 'single':
      if (isBlank(value)) return {};
      return values.includes(value) ? { value } : { error: 'invalid' };

    case 'multi': {
      if (isBlank(value)) return {};
      if (!Array.isArray(value) || !value.every((v) => values.includes(v))) return { error: 'invalid' };
      return { value: [...new Set(value)] };
    }

    case 'scale': {
      if (isBlank(value)) return {};
      const n = Number(value);
      return Number.isInteger(n) && n >= q.min && n <= q.max ? { value: n } : { error: 'invalid' };
    }

    case 'likert': {
      if (!value || typeof value !== 'object') return {};
      const out = {};
      for (const row of q.rows) {
        const n = Number(value[row.id]);
        if (value[row.id] === undefined) continue;
        if (!Number.isInteger(n) || n < 1 || n > q.scale.length) return { error: 'invalid' };
        out[row.id] = n;
      }
      if (q.required && Object.keys(out).length !== q.rows.length) return { error: 'incomplete' };
      return Object.keys(out).length ? { value: out } : {};
    }

    case 'text':
    case 'textarea': {
      const text = cleanText(value, q.maxLength || 500);
      if (!text) return {};
      if (q.inputType === 'email' && !EMAIL_RE.test(text)) return { error: 'email' };
      return { value: text };
    }

    case 'consent':
      return value === true ? { value: true } : {};

    default:
      return { error: 'invalid' };
  }
}

function validate(input) {
  const errors = {};
  const clean = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: { _: 'invalid' }, clean };

  for (const section of survey.sections) {
    if (!isVisible(section, input)) continue;
    for (const q of section.questions) {
      if (!isVisible(q, input)) continue;
      const { value, error } = checkQuestion(q, input[q.id]);
      if (error) errors[q.id] = error;
      else if (value !== undefined) clean[q.id] = value;
      else if (q.required) errors[q.id] = 'required';

      const pickedOther = value === 'other' || (Array.isArray(value) && value.includes('other'));
      const other = cleanText(input[`${q.id}_other`], 200);
      if (pickedOther && other) clean[`${q.id}_other`] = other;
    }
  }
  return { errors, clean };
}

// Interaction metrics collected by the page (HCI data). Only known keys and bounded numbers are kept.
const knownQuestionIds = new Set(survey.sections.flatMap((s) => s.questions.map((q) => q.id)));
const knownSectionIds = new Set(survey.sections.map((s) => s.id));
const int = (v, max = 864e5) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : 0);

function sanitizeMeta(meta, req) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const questions = {};
  for (const [id, q] of Object.entries(m.questions || {})) {
    if (knownQuestionIds.has(id) && q && typeof q === 'object') {
      questions[id] = { firstMs: int(q.first), lastMs: int(q.last), changes: int(q.changes, 1e5) };
    }
  }
  const sections = {};
  for (const [id, ms] of Object.entries(m.sections || {})) {
    if (knownSectionIds.has(id)) sections[id] = int(ms);
  }
  return {
    durationMs: int(m.durationMs),
    questions,
    sectionDwellMs: sections,
    viewport: { w: int(m.viewport?.w, 1e4), h: int(m.viewport?.h, 1e4) },
    pointer: m.pointer === 'touch' ? 'touch' : 'mouse',
    restoredDraft: m.restoredDraft === true,
    lang: cleanText(m.lang, 20),
    userAgent: cleanText(req.get('user-agent'), 300),
  };
}

// ---------- App ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/survey', (req, res) => res.json(survey));

app.post('/api/responses', async (req, res) => {
  const body = req.body || {};
  if (body.website) return res.status(201).json({ ok: true }); // honeypot: silently drop bots

  const { errors, clean } = validate(body.answers);
  if (Object.keys(errors).length) return res.status(422).json({ error: 'validation', fields: errors });

  const record = {
    id: crypto.randomUUID(),
    surveyId: survey.id,
    submittedAt: new Date().toISOString(),
    answers: clean,
    meta: sanitizeMeta(body.meta, req),
  };

  if (SHEET_URL) sendToSheet(record);

  try {
    await append(record);
  } catch (err) {
    console.error('Failed to save response to file:', err);
    if (!SHEET_URL) return res.status(500).json({ error: 'storage' });
  }
  res.status(201).json({ ok: true, id: record.id });
});

function requireAdmin(req, res, next) {
  const given = Buffer.from(req.get('x-admin-token') || '');
  const expected = Buffer.from(ADMIN_TOKEN);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/api/responses', requireAdmin, async (req, res) => {
  let local;
  try {
    local = await readAll();
  } catch (err) {
    console.error('Failed to read responses:', err);
    if (!SHEET_URL) return res.status(500).json({ error: 'storage' });
    local = [];
  }
  if (!SHEET_URL) return res.json({ survey, responses: local, source: 'file' });

  try {
    // The sheet is the permanent store; add local answers that are still on their way to it.
    const remote = await readSheet();
    const ids = new Set(remote.map((r) => r.id));
    res.json({ survey, responses: [...remote, ...local.filter((r) => !ids.has(r.id))], source: 'sheet' });
  } catch (err) {
    console.error('Failed to read Google Sheet:', err.message);
    res.json({ survey, responses: local, source: 'file', warning: 'sheet_unavailable' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(PORT, () => {
  console.log(`\n  Survey:  http://localhost:${PORT}`);
  console.log(`  Admin:   http://localhost:${PORT}/admin`);
  console.log(`  Data:    ${DATA_FILE}`);
  console.log(`  Sheets:  ${SHEET_URL ? 'connected (answers are also saved to Google Sheets)' : 'not configured — set GOOGLE_SHEET_URL and SHEET_SECRET'}`);
  if (SHEET_URL && !SHEET_SECRET) console.log('  ⚠  GOOGLE_SHEET_URL is set but SHEET_SECRET is empty — the script will reject answers.');
  if (!process.env.ADMIN_TOKEN) console.log('  ⚠  Using default admin token "admin123" — set ADMIN_TOKEN before sharing publicly.\n');
});
