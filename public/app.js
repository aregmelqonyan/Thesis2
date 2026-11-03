(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');

  const DRAFT_KEY = 'hci-risk-survey-draft-v1';
  const CHECK_SVG = '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const MESSAGES = {
    required: 'Խնդրում ենք պատասխանել այս հարցին',
    incomplete: 'Խնդրում ենք գնահատել բոլոր պնդումները',
    email: 'Էլ. հասցեն ճիշտ ձևաչափով չէ',
    invalid: 'Անվավեր պատասխան',
  };

  let survey;
  let answers = {};
  const questionById = {};
  const startedAt = Date.now();
  // HCI interaction metrics: when each question was first/last touched and how many times it changed.
  const metrics = { questions: {}, sections: {}, restoredDraft: false };

  // ---------- Storage helpers (browser storage can be unavailable) ----------
  const storage = {
    get() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } },
    set(v) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(v)); } catch { /* ignore */ } },
    clear() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } },
  };

  // ---------- Rendering ----------
  const optionChip = (type, q, o) => `
    <label class="chip">
      <input type="${type}" name="${q.id}" value="${esc(o.value)}" data-q="${q.id}">
      <span class="chip-box"><span class="mark ${type === 'radio' ? 'radio' : 'check'}">${type === 'radio' ? '' : CHECK_SVG}</span>${esc(o.label)}</span>
    </label>`;

  const otherField = (q) =>
    q.options.some((o) => o.value === 'other')
      ? `<input class="field other-field" type="text" name="${q.id}_other" data-other="${q.id}" placeholder="Նշեք ձեր տարբերակը…" maxlength="200" hidden>`
      : '';

  function renderBody(q) {
    switch (q.type) {
      case 'single':
      case 'multi':
        return `<div class="chips ${q.columns ? `cols-${q.columns}` : ''}">${q.options.map((o) => optionChip(q.type === 'single' ? 'radio' : 'checkbox', q, o)).join('')}</div>${otherField(q)}`;

      case 'scale': {
        const items = [];
        for (let i = q.min; i <= q.max; i++) {
          const hue = Math.round(((i - q.min) / (q.max - q.min)) * 150); // red → green
          items.push(`<label class="scale-item" style="--h:${hue}"><input type="radio" name="${q.id}" value="${i}" data-q="${q.id}"><span class="scale-box">${i}</span></label>`);
        }
        return `<div class="scale" role="radiogroup">${items.join('')}</div>
          <div class="scale-legend"><span>${esc(q.minLabel)}</span><span>${esc(q.maxLabel)}</span></div>`;
      }

      case 'likert':
        return `
          <div class="lk-scale-mobile"><span>1 · ${esc(q.scale[0])}</span><span>${q.scale.length} · ${esc(q.scale.at(-1))}</span></div>
          <div class="likert">
            <div class="lk-head"><span>Պնդում</span>${q.scale.map((s) => `<span>${esc(s)}</span>`).join('')}</div>
            ${q.rows.map((r) => `
              <div class="lk-row" data-row="${r.id}" data-aoi="likert-${r.id}" role="radiogroup" aria-label="${esc(r.label)}">
                <div class="lk-text">${esc(r.label)}</div>
                ${q.scale.map((s, i) => `
                  <label class="lk-cell" title="${esc(s)}">
                    <input type="radio" name="${q.id}__${r.id}" value="${i + 1}" data-q="${q.id}" data-row="${r.id}" aria-label="${esc(s)}">
                    <span class="lk-dot">${i + 1}</span>
                  </label>`).join('')}
              </div>`).join('')}
          </div>`;

      case 'text':
        return `<input class="field" type="${q.inputType || 'text'}" name="${q.id}" data-q="${q.id}" placeholder="${esc(q.placeholder)}" maxlength="${q.maxLength || 500}" ${q.inputType === 'email' ? 'autocomplete="email" inputmode="email"' : ''}>`;

      case 'textarea':
        return `<textarea class="field" name="${q.id}" data-q="${q.id}" placeholder="${esc(q.placeholder)}" maxlength="${q.maxLength || 2000}"></textarea>
          <div class="counter"><span data-counter="${q.id}">0</span> / ${q.maxLength || 2000}</div>`;

      case 'consent':
        return `<label class="consent"><input type="checkbox" name="${q.id}" data-q="${q.id}"><span class="consent-box">${CHECK_SVG}</span><span class="consent-text">${esc(q.text)}</span></label>`;

      default:
        return '';
    }
  }

  function render() {
    let qNum = 0;
    $('#sections').innerHTML = survey.sections.map((s, si) => `
      <section class="section" id="sec-${s.id}" data-section="${s.id}" data-aoi="section-${s.id}">
        <header class="section-head">
          <span class="section-num">${pad(si + 1)}</span>
          <div><h2>${esc(s.title)}</h2><p>${esc(s.description)}</p></div>
        </header>
        ${s.questions.map((q) => {
          questionById[q.id] = q;
          qNum++;
          return `
            <div class="q" id="q-${q.id}" data-qid="${q.id}" data-aoi="q-${q.id}">
              ${q.type === 'consent' ? '' : `<div class="q-label"><span class="q-index" data-qnum>${pad(qNum)}</span><span>${esc(q.label)}${q.required ? ' <span class="req">*</span>' : ''}</span></div>`}
              ${q.hint ? `<p class="q-hint">${esc(q.hint)}</p>` : ''}
              <div class="q-body">${renderBody(q)}</div>
              <div class="q-error" role="alert"></div>
            </div>`;
        }).join('')}
      </section>`).join('');

    $('#steps').innerHTML = survey.sections.map((s, i) => `
      <li class="step" data-step="${s.id}"><a href="#sec-${s.id}"><span class="step-num"><span>${i + 1}</span></span><span class="step-label">${esc(s.short)}</span></a></li>`).join('');

    $('#survey-title').textContent = survey.title;
    $('#survey-subtitle').textContent = survey.subtitle;
    $('#stat-minutes').textContent = survey.estimatedMinutes;
    $('#stat-sections').textContent = survey.sections.length;
  }

  // ---------- State helpers ----------
  const isVisible = (item) => !item.showIf || item.showIf.in.includes(answers[item.showIf.field]);

  function isAnswered(q) {
    const v = answers[q.id];
    switch (q.type) {
      case 'multi': return Array.isArray(v) && v.length > 0;
      case 'likert': return !!v && q.rows.every((r) => v[r.id]);
      case 'consent': return v === true;
      case 'text':
      case 'textarea': return typeof v === 'string' && v.trim() !== '';
      default: return v !== undefined && v !== '';
    }
  }

  function visibleQuestions() {
    return survey.sections.filter(isVisible).flatMap((s) => s.questions.filter(isVisible));
  }

  function refresh() {
    // Conditional sections / questions
    for (const s of survey.sections) {
      const el = $(`#sec-${s.id}`);
      const show = isVisible(s);
      if (show && el.classList.contains('is-hidden')) {
        el.classList.remove('is-hidden');
        el.classList.add('reveal');
      }
      if (!show) el.classList.add('is-hidden');
      $(`.step[data-step="${s.id}"]`).hidden = !show;
    }

    // Renumber visible questions and sections
    let n = 0;
    survey.sections.filter(isVisible).forEach((s, i) => {
      $(`#sec-${s.id} .section-num`).textContent = pad(i + 1);
      $(`.step[data-step="${s.id}"] .step-num span`).textContent = i + 1;
      s.questions.forEach((q) => {
        if (q.type === 'consent') return;
        const idx = $(`#q-${q.id} [data-qnum]`);
        if (idx) idx.textContent = pad(++n);
      });
      const done = s.questions.filter((q) => q.required).every(isAnswered);
      $(`.step[data-step="${s.id}"]`).classList.toggle('done', done);
    });

    // Progress
    const qs = visibleQuestions();
    const answered = qs.filter(isAnswered).length;
    const pct = qs.length ? Math.round((answered / qs.length) * 100) : 0;
    $('#pct').textContent = pct;
    $('#progress-fill').style.width = `${pct}%`;
    $('#answered').textContent = answered;
    $('#total').textContent = qs.length;

    // Likert rows answered state
    $$('.lk-row').forEach((row) => {
      const q = questionById[row.closest('.q').dataset.qid];
      row.classList.toggle('answered', !!answers[q.id]?.[row.dataset.row]);
    });
  }

  function toggleOther(q) {
    const field = $(`[data-other="${q.id}"]`);
    if (!field) return;
    const v = answers[q.id];
    const show = v === 'other' || (Array.isArray(v) && v.includes('other'));
    if (show && field.hidden) { field.hidden = false; field.focus({ preventScroll: true }); }
    if (!show) field.hidden = true;
  }

  function track(id) {
    const t = Date.now() - startedAt;
    const m = (metrics.questions[id] ||= { first: t, changes: 0 });
    m.last = t;
    m.changes++;
  }

  const saveDraft = () => storage.set({ answers, savedAt: Date.now() });

  // ---------- Events ----------
  function onInput(e) {
    const t = e.target;
    const isTextual = t.tagName === 'TEXTAREA' || ['text', 'email'].includes(t.type);
    if (isTextual !== (e.type === 'input')) return; // text → "input", choices → "change"

    if (t.dataset.other) {
      answers[t.name] = t.value;
      saveDraft();
      return;
    }
    const q = questionById[t.dataset.q];
    if (!q) return;

    switch (q.type) {
      case 'single': answers[q.id] = t.value; break;
      case 'scale': answers[q.id] = Number(t.value); break;
      case 'multi': answers[q.id] = exclusive(q, t); break;
      case 'likert': answers[q.id] = { ...(answers[q.id] || {}), [t.dataset.row]: Number(t.value) }; break;
      case 'consent': answers[q.id] = t.checked; break;
      default: answers[q.id] = t.value;
    }

    if (q.type === 'textarea') $(`[data-counter="${q.id}"]`).textContent = t.value.length;
    track(q.id);
    toggleOther(q);
    clearError(q.id, t.dataset.row);
    refresh();
    saveDraft();
  }

  // "None" style options exclude the others (e.g. "Դեռ չեմ դիմել", "Խնդիրների չեմ հանդիպել").
  const EXCLUSIVE = ['none', 'nothing'];
  function exclusive(q, target) {
    const boxes = $$(`input[name="${q.id}"]`);
    if (target.checked) {
      const picked = EXCLUSIVE.includes(target.value);
      boxes.forEach((b) => {
        if (b !== target && (picked || EXCLUSIVE.includes(b.value))) b.checked = false;
      });
    }
    return boxes.filter((b) => b.checked).map((b) => b.value);
  }

  // ---------- Validation ----------
  function setError(id, code) {
    const el = $(`#q-${id}`);
    el.classList.add('has-error');
    $('.q-error', el).textContent = MESSAGES[code] || MESSAGES.invalid;
    const q = questionById[id];
    if (q.type === 'likert') {
      $$('.lk-row', el).forEach((row) => row.classList.toggle('missing', !answers[id]?.[row.dataset.row]));
    }
  }

  function clearError(id, row) {
    const el = $(`#q-${id}`);
    if (row) $(`.lk-row[data-row="${row}"]`, el)?.classList.remove('missing');
    if (questionById[id].type === 'likert' && !isAnswered(questionById[id])) return;
    el.classList.remove('has-error');
    $('.q-error', el).textContent = '';
  }

  function validateAll() {
    const bad = [];
    for (const q of visibleQuestions()) {
      if (q.required && !isAnswered(q)) {
        setError(q.id, q.type === 'likert' ? 'incomplete' : 'required');
        bad.push(q.id);
      } else if (q.inputType === 'email' && answers[q.id]?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(answers[q.id].trim())) {
        setError(q.id, 'email');
        bad.push(q.id);
      }
    }
    return bad;
  }

  function focusError(id) {
    const el = $(`#q-${id}`);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = 'toast'), 3600);
  }

  // ---------- Submit ----------
  function payload() {
    const out = {};
    for (const q of visibleQuestions()) {
      if (answers[q.id] !== undefined) out[q.id] = answers[q.id];
      if (answers[`${q.id}_other`]) out[`${q.id}_other`] = answers[`${q.id}_other`];
    }
    return {
      answers: out,
      website: $('#website').value,
      meta: {
        durationMs: Date.now() - startedAt,
        questions: metrics.questions,
        sections: metrics.sections,
        restoredDraft: metrics.restoredDraft,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        pointer: matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse',
        lang: navigator.language,
        gaze: window.EyeTracking ? EyeTracking.getData() : { enabled: false },
      },
    };
  }

  async function onSubmit(e) {
    e.preventDefault();
    const bad = validateAll();
    if (bad.length) {
      focusError(bad[0]);
      toast(`Լրացրեք պարտադիր դաշտերը (${bad.length})`, 'error');
      return;
    }

    const btn = $('#submit');
    btn.classList.add('loading');
    try {
      const res = await fetch('/api/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 422 && data.fields) {
        const ids = Object.keys(data.fields).filter((id) => questionById[id]);
        ids.forEach((id) => setError(id, data.fields[id]));
        if (ids[0]) focusError(ids[0]);
        toast('Որոշ պատասխաններ պետք է ճշտել', 'error');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      storage.clear();
      window.EyeTracking?.stop();
      $('#et-card').hidden = true;
      $('#response-id').textContent = (data.id || '').slice(0, 8).toUpperCase();
      $('#form').hidden = true;
      $('.intro-note').hidden = true;
      $('#progress').hidden = true;
      $('#success').hidden = false;
      $('#survey').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      console.error(err);
      toast('Չհաջողվեց ուղարկել։ Ստուգեք կապը և փորձեք նորից։', 'error');
    } finally {
      btn.classList.remove('loading');
    }
  }

  // ---------- Draft restore ----------
  function applyAnswers() {
    for (const q of Object.values(questionById)) {
      const v = answers[q.id];
      if (v === undefined) continue;
      switch (q.type) {
        case 'single':
        case 'scale':
          $$(`input[data-q="${q.id}"]`).forEach((i) => (i.checked = String(i.value) === String(v)));
          break;
        case 'multi':
          $$(`input[data-q="${q.id}"]`).forEach((i) => (i.checked = Array.isArray(v) && v.includes(i.value)));
          break;
        case 'likert':
          $$(`input[data-q="${q.id}"]`).forEach((i) => (i.checked = Number(v[i.dataset.row]) === Number(i.value)));
          break;
        case 'consent':
          $(`input[data-q="${q.id}"]`).checked = v === true;
          break;
        default: {
          const el = $(`[data-q="${q.id}"]`);
          el.value = v;
          const counter = $(`[data-counter="${q.id}"]`);
          if (counter) counter.textContent = v.length;
        }
      }
      const other = $(`[data-other="${q.id}"]`);
      if (other) other.value = answers[`${q.id}_other`] || '';
      toggleOther(q);
    }
  }

  // ---------- Section dwell time + active step ----------
  function watchSections() {
    let current = null;
    setInterval(() => {
      if (document.hidden || !$('#success').hidden) return;
      const mid = window.innerHeight / 2;
      let active = null;
      for (const el of $$('.section:not(.is-hidden)')) {
        const r = el.getBoundingClientRect();
        if (r.top <= mid && r.bottom >= mid) { active = el.dataset.section; break; }
      }
      $$('.step').forEach((s) => s.classList.toggle('active', s.dataset.step === active));
      if (active) metrics.sections[active] = (metrics.sections[active] || 0) + 500;
      if (active && active !== current) {
        const strip = $('#steps');
        const step = $(`.step[data-step="${active}"]`);
        strip.scrollTo({ left: step.offsetLeft - strip.clientWidth / 2 + step.clientWidth / 2, behavior: 'smooth' });
      }
      current = active;
    }, 500);
  }

  // ---------- Init ----------
  async function init() {
    $$('.bars i').forEach((b, i) => b.style.setProperty('--i', i + 1));
    try {
      const res = await fetch('/api/survey');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      survey = await res.json();
    } catch (err) {
      console.error(err);
      $('#sections').innerHTML = '<div class="section"><p>Հարցումը չհաջողվեց բեռնել։ Թարմացրեք էջը։</p></div>';
      return;
    }

    render();
    window.EyeTracking?.setup(startedAt);

    const draft = storage.get();
    if (draft?.answers && Object.keys(draft.answers).length) {
      answers = draft.answers;
      metrics.restoredDraft = true;
      applyAnswers();
      toast('Ձեր նախորդ պատասխանները վերականգնվեցին');
    }
    refresh();

    const form = $('#form');
    form.addEventListener('change', onInput);
    form.addEventListener('input', onInput);
    form.addEventListener('submit', onSubmit);
    $('#restart').addEventListener('click', () => location.reload());
    watchSections();
  }

  init();
})();
