// Optional webcam eye tracking (WebGazer.js). The library is loaded only after the participant opts in.
// Gaze is mapped to the page's [data-aoi] elements (sections, questions, Likert rows).
window.EyeTracking = (() => {
  const WEBGAZER_CDN = 'https://cdn.jsdelivr.net/npm/webgazer@3.5.3/dist';
  const CLICKS_PER_DOT = 5;
  const DOTS = [[8, 10], [50, 10], [92, 10], [8, 50], [50, 50], [92, 50], [8, 90], [50, 90], [92, 90]];
  const MEASURE_MS = 3000;
  const POINT_EVERY_MS = 500;
  const MAX_POINTS = 1200;
  const MAX_GAP_MS = 200; // longer gaps between predictions (tab switch, lag) don't count as looking

  const $ = (s) => document.querySelector(s);

  let t0 = Date.now();
  let mode = 'off'; // off | calibrating | measuring | tracking
  let enabled = false;
  let failed = false;
  let accuracy = 0;
  let measured = [];
  const aoi = {};
  const points = [];
  let samples = 0;
  let lastT = 0;
  let lastPointT = 0;
  let prevSet = new Set();

  const supported = () => !!navigator.mediaDevices?.getUserMedia && !matchMedia('(pointer: coarse)').matches;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('WebGazer failed to load'));
      document.head.appendChild(s);
    });
  }

  async function waitFor(fn, timeout = 6000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  // ---------- Overlay UI ----------
  function panel(title, text, actions) {
    $('#calib-dots').innerHTML = '';
    $('#calib-hint').hidden = true;
    $('#calib-panel').hidden = false;
    $('#calib-title').textContent = title;
    $('#calib-text').textContent = text;
    const box = $('#calib-actions');
    box.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn ${a.primary ? 'btn-primary' : 'btn-ghost'}`;
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      box.appendChild(b);
    }
  }

  function hint(text) {
    $('#calib-panel').hidden = true;
    $('#calib-hint').hidden = false;
    $('#calib-hint').textContent = text;
  }

  function openOverlay() {
    $('#calib').hidden = false;
    document.body.classList.add('no-scroll');
    document.addEventListener('keydown', onKey);
  }

  function closeOverlay() {
    $('#calib').hidden = true;
    document.body.classList.remove('no-scroll');
    document.removeEventListener('keydown', onKey);
  }

  const onKey = (e) => { if (e.key === 'Escape') cancel(); };

  // ---------- Flow ----------
  async function enable() {
    failed = false;
    openOverlay();
    panel('Տեսախցիկի միացում…', 'Թույլատրեք տեսախցիկի հասանելիությունը բրաուզերի հարցման պատուհանում։ Առաջին անգամ բեռնումը կարող է տևել մի քանի վայրկյան։', [{ label: 'Չեղարկել', onClick: cancel }]);
    try {
      if (!window.webgazer) await loadScript(`${WEBGAZER_CDN}/webgazer.js`);
      webgazer.params.faceMeshSolutionPath = `${WEBGAZER_CDN}/mediapipe/face_mesh`; // default is relative to our site
      webgazer.saveDataAcrossSessions(false);
      webgazer.showPredictionPoints(false);
      webgazer.setRegression('ridge').setGazeListener(onGaze);
      await webgazer.begin(fail);
    } catch (err) {
      console.error(err);
      fail();
      return;
    }
    if (failed) return;

    const video = await waitFor(() => document.getElementById('webgazerVideoContainer'));
    if (video) $('#calib-video').appendChild(video);
    webgazer.showVideoPreview(true);
    faceCheck();
  }

  function faceCheck() {
    panel(
      'Տեսախցիկի ստուգում',
      'Նստեք ուղիղ՝ էկրանից մոտ 50–70 սմ հեռավորության վրա։ Դեմքը պետք է լինի կանաչ շրջանակի մեջ։ Լավ լուսավորությունը բարձրացնում է ճշգրտությունը։',
      [
        { label: 'Սկսել չափաճշտումը', primary: true, onClick: calibrate },
        { label: 'Չեղարկել', onClick: cancel },
      ],
    );
    $('#calib-video').hidden = false;
  }

  async function calibrate() {
    await webgazer.clearData();
    mode = 'calibrating';
    $('#calib-video').hidden = true;
    hint(`Նայեք յուրաքանչյուր կետին և սեղմեք դրա վրա ${CLICKS_PER_DOT} անգամ`);

    const wrap = $('#calib-dots');
    wrap.innerHTML = '';
    let remaining = DOTS.length;
    for (const [x, y] of DOTS) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'calib-dot';
      dot.style.left = `${x}%`;
      dot.style.top = `${y}%`;
      dot.setAttribute('aria-label', 'Չափաճշտման կետ');
      let clicks = 0;
      dot.addEventListener('click', () => {
        clicks++;
        dot.style.setProperty('--p', clicks / CLICKS_PER_DOT);
        if (clicks < CLICKS_PER_DOT) return;
        dot.classList.add('done');
        dot.disabled = true;
        if (--remaining === 0) setTimeout(measure, 400);
      });
      wrap.appendChild(dot);
    }
  }

  function measure() {
    hint('Մի շարժեք մկնիկը և նայեք կենտրոնի կետին 3 վայրկյան');
    $('#calib-dots').innerHTML = '<span class="calib-target"></span>';
    measured = [];
    mode = 'measuring';
    setTimeout(() => {
      mode = 'off';
      accuracy = computeAccuracy();
      result();
    }, MEASURE_MS);
  }

  function computeAccuracy() {
    if (!measured.length) return 0;
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const half = innerHeight / 2;
    const scores = measured.map((p) => Math.max(0, 100 - (Math.hypot(p.x - cx, p.y - cy) / half) * 100));
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  function result() {
    const text =
      accuracy >= 60 ? 'Լավ արդյունք։ Կարող եք սկսել հարցումը։'
        : accuracy >= 35 ? 'Ընդունելի արդյունք։ Ավելի լավ լուսավորությամբ կարող եք կրկնել։'
          : 'Ճշգրտությունը ցածր է։ Խորհուրդ ենք տալիս կրկնել՝ դեմքը լավ լուսավորելով և գլուխը չշարժելով։';
    panel(`Ճշգրտություն՝ ${accuracy}%`, text, [
      { label: 'Սկսել հարցումը', primary: true, onClick: startTracking },
      { label: 'Կրկնել', onClick: faceCheck },
    ]);
  }

  function startTracking() {
    closeOverlay();
    webgazer.showVideoPreview(false);
    enabled = true;
    mode = 'tracking';
    lastT = 0;
    $('#et-card').classList.add('is-active');
    $('#et-status-acc').textContent = `${accuracy}%`;
    $('#et-status').hidden = false;
    $('#sec-profile')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function release() {
    try { webgazer.stopVideo(); } catch { /* not started */ }
    try { webgazer.end(); } catch { /* not started */ }
  }

  function fail() {
    if (failed) return;
    failed = true;
    mode = 'off';
    release();
    panel('Տեսախցիկը հասանելի չէ', 'Չհաջողվեց միացնել տեսախցիկը։ Ստուգեք բրաուզերի թույլտվությունները կամ շարունակեք հարցումն առանց eye tracking-ի։', [
      { label: 'Շարունակել առանց դրա', primary: true, onClick: () => { closeOverlay(); skip(); } },
    ]);
  }

  function cancel() {
    mode = 'off';
    release();
    closeOverlay();
  }

  function skip() {
    $('#et-card').classList.add('is-skipped');
  }

  function stop() {
    if (mode === 'off' && !enabled) return;
    mode = 'off';
    release();
    $('#et-status').hidden = true;
    $('#et-card').classList.remove('is-active');
    $('#et-card').classList.add('is-stopped');
  }

  // ---------- Gaze → AOI ----------
  function onGaze(p) {
    if (!p) return;
    if (mode === 'measuring') measured.push(p);
    else if (mode === 'tracking') sample(p.x, p.y);
  }

  function sample(x, y) {
    const now = performance.now();
    const dt = lastT && now - lastT <= MAX_GAP_MS ? now - lastT : 0;
    lastT = now;
    if (document.hidden || x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
      prevSet = new Set();
      return;
    }

    const t = Date.now() - t0;
    const set = new Set();
    for (let n = document.elementFromPoint(x, y)?.closest('[data-aoi]'); n; n = n.parentElement?.closest('[data-aoi]')) {
      set.add(n.dataset.aoi);
    }
    for (const id of set) {
      const a = (aoi[id] ||= { dwellMs: 0, firstMs: t, visits: 0 });
      a.dwellMs += dt;
      if (!prevSet.has(id)) a.visits++;
    }
    prevSet = set;
    samples++;

    if (now - lastPointT >= POINT_EVERY_MS && points.length < MAX_POINTS) {
      points.push([Math.round(x + scrollX), Math.round(y + scrollY), Math.round(t / 100) / 10]);
      lastPointT = now;
    }
  }

  // Page position of every AOI at submit time, so gaze points can be drawn over a page wireframe.
  function aoiRects() {
    const out = {};
    document.querySelectorAll('[data-aoi]').forEach((el) => {
      if (!el.offsetParent) return;
      const r = el.getBoundingClientRect();
      out[el.dataset.aoi] = [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
    });
    return out;
  }

  function getData() {
    if (!enabled) return { enabled: false };
    const doc = document.documentElement;
    return {
      enabled: true,
      accuracy,
      samples,
      aoi: Object.fromEntries(Object.entries(aoi).map(([id, a]) => [id, { ...a, dwellMs: Math.round(a.dwellMs) }])),
      points,
      aoiRects: aoiRects(),
      page: { w: doc.scrollWidth, h: doc.scrollHeight },
    };
  }

  function setup(startedAt) {
    t0 = startedAt;
    if (!supported()) return;
    $('#et-card').hidden = false;
    $('#et-start').addEventListener('click', enable);
    $('#et-skip').addEventListener('click', skip);
    $('#et-stop').addEventListener('click', stop);
  }

  return { setup, getData, stop };
})();
