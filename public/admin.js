(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TOKEN_KEY = 'hci-risk-admin-token';

  let token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* ignore */ }

  let survey;
  let responses = [];
  let questions = [];
  let source = 'file';
  let warning = '';

  const fmtDate = (iso) => new Date(iso).toLocaleString('hy-AM', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtMin = (ms) => (ms ? `${(ms / 60000).toFixed(1)} ր` : '—');
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  function optionLabel(q, v) {
    return q.options?.find((o) => o.value === v)?.label ?? v;
  }

  // Human-readable value of one answer (used by the modal and the CSV export).
  function display(q, a) {
    const v = a[q.id];
    if (v === undefined) return '';
    const other = a[`${q.id}_other`] ? ` (${a[`${q.id}_other`]})` : '';
    switch (q.type) {
      case 'single': return optionLabel(q, v) + (v === 'other' ? other : '');
      case 'multi': return v.map((x) => optionLabel(q, x) + (x === 'other' ? other : '')).join('; ');
      case 'consent': return v ? 'Այո' : '';
      default: return String(v);
    }
  }

  // ---------- Data ----------
  async function load() {
    const res = await fetch('/api/responses', { headers: { 'x-admin-token': token } });
    if (res.status === 401) throw new Error('unauthorized');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    survey = data.survey;
    source = data.source;
    warning = data.warning || '';
    responses = data.responses.slice().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    questions = survey.sections.flatMap((s) => s.questions);
  }

  // ---------- Rendering ----------
  function hbars(items, max, suffix = '') {
    if (!items.length) return '<p class="empty">Տվյալներ դեռ չկան</p>';
    return `<div class="hbars">${items.map(([label, val]) => `
      <div class="hbar">
        <span class="hbar-label" title="${esc(label)}">${esc(label)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${max ? (val / max) * 100 : 0}%"></span></span>
        <span class="hbar-val">${typeof val === 'number' && !Number.isInteger(val) ? val.toFixed(2) : val}${suffix}</span>
      </div>`).join('')}</div>`;
  }

  function distribution(qid) {
    const q = questions.find((x) => x.id === qid);
    const counts = new Map(q.options.map((o) => [o.label, 0]));
    for (const r of responses) {
      const v = r.answers[qid];
      for (const x of Array.isArray(v) ? v : v ? [v] : []) {
        const l = optionLabel(q, x);
        counts.set(l, (counts.get(l) || 0) + 1);
      }
    }
    return [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  }

  function render() {
    const n = responses.length;
    const ease = avg(responses.map((r) => r.answers.easeScore).filter(Number.isFinite));
    const dur = median(responses.map((r) => r.meta?.durationMs).filter((x) => x > 0));
    const pros = responses.filter((r) => ['credit', 'risk', 'it'].includes(r.answers.role)).length;
    const gazeRs = responses.filter((r) => r.meta?.gaze?.enabled);

    $('#kpis').innerHTML = `
      <div class="kpi"><span>Պատասխաններ</span><b>${n}</b><small>${n ? `Վերջինը՝ ${fmtDate(responses[0].submittedAt)}` : 'Դեռ չկան'}</small></div>
      <div class="kpi"><span>Հայտի հեշտություն (միջին)</span><b>${ease ? ease.toFixed(1) : '—'}</b><small>սանդղակ 1–10</small></div>
      <div class="kpi"><span>Լրացման տևողություն (մեդիան)</span><b>${dur ? (dur / 60000).toFixed(1) : '—'}</b><small>րոպե</small></div>
      <div class="kpi"><span>Մասնագետներ</span><b>${pros}</b><small>${n ? Math.round((pros / n) * 100) : 0}% մասնակիցներից</small></div>
      <div class="kpi"><span>Eye tracking</span><b>${gazeRs.length}</b><small>${gazeRs.length ? `միջին ճշգրտություն՝ ${Math.round(avg(gazeRs.map((r) => r.meta.gaze.accuracy)))}%` : 'տվյալներ դեռ չկան'}</small></div>`;

    const likertQ = questions.find((q) => q.type === 'likert');
    const likertAvg = likertQ.rows
      .map((row) => [row.label, avg(responses.map((r) => r.answers[likertQ.id]?.[row.id]).filter(Number.isFinite))])
      .filter(([, v]) => v !== null);

    const roles = distribution('role');
    const pains = distribution('painPoints');
    const auth = distribution('authPref');
    const channels = distribution('channels');
    const maxOf = (xs) => Math.max(0, ...xs.map((x) => x[1]));

    $('#panels').innerHTML = `
      <section class="panel"><div class="panel-head"><h2>Մասնակիցների դերեր</h2></div>${hbars(roles, maxOf(roles))}</section>
      <section class="panel"><div class="panel-head"><h2>Վարկի դիմելու ուղիներ</h2></div>${hbars(channels, maxOf(channels))}</section>
      <section class="panel wide"><div class="panel-head"><h2>Ռիսկի ընկալում — միջին համաձայնություն</h2><span class="muted">1–5</span></div>${hbars(likertAvg, 5)}</section>
      <section class="panel"><div class="panel-head"><h2>Հաճախակի խնդիրներ</h2></div>${hbars(pains, maxOf(pains))}</section>
      <section class="panel"><div class="panel-head"><h2>Նախընտրելի նույնականացում</h2></div>${hbars(auth, maxOf(auth))}</section>
      ${gazeRs.length ? attentionPanel(gazeRs) : ''}`;

    $('#count-label').textContent = warning
      ? `${n} գրառում · ⚠ Google Sheets-ը հասանելի չէ, ցուցադրվում են միայն սերվերի ժամանակավոր տվյալները`
      : `${n} գրառում · աղբյուր՝ ${source === 'sheet' ? 'Google Sheets' : 'սերվերի ֆայլ (ժամանակավոր)'}`;
    $('#table').innerHTML = n
      ? `<thead><tr><th>Ամսաթիվ</th><th>Դեր</th><th>Տարիք</th><th>Հեշտություն</th><th>Տևողություն</th><th>Սարք</th><th></th></tr></thead>
        <tbody>${responses.map((r, i) => `
          <tr>
            <td>${esc(fmtDate(r.submittedAt))}</td>
            <td>${esc(display(questions.find((q) => q.id === 'role'), r.answers))}</td>
            <td>${esc(r.answers.age)}</td>
            <td>${r.answers.easeScore ?? '—'}</td>
            <td>${fmtMin(r.meta?.durationMs)}</td>
            <td>${r.meta?.pointer === 'touch' ? 'Հեռախոս / պլանշետ' : 'Համակարգիչ'}</td>
            <td><button class="link-btn" data-view="${i}" type="button">Դիտել</button></td>
          </tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">Պատասխաններ դեռ չկան։ Կիսվեք հարցման հղումով։</td></tr></tbody>';
  }

  // ---------- Eye tracking ----------
  // Every AOI row: questions, with Likert statements nested under their question.
  function aoiList() {
    return questions.flatMap((q) => [
      { id: `q-${q.id}`, label: q.label, nested: false },
      ...(q.rows || []).map((row) => ({ id: `likert-${row.id}`, label: row.label, nested: true })),
    ]);
  }

  function attentionPanel(gazeRs) {
    const rows = aoiList()
      .map((a) => {
        const seen = gazeRs.map((r) => r.meta.gaze.aoi?.[a.id]).filter(Boolean);
        if (!seen.length) return null;
        return {
          ...a,
          dwell: avg(seen.map((s) => s.dwellMs)) / 1000,
          visits: avg(seen.map((s) => s.visits)),
          first: avg(seen.map((s) => s.firstMs)) / 1000,
        };
      })
      .filter(Boolean);
    if (!rows.length) return '';
    const max = Math.max(...rows.map((r) => r.dwell)) || 1;

    return `
      <section class="panel wide">
        <div class="panel-head"><h2>Ուշադրության քարտեզ ըստ հարցերի (eye tracking)</h2><span class="muted">${gazeRs.length} մասնակից · միջին արժեքներ</span></div>
        <div class="table-wrap"><table class="table heat">
          <thead><tr><th>Հարց / պնդում</th><th>Հայացքի ժամանակ (վրկ)</th><th>Մուտքեր</th><th>Առաջին հայացք (վրկ)</th></tr></thead>
          <tbody>${rows.map((r) => {
            const k = r.dwell / max;
            return `<tr class="${r.nested ? 'nested' : ''}">
              <td class="heat-label" title="${esc(r.label)}">${esc(r.label)}</td>
              <td><span class="heat-cell" style="--k:${k.toFixed(3)}" data-dark="${k > 0.55}">${r.dwell.toFixed(1)}</span></td>
              <td>${r.visits.toFixed(1)}</td>
              <td>${r.first.toFixed(1)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </section>`;
  }

  // Gaze points of one response as a heatmap over a wireframe of the page it saw.
  function drawGazeHeatmap(canvas, gaze) {
    // Crop to the survey sections so the page header doesn't leave a large empty area.
    const sectionRects = Object.entries(gaze.aoiRects || {}).filter(([id]) => id.startsWith('section-')).map(([, r]) => r);
    const pad = 24;
    const box = sectionRects.length
      ? {
        x: Math.min(...sectionRects.map((r) => r[0])) - pad,
        y: Math.min(...sectionRects.map((r) => r[1])) - pad,
        r: Math.max(...sectionRects.map((r) => r[0] + r[2])) + pad,
        b: Math.max(...sectionRects.map((r) => r[1] + r[3])) + pad,
      }
      : { x: 0, y: 0, r: gaze.page.w, b: gaze.page.h };
    const width = canvas.parentElement.clientWidth;
    const scale = width / (box.r - box.x);
    const height = Math.round((box.b - box.y) * scale);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.translate(-box.x * scale, -box.y * scale);

    ctx.fillStyle = '#f3f6fb';
    ctx.fillRect(box.x * scale, box.y * scale, width, height);
    for (const [id, [x, y, w, h]] of Object.entries(gaze.aoiRects || {})) {
      const isSection = id.startsWith('section-');
      ctx.fillStyle = isSection ? '#ffffff' : 'rgba(0,0,0,0)';
      ctx.strokeStyle = isSection ? '#cbd5e3' : '#e3e9f2';
      ctx.fillRect(x * scale, y * scale, w * scale, h * scale);
      ctx.strokeRect(x * scale, y * scale, w * scale, h * scale);
    }

    // Accumulate density in an offscreen alpha channel, then colorize it.
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    const radius = Math.max(10, 70 * scale) * dpr;
    for (const [x, y] of gaze.points) {
      const px = (x - box.x) * scale * dpr;
      const py = (y - box.y) * scale * dpr;
      const g = octx.createRadialGradient(px, py, 0, px, py, radius);
      g.addColorStop(0, 'rgba(0,0,0,0.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      octx.fillStyle = g;
      octx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
    }
    const img = octx.getImageData(0, 0, off.width, off.height);
    const stops = [[20, 184, 166], [246, 196, 84], [220, 58, 63]]; // teal → amber → red
    for (let i = 3; i < img.data.length; i += 4) {
      const a = img.data[i] / 255;
      if (!a) continue;
      const t = Math.min(1, a * 1.4);
      const [c0, c1] = t < 0.5 ? [stops[0], stops[1]] : [stops[1], stops[2]];
      const f = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      img.data[i - 3] = c0[0] + (c1[0] - c0[0]) * f;
      img.data[i - 2] = c0[1] + (c1[1] - c0[1]) * f;
      img.data[i - 1] = c0[2] + (c1[2] - c0[2]) * f;
      img.data[i] = Math.min(220, a * 255 * 2.5);
    }
    octx.putImageData(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(off, 0, 0);
  }

  function openModal(r) {
    const rows = [];
    for (const s of survey.sections) {
      for (const q of s.questions) {
        if (r.answers[q.id] === undefined) continue;
        if (q.type === 'likert') {
          const items = q.rows.map((row) => `<li>${esc(row.label)} — <b>${r.answers[q.id][row.id]}</b></li>`).join('');
          rows.push(`<div class="ans"><dt>${esc(q.label)}</dt><dd><ul>${items}</ul></dd></div>`);
        } else {
          rows.push(`<div class="ans"><dt>${esc(q.label)}</dt><dd>${esc(display(q, r.answers))}</dd></div>`);
        }
      }
    }
    rows.push(`<div class="ans"><dt>Փոխազդեցության չափորոշիչներ</dt><dd>Տևողություն՝ ${fmtMin(r.meta?.durationMs)} · Էկրան՝ ${r.meta?.viewport?.w}×${r.meta?.viewport?.h} · Սևագիր վերականգնված՝ ${r.meta?.restoredDraft ? 'այո' : 'ոչ'}</dd></div>`);
    const gaze = r.meta?.gaze;
    const hasHeatmap = gaze?.enabled && gaze.points?.length && gaze.page?.w;
    if (gaze?.enabled) {
      rows.push(`<div class="ans"><dt>Eye tracking</dt><dd>Ճշգրտություն՝ ${gaze.accuracy}% · ${gaze.points.length} հայացքի կետ</dd></div>`);
    }
    $('#modal-title').textContent = fmtDate(r.submittedAt);
    $('#modal-body').innerHTML = `<dl>${rows.join('')}</dl>${hasHeatmap
      ? '<div class="ans"><dt>Հայացքի ջերմային քարտեզ (heatmap)</dt><dd><div class="heatmap-wrap"><canvas id="heatmap"></canvas></div></dd></div>'
      : ''}`;
    $('#modal').showModal();
    if (hasHeatmap) drawGazeHeatmap($('#heatmap'), gaze);
  }

  // ---------- Export ----------
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toCsv() {
    const cols = [
      ['ID', (r) => r.id],
      ['Ամսաթիվ', (r) => r.submittedAt],
    ];
    for (const q of questions) {
      if (q.type === 'likert') {
        q.rows.forEach((row) => cols.push([row.label, (r) => r.answers[q.id]?.[row.id] ?? '']));
      } else {
        cols.push([q.label, (r) => display(q, r.answers)]);
      }
    }
    cols.push(['Տևողություն (վրկ)', (r) => Math.round((r.meta?.durationMs || 0) / 1000)]);
    cols.push(['Սարք', (r) => r.meta?.pointer || '']);
    cols.push(['Էկրանի լայնություն', (r) => r.meta?.viewport?.w || '']);
    for (const s of survey.sections) cols.push([`Ժամանակ բաժնում՝ ${s.short} (վրկ)`, (r) => Math.round((r.meta?.sectionDwellMs?.[s.id] || 0) / 1000)]);
    for (const q of questions) cols.push([`Փոփոխություններ՝ ${q.id}`, (r) => r.meta?.questions?.[q.id]?.changes ?? '']);
    cols.push(['Eye tracking', (r) => (r.meta?.gaze?.enabled ? 'Այո' : 'Ոչ')]);
    cols.push(['Eye tracking ճշգրտություն %', (r) => (r.meta?.gaze?.enabled ? r.meta.gaze.accuracy : '')]);
    for (const a of aoiList()) {
      const g = (r) => r.meta?.gaze?.aoi?.[a.id];
      cols.push([`Հայացք՝ ${a.id} (վրկ)`, (r) => (g(r) ? (g(r).dwellMs / 1000).toFixed(1) : '')]);
      cols.push([`Մուտքեր՝ ${a.id}`, (r) => g(r)?.visits ?? '']);
      cols.push([`Առաջին հայացք՝ ${a.id} (վրկ)`, (r) => (g(r) ? (g(r).firstMs / 1000).toFixed(1) : '')]);
    }

    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map(([h]) => cell(h)).join(',')];
    for (const r of responses) lines.push(cols.map(([, f]) => cell(f(r))).join(','));
    return '﻿' + lines.join('\r\n'); // BOM so Excel shows Armenian correctly
  }

  // ---------- Wiring ----------
  async function enter() {
    try {
      await load();
    } catch (err) {
      if (err.message === 'unauthorized') {
        try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
        $('#login').hidden = false;
        $('#login-error').hidden = !token;
        return;
      }
      alert('Չհաջողվեց բեռնել տվյալները');
      return;
    }
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
    $('#login').hidden = true;
    $('#dashboard').hidden = false;
    $('#actions').hidden = false;
    render();
  }

  $('#login').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('#token').value;
    enter();
  });
  $('#refresh').addEventListener('click', enter);
  $('#logout').addEventListener('click', () => {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    location.reload();
  });
  $('#dl-csv').addEventListener('click', () => download(`responses-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(), 'text/csv;charset=utf-8'));
  $('#dl-json').addEventListener('click', () => download(`responses-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(responses, null, 2), 'application/json'));
  $('#table').addEventListener('click', (e) => {
    const i = e.target.dataset.view;
    if (i !== undefined) openModal(responses[Number(i)]);
  });
  $('#modal-close').addEventListener('click', () => $('#modal').close());
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') e.target.close(); });

  if (token) enter();
  else $('#login').hidden = false;
})();
