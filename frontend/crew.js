'use strict';
// Crew: profile set-up, shared goals, challenges, feed, the crew chart and the
// invite-code sign-up form. Loaded after app.js and uses its helpers
// ($, api, toast, celebrate, units, dates...).
// Friends only ever get aggregates from the API (see docs/SOCIAL_DESIGN.md).

const Crew = (() => {
  const NAVY = '#0F1024';
  let profile = null;  // GET /me
  let crew = null;     // GET /crew
  let tab = 'goals';
  let shown = null;    // memberIds visible on the crew chart
  let highlight = null;

  const membersById = () => new Map((crew?.members || []).map(m => [m.memberId, m]));
  const unitW = v => kgTo(Number(v), getUnit());
  const plural = (n, word) => `${n} ${n === 1 ? word : word === 'person' ? 'people' : `${word}s`}`;
  // Labels made on the server use kg; show them in the viewer's unit.
  const inUnit = label => getUnit() === 'kg' ? label
    : String(label).replace(/([\d,.]+) kg/g, (_, n) => `${fmt(kgTo(parseFloat(n.replace(/,/g, '')), 'lb'))} lb`);

  // ------------------------------------------------------------ shapes & avatars
  // Every person has a colour AND a marker shape, so nobody is told apart by
  // colour alone.
  function shapePath(shape, x, y, r) {
    const p = pts => 'M' + pts.map(([a, b]) => `${(x + a * r).toFixed(1)},${(y + b * r).toFixed(1)}`).join('L') + 'Z';
    switch (shape) {
      case 'square': return p([[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]]);
      case 'triangle': return p([[0, -1.15], [1.1, 0.85], [-1.1, 0.85]]);
      case 'triangle-down': return p([[-1.1, -0.85], [1.1, -0.85], [0, 1.15]]);
      case 'diamond': return p([[0, -1.25], [1.25, 0], [0, 1.25], [-1.25, 0]]);
      case 'star': return p(Array.from({ length: 10 }, (_, i) => {
        const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 0.5 : 1.25;
        return [Math.cos(a) * rr, Math.sin(a) * rr];
      }));
      case 'plus': return p([[-0.38, -1.1], [0.38, -1.1], [0.38, -0.38], [1.1, -0.38], [1.1, 0.38], [0.38, 0.38],
        [0.38, 1.1], [-0.38, 1.1], [-0.38, 0.38], [-1.1, 0.38], [-1.1, -0.38], [-0.38, -0.38]]);
      case 'cross': return p([[-0.8, -1.15], [0, -0.35], [0.8, -1.15], [1.15, -0.8], [0.35, 0], [1.15, 0.8], [0.8, 1.15],
        [0, 0.35], [-0.8, 1.15], [-1.15, 0.8], [-0.35, 0], [-1.15, -0.8]]);
      default: return `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
    }
  }
  function avatar(m, size = 28) {
    const c = size / 2;
    return `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle cx="${c}" cy="${c}" r="${c}" fill="${NAVY}" stroke="${m.colour}" stroke-width="2"/>
      <path d="${shapePath(m.shape, c, c, size * 0.22)}" fill="${m.colour}" stroke="none"/></svg>`;
  }
  function ring(pct, colour, size = 60) {
    const r = (size - 10) / 2, c = 2 * Math.PI * r, dash = (Math.max(0, Math.min(100, pct)) / 100) * c;
    return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${Math.round(pct)}% done">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${NAVY}" stroke="none"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="6"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${colour}" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" class="ring-t">${Math.round(pct)}%</text></svg>`;
  }

  // ------------------------------------------------------------ profile
  async function onSignedIn() {
    try {
      profile = await api('GET', '/me');
    } catch (e) {
      if (e.message === 'No profile yet') openOnboarding();
      return; // crew features stay quiet if the API isn't there
    }
    checkGoals();
  }
  function openOnboarding() {
    $('#onboard-error').hidden = true;
    $('#onboard').showModal();
    $('#onboard-name').focus();
  }
  $('#onboard-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      profile = await api('PUT', '/me', { displayName: $('#onboard-name').value });
      profile = await api('GET', '/me');
      $('#onboard').close();
      toast(`Welcome, ${profile.displayName}! 👋`);
    } catch (e) {
      $('#onboard-error').textContent = e.message;
      $('#onboard-error').hidden = false;
    }
  });
  // first login: don't let the name sheet be dismissed with Escape
  $('#onboard').addEventListener('cancel', e => e.preventDefault());

  function renderSettings() {
    const box = $('#crew-settings');
    box.hidden = !profile;
    if (!profile) return;
    if (document.activeElement !== $('#set-name')) $('#set-name').value = profile.displayName;
    $('#set-sharing').checked = profile.sharing;
    // once all 8 colours are in use, anyone may pick any (shape + name still tell people apart)
    const anyFree = profile.palette.some(p => !p.taken);
    $('#set-colours').innerHTML = profile.palette.map(p => {
      const mine = p.colour === profile.colour;
      p = { ...p, taken: p.taken && anyFree };
      return `<button role="radio" aria-checked="${mine}" aria-label="Colour ${p.colour}${p.taken && !mine ? ' (taken)' : ''}"
        class="swatch" style="--sw:${p.colour}" data-colour="${p.colour}" ${p.taken && !mine ? 'disabled' : ''}>
        ${mine ? avatar({ colour: p.colour, shape: profile.shape }, 30) : ''}</button>`;
    }).join('');
    $$('#set-colours .swatch').forEach(b => b.addEventListener('click', () => saveProfile({ colour: b.dataset.colour })));
  }
  async function saveProfile(change) {
    try {
      await api('PUT', '/me', change);
      profile = await api('GET', '/me');
      crew = null;
      renderSettings();
      toast('Saved');
    } catch (e) { toast(e.message); }
  }
  $('#set-name-save').addEventListener('click', () => saveProfile({ displayName: $('#set-name').value }));
  $('#set-sharing').addEventListener('change', e => saveProfile({ sharing: e.target.checked }));

  // ------------------------------------------------------------ goals
  const celebrated = () => { try { return new Set(JSON.parse(localStorage.getItem('wt.celebrated') || '[]')); } catch { return new Set(); } };
  async function checkGoals() {
    if (!profile) return;
    let goals;
    try { goals = (await api('GET', '/goals')).items; } catch { return; }
    const seen = celebrated();
    const fresh = goals.filter(g => g.status === 'completed' && !seen.has(g.id)
      && Date.now() - Date.parse(g.completedAt) < 3 * 864e5);
    goals.filter(g => g.status === 'completed').forEach(g => seen.add(g.id));
    localStorage.setItem('wt.celebrated', JSON.stringify([...seen]));
    if (fresh.length) {
      celebrate();
      toast(`🎉 Goal reached: ${inUnit(fresh.map(g => g.label).join(' · '))}`, 4500, 'pr');
    }
    return goals;
  }

  function goalText(g) {
    const u = getUnit();
    if (g.type === 'perWeek') return { title: `${fmt(g.target)}x a week`, detail: `${fmt(g.value)} of ${fmt(g.target)} this week` };
    if (g.type === 'volume') return { title: `${fmt(unitW(g.target))} ${u} total volume`, detail: `${fmt(unitW(g.value))} ${u} so far` };
    const what = g.type === 'e1rm' ? 'est. 1RM ' : '';
    return { title: `${g.exercise} ${what}${fmt(unitW(g.target))} ${u}`, detail: `Best so far ${fmt(unitW(g.value))} ${u}` };
  }

  function goalItem(g, m, mine) {
    const t = goalText(g);
    const done = g.status === 'completed';
    return `<li class="card goal ${done ? 'done' : ''}">
      ${ring(done ? 100 : g.pct, m.colour)}
      <div class="goal-body"><strong>${esc(t.title)}</strong>
        <span>${done ? 'Goal reached 🎉' : esc(t.detail)}${g.deadline ? ` · by ${shortDate(g.deadline)}` : ''}</span></div>
      ${mine ? `<button class="icon-btn small" data-del-goal="${g.id}" aria-label="Delete goal ${esc(t.title)}">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`
        : `<button class="cheer" data-cheer="${m.memberId}" data-ref="${g.goalId}" data-label="${esc(t.title)}">👏 Cheer</button>`}
    </li>`;
  }

  async function renderGoals() {
    const me = crew.me;
    const own = (await checkGoals()) || [];
    $('#my-goals').innerHTML = own.length
      ? own.map(g => goalItem({ ...g, pct: g.progress.pct, value: g.progress.value, target: g.progress.target }, me, true)).join('')
      : '<li class="empty-card">Set a goal and the crew can follow along with you.</li>';
    const byMember = new Map();
    for (const g of crew.goals) if (g.memberId !== me.memberId) {
      if (!byMember.has(g.memberId)) byMember.set(g.memberId, []);
      byMember.get(g.memberId).push(g);
    }
    const ms = membersById();
    $('#crew-goal-list').innerHTML = byMember.size
      ? [...byMember].map(([id, gs]) => {
        const m = ms.get(id);
        return `<li class="member-goals"><div class="who">${avatar(m)}<strong>${esc(m.displayName)}</strong></div>
          <ul class="goal-list">${gs.map(g => goalItem({ ...g, pct: g.progressPct }, m, false)).join('')}</ul></li>`;
      }).join('')
      : '<li class="empty-card">When friends set goals, you’ll see them here.</li>';
  }

  // ------------------------------------------------------------ challenges
  function score(c, s) {
    if (s == null) return 'Warming up';
    if (c.metric === 'e1rmPct') return `${s > 0 ? '+' : ''}${fmt(s)}%`;
    if (c.metric === 'workouts') return plural(s, 'session');
    if (c.metric === 'volume') return `${fmt(Math.round(unitW(s)))} ${getUnit()}`;
    return plural(s, 'week');
  }
  function compDetail(c) {
    if (c.metric === 'e1rmPct') return `${c.exercise}: improvement from your own starting point`;
    if (c.metric === 'streak') return `Weeks in a row with ${fmt(c.weeklyTarget)}+ workouts`;
    return c.metric === 'volume' ? 'Total weight moved' : 'Workouts completed';
  }
  function compCard(c) {
    const meId = crew.me.memberId;
    const status = c.status === 'live' ? '<span class="badge live">Live</span>'
      : c.status === 'upcoming' ? `<span class="badge">Starts ${shortDate(c.startDate)}</span>` : '<span class="badge">Finished</span>';
    const ranked = c.standings.filter(s => s.rank != null);
    const podium = ranked.slice(0, 3);
    const col = i => [2, 1, 3][i]; // 1st in the middle, 2nd left, 3rd right
    const rest = c.standings.filter(s => !podium.includes(s));
    const canJoin = !c.joined && c.status !== 'finished' && crew.sharing;
    const cheer = s => c.status !== 'finished' && !s.isMe
      ? `<button class="cheer small" data-cheer="${s.memberId}" data-ref="${c.id}" data-label="${esc(c.name)}" aria-label="Cheer ${esc(s.displayName)}">👏</button>` : '';
    return `<article class="card comp">
      <div class="comp-top"><span class="eyebrow-sm">${esc(c.title)}</span>${status}</div>
      <h3>${esc(c.name)}</h3>
      <p class="muted small">${esc(compDetail(c))} · ${shortDate(c.startDate)} – ${shortDate(c.endDate)}</p>
      ${podium.length ? `<div class="podium">${podium.map((s, i) => `
        <div class="step p${i + 1} ${s.memberId === meId ? 'me' : ''}" style="grid-column:${col(i)};grid-row:1">
          ${avatar(s, 40)}<strong>${esc(s.displayName)}</strong><span>${score(c, s.score)}</span>
          <div class="block" style="--pc:${s.colour}">${s.rank}</div>${cheer(s)}
        </div>`).join('')}</div>` : '<p class="muted small">Everyone\u2019s warming up. Every session counts!</p>'}
      ${rest.length ? `<ol class="standings">${rest.map(s => `
        <li>${s.rank != null ? `<span class="rank">${s.rank}</span>` : '<span class="rank"></span>'}${avatar(s)}
          <span class="name">${esc(s.displayName)}</span><span class="score">${score(c, s.score)}</span>${cheer(s)}</li>`).join('')}</ol>` : ''}
      ${canJoin ? `<button class="btn primary" data-join="${c.id}">Join in</button>` : ''}
      ${c.joined && c.status !== 'finished' ? '<p class="joined">You’re in. Good luck! 💪</p>' : ''}
    </article>`;
  }
  async function renderComps() {
    const { items } = await api('GET', '/competitions');
    const current = items.filter(c => c.status !== 'finished');
    const past = items.filter(c => c.status === 'finished');
    $('#comp-list').innerHTML = current.length ? current.map(compCard).join('')
      : '<p class="empty-card">No challenges running. Start one and invite the crew along.</p>';
    $('#comp-past-wrap').hidden = !past.length;
    $('#comp-past').innerHTML = past.map(compCard).join('');
    $$('[data-join]').forEach(b => b.addEventListener('click', async () => {
      try { await api('POST', `/competitions/${b.dataset.join}/join`); toast('You’re in!'); renderComps(); }
      catch (e) { toast(e.message); }
    }));
  }

  // ------------------------------------------------------------ feed
  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  function renderFeed() {
    const ms = membersById();
    const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
    const name = id => (ms.get(id)?.isMe ? 'you' : esc(ms.get(id)?.displayName || 'Someone'));
    const text = f => ({
      goalDone: `${cap(name(f.actor))} reached a goal: <b>${esc(inUnit(f.label))}</b> 🎉`,
      cheer: `${cap(name(f.actor))} cheered ${name(f.subject)} on <b>${esc(inUnit(f.label))}</b> 👏`,
      compCreated: `${cap(name(f.actor))} started a challenge: <b>${esc(f.label)}</b>`,
      compJoined: `${cap(name(f.actor))} joined <b>${esc(f.label)}</b>`,
      compFinished: `<b>${esc(f.label)}</b> has finished. Well done, everyone!`,
    }[f.kind] || '');
    $('#feed-list').innerHTML = crew.feed.length ? crew.feed.map(f => `
      <li class="feed-item">${ms.get(f.actor) ? avatar(ms.get(f.actor), 32) : '<span class="avatar-gap"></span>'}
        <p>${text(f)}<span class="when">${ago(f.createdAt)}</span></p></li>`).join('')
      : '<li class="empty-card">Nothing yet. Reach a goal or cheer someone on to get things going.</li>';
  }

  // ------------------------------------------------------------ screen
  async function render() {
    $('#crew-error').hidden = true;
    try {
      if (!profile) profile = await api('GET', '/me');
      crew = await api('GET', '/crew');
    } catch (e) {
      $('#crew-error').textContent = e.message === 'No profile yet' ? 'Pick a display name first.' : 'The crew couldn’t be loaded just now.';
      $('#crew-error').hidden = false;
      if (e.message === 'No profile yet') openOnboarding();
      return;
    }
    $('#crew-private').hidden = crew.sharing;
    $('#crew-sub').textContent = `${plural(crew.members.length, 'person')} training alongside each other`;
    $$('#crew-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.crewTab === tab)));
    $('#crew-goals').hidden = tab !== 'goals';
    $('#crew-comps').hidden = tab !== 'comps';
    $('#crew-feed').hidden = tab !== 'feed';
    try {
      if (tab === 'goals') await renderGoals();
      if (tab === 'comps') await renderComps();
      if (tab === 'feed') renderFeed();
    } catch (e) { toast(e.message); }
  }
  $$('#crew-tabs button').forEach(b => b.addEventListener('click', () => { tab = b.dataset.crewTab; render(); }));

  // cheers (delegated: goal cards, podium and standings)
  $('#view-crew').addEventListener('click', async e => {
    const b = e.target.closest('[data-cheer]');
    if (b) {
      b.disabled = true;
      try {
        await api('POST', '/crew/cheers', { memberId: b.dataset.cheer, ref: b.dataset.ref, label: b.dataset.label });
        b.textContent = b.classList.contains('small') ? '✓' : 'Cheered ✓';
        b.classList.add('sent');
      } catch (err) { b.disabled = false; toast(err.message); }
      return;
    }
    const del = e.target.closest('[data-del-goal]');
    if (del && confirm('Delete this goal?')) {
      try { await api('DELETE', `/goals/${del.dataset.delGoal}`); render(); } catch (err) { toast(err.message); }
    }
  });

  // new goal
  function syncGoalForm() {
    const t = $('#goal-type').value, u = getUnit();
    $('#goal-ex-wrap').hidden = !(t === 'weight' || t === 'e1rm');
    $('#goal-range').hidden = t !== 'volume';
    $('#goal-target-label').textContent = t === 'perWeek' ? 'Workouts per week' : `Target (${u})`;
  }
  $('#goal-type').addEventListener('change', syncGoalForm);
  $('#goal-new').addEventListener('click', () => {
    $('#goal-form').reset();
    $('#goal-start').value = today();
    $('#goal-end').value = isoDate(new Date(Date.now() + 27 * 864e5));
    $('#goal-error').hidden = true;
    syncGoalForm();
    $('#goal-dialog').showModal();
  });
  $('#goal-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const t = $('#goal-type').value, raw = Number($('#goal-target').value.replace(',', '.'));
    const body = { type: t, target: t === 'perWeek' ? raw : Math.round(toKg(raw, getUnit()) * 100) / 100 };
    if (t === 'weight' || t === 'e1rm') body.exercise = $('#goal-ex').value;
    if (t === 'volume') { body.startDate = $('#goal-start').value; body.endDate = $('#goal-end').value; }
    if ($('#goal-deadline').value) body.deadline = $('#goal-deadline').value;
    try {
      await api('POST', '/goals', body);
      $('#goal-dialog').close();
      toast('Goal set. You’ve got this! 💪');
      render();
    } catch (e) { $('#goal-error').textContent = e.message; $('#goal-error').hidden = false; }
  });

  // new challenge
  function syncCompForm() {
    const m = $('#comp-metric').value;
    $('#comp-ex-wrap').hidden = m !== 'e1rmPct';
    $('#comp-weekly-wrap').hidden = m !== 'streak';
  }
  $('#comp-metric').addEventListener('change', syncCompForm);
  $('#comp-new').addEventListener('click', () => {
    $('#comp-form').reset();
    $('#comp-start').value = today();
    $('#comp-end').value = isoDate(new Date(Date.now() + 27 * 864e5));
    $('#comp-error').hidden = true;
    syncCompForm();
    $('#comp-dialog').showModal();
  });
  $('#comp-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const m = $('#comp-metric').value;
    const body = { name: $('#comp-name').value, metric: m, startDate: $('#comp-start').value, endDate: $('#comp-end').value };
    if (m === 'e1rmPct') body.exercise = $('#comp-ex').value;
    if (m === 'streak') body.weeklyTarget = Number($('#comp-weekly').value);
    try {
      await api('POST', '/competitions', body);
      $('#comp-dialog').close();
      toast('Challenge created. Let the crew know! 🙌');
      tab = 'comps';
      render();
    } catch (e) { $('#comp-error').textContent = e.message; $('#comp-error').hidden = false; }
  });

  // ------------------------------------------------------------ crew chart
  async function renderChart(ownNames, crewMetric) {
    const el = $('#chart');
    const card = el.closest('.chart-card');
    card.classList.add('crew-mode');
    try {
      if (!crew) crew = await api('GET', '/crew');
    } catch (e) {
      $('#crew-chips').innerHTML = '';
      el.innerHTML = `<p class="empty">${e.message === 'No profile yet' ? 'Pick a display name to see the crew.' : 'The crew couldn’t be loaded just now.'}</p>`;
      if (e.message === 'No profile yet') openOnboarding();
      return;
    }
    // exercises: yours plus the crew's
    const sel = $('#prog-exercise');
    const prev = sel.value;
    const names = new Map([...ownNames].map(([k, c]) => [k, c.name]));
    for (const n of crew.exerciseNames) if (!names.has(norm(n))) names.set(norm(n), n);
    sel.innerHTML = [...names].sort((a, b) => a[1].localeCompare(b[1])).map(([k, n]) => `<option value="${esc(k)}">${esc(n)}</option>`).join('');
    if (names.has(prev)) sel.value = prev;
    if (!sel.value) { el.innerHTML = '<p class="empty">Once anyone logs a workout, it shows up here.</p>'; return; }

    const apiMetric = crewMetric === 'pct' ? 'e1rm' : crewMetric;
    let data;
    try {
      data = await api('GET', `/crew/series?exercise=${encodeURIComponent(names.get(sel.value))}&metric=${apiMetric}`);
    } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    if (currentView !== 'progress' || progMode !== 'crew') return;
    const series = data.series;
    const ids = series.map(s => s.memberId);
    if (!shown || ![...shown].some(id => ids.includes(id))) {
      const me = series.find(s => s.isMe);
      shown = new Set([...(me ? [me.memberId] : []), ...series.filter(s => !s.isMe).slice(0, me ? 3 : 4).map(s => s.memberId)]);
    }
    if (highlight && !ids.includes(highlight)) highlight = null;

    $('#crew-chips').innerHTML = series.map(s => `
      <button class="chip" aria-pressed="${shown.has(s.memberId)}" data-member="${s.memberId}" style="--pc:${s.colour}">
        ${avatar(s, 22)}${esc(s.isMe ? `${s.displayName} (you)` : s.displayName)}</button>`).join('');
    $$('#crew-chips .chip').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.member;
      if (shown.has(id)) { shown.delete(id); if (highlight === id) highlight = null; }
      else { shown.add(id); highlight = id; }
      renderProgress();
    }));

    const u = getUnit();
    const caption = { pct: '% change in estimated 1RM since each person’s first session', e1rm: `Estimated 1RM, ${u}`,
      volume: `Total volume, ${u}`, top: `Top set, ${u}` }[crewMetric];
    $('#chart-caption').textContent = `${caption} · tap a line or name to focus`;
    const visible = series.filter(s => shown.has(s.memberId)).map(s => {
      const first = s.points[0].value;
      return { ...s, points: s.points.map(p => ({ date: p.date,
        v: crewMetric === 'pct' ? (p.value / first - 1) * 100 : kgTo(p.value, u) })) };
    });
    if (!visible.length) { el.innerHTML = '<p class="empty">Pick someone above to show their line.</p>'; return; }
    drawCrewChart(el, visible, crewMetric === 'pct' ? v => `${v > 0 ? '+' : ''}${fmt(v)}%` : v => fmt(v), crewMetric === 'pct' ? '' : u);
  }

  function drawCrewChart(el, series, fmtV, unit) {
    const tip = $('#chart-tip');
    tip.hidden = true;
    const W = el.clientWidth || 340, H = el.clientHeight || 280;
    const M = { l: 44, r: 92, t: 22, b: 28 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const ts = d => parseDate(d).getTime();
    const all = series.flatMap(s => s.points);
    let x0 = Math.min(...all.map(p => ts(p.date))), x1 = Math.max(...all.map(p => ts(p.date)));
    if (x0 === x1) { x0 -= 3 * 864e5; x1 += 3 * 864e5; }
    const vals = all.map(p => p.v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const padV = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
    const yt = niceTicks(unit ? Math.max(0, lo - padV) : lo - padV, hi + padV);
    const y0 = yt[0], y1 = yt[yt.length - 1];
    const X = t => M.l + ((t - x0) / (x1 - x0)) * iw;
    const Y = v => M.t + ih - ((v - y0) / (y1 - y0)) * ih;
    const sameYear = new Date(x0).getFullYear() === new Date(x1).getFullYear();
    const xLabel = t => new Date(t).toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { month: 'short', year: '2-digit' });

    // me last so my line is on top
    const ordered = [...series].sort((a, b) => (a.isMe === b.isMe ? 0 : a.isMe ? 1 : -1));
    // direct labels in a column at the right, nudged apart so they never overlap
    const labels = ordered.map(s => ({ s, y: Y(s.points[s.points.length - 1].v) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 16);
    const overflow = labels.length ? labels[labels.length - 1].y - (M.t + ih) : 0;
    if (overflow > 0) labels.forEach(l => { l.y = Math.max(M.t, l.y - overflow); });
    const labelY = new Map(labels.map(l => [l.s.memberId, l.y]));

    const line = s => s.points.map((p, i) => `${i ? 'L' : 'M'}${X(ts(p.date)).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const op = s => (highlight ? (s.memberId === highlight ? 1 : 0.18) : s.isMe ? 1 : 0.85);
    const lx = M.l + iw + 10;
    const short = n => (n.length > 10 ? `${n.slice(0, 9)}…` : n);

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Crew chart: ${series.map(s => s.displayName).join(', ')}">
      ${yt.map(v => `<line class="grid" x1="${M.l}" x2="${M.l + iw}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}
      ${unit ? '' : `<line class="zero" x1="${M.l}" x2="${M.l + iw}" y1="${Y(0)}" y2="${Y(0)}"/>`}
      ${yt.map(v => `<text class="axis" x="${M.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtV(v)}</text>`).join('')}
      <text class="axis" x="${M.l}" y="${H - 6}" text-anchor="start">${xLabel(x0)}</text>
      <text class="axis" x="${M.l + iw}" y="${H - 6}" text-anchor="end">${xLabel(x1)}</text>
      ${ordered.map(s => {
        const last = s.points[s.points.length - 1];
        const lxp = X(ts(last.date)), lyp = Y(last.v), ly = labelY.get(s.memberId);
        const many = s.points.length > 30;
        return `<g class="person" data-member="${s.memberId}" opacity="${op(s)}">
          <path class="pline" d="${line(s)}" stroke="${s.colour}" stroke-width="${s.isMe ? 3 : 2}"/>
          <path class="hit" d="${line(s)}"/>
          ${s.points.map((p, i) => (!many || i === s.points.length - 1)
            ? `<path d="${shapePath(s.shape, X(ts(p.date)), Y(p.v), s.isMe ? 5 : 4.2)}" fill="${s.colour}" stroke="${NAVY}" stroke-width="1.5"/>` : '').join('')}
          <line class="lead" x1="${lxp + 6}" y1="${lyp}" x2="${lx - 2}" y2="${ly}" stroke="${s.colour}"/>
          <path d="${shapePath(s.shape, lx + 6, ly, 4.5)}" fill="${s.colour}" stroke="${NAVY}" stroke-width="1"/>
          <text class="plabel" x="${lx + 15}" y="${ly + 4}" fill="${s.colour}">${esc(short(s.displayName))}</text>
        </g>`;
      }).join('')}
      <line class="cross" y1="${M.t}" y2="${M.t + ih}" visibility="hidden"/>
      <rect class="tiphit" x="${M.l}" y="0" width="${iw}" height="${H}" fill="transparent"/>
    </svg>`;

    const svg = $('svg', el), cross = $('.cross', svg);
    $$('.person', svg).forEach(g => g.addEventListener('click', ev => {
      ev.stopPropagation();
      highlight = highlight === g.dataset.member ? null : g.dataset.member;
      drawCrewChart(el, series, fmtV, unit);
    }));
    const dates = [...new Set(all.map(p => p.date))].sort();
    const move = ev => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const date = dates.reduce((b, d) => (Math.abs(X(ts(d)) - px) < Math.abs(X(ts(b)) - px) ? d : b), dates[0]);
      const cx = X(ts(date));
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      // everyone's latest value as of that date, in their colour
      const rows = ordered.slice().reverse().map(s => {
        const p = [...s.points].reverse().find(q => q.date <= date);
        return p ? `<span class="trow" style="color:${s.colour}"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="${shapePath(s.shape, 6, 6, 4)}" fill="${s.colour}"/></svg>${esc(s.displayName)} <b>${fmtV(p.v)}${unit ? ` ${unit}` : ''}</b>${p.date === date ? '' : ' <i>earlier</i>'}</span>` : '';
      }).join('');
      tip.innerHTML = `<span class="tdate">${shortDate(date)}</span>${rows}`;
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max((cx / W) * r.width, 90), r.width - 90)}px`;
    };
    $('.tiphit', svg).addEventListener('pointermove', move);
    $('.tiphit', svg).addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  }

  // ------------------------------------------------------------ invite sign-up (landing page)
  // Cognito's public SignUp/ConfirmSignUp API (no secret: public client). The
  // invite code travels as ValidationData and is checked by the Pre sign-up
  // trigger; nothing about it is stored here.
  async function cognito(action, body) {
    const res = await fetch(`https://cognito-idp.${CFG.region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` },
      body: JSON.stringify({ ClientId: CFG.clientId, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const type = String(data.__type || '').split('#').pop();
      const msg = String(data.message || '');
      throw new Error({
        UsernameExistsException: 'There’s already an account with that email. Try signing in.',
        InvalidPasswordException: 'That password is too weak. Use 12+ characters with upper and lower case letters and a number.',
        CodeMismatchException: 'That code doesn’t match. Check the email and try again.',
        ExpiredCodeException: 'That code has expired. Send a new one below.',
        UserLambdaValidationException: msg.replace(/^PreSignUp failed with error /, '').replace(/\.+$/, '.') || 'That invite code didn’t work.',
        TooManyRequestsException: 'Too many attempts. Wait a minute and try again.',
        LimitExceededException: 'Too many attempts. Wait a few minutes and try again.',
      }[type] || msg || 'Something went wrong. Please try again.');
    }
    return data;
  }
  let pendingEmail = '';
  function openInvite() {
    if (!CFG.clientId || !CFG.region) { toast('Sign-up isn’t configured on this copy of the site.'); return; }
    $('#invite-form').hidden = false;
    $('#confirm-form').hidden = true;
    $('#invite-done').hidden = true;
    $('#inv-error').hidden = true;
    $('#invite').showModal();
  }
  $$('[data-open-invite]').forEach(b => b.addEventListener('click', openInvite));
  $('#invite-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const err = $('#inv-error');
    err.hidden = true;
    $('#inv-submit').disabled = true;
    pendingEmail = $('#inv-email').value.trim().toLowerCase();
    try {
      await cognito('SignUp', {
        Username: pendingEmail, Password: $('#inv-pass').value,
        UserAttributes: [{ Name: 'email', Value: pendingEmail }],
        ValidationData: [{ Name: 'inviteCode', Value: $('#inv-code').value.trim() }],
      });
      $('#inv-pass').value = '';
      $('#invite-form').hidden = true;
      $('#confirm-form').hidden = false;
      $('#inv-confirm').focus();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { $('#inv-submit').disabled = false; }
  });
  $('#confirm-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const err = $('#confirm-error');
    err.hidden = true;
    try {
      await cognito('ConfirmSignUp', { Username: pendingEmail, ConfirmationCode: $('#inv-confirm').value.trim() });
      $('#confirm-form').hidden = true;
      $('#invite-done').hidden = false;
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  $('#inv-resend').addEventListener('click', async () => {
    try { await cognito('ResendConfirmationCode', { Username: pendingEmail }); toast('New code sent'); }
    catch (e) { $('#confirm-error').textContent = e.message; $('#confirm-error').hidden = false; }
  });

  return { onSignedIn, render, renderSettings, renderChart, checkGoals, leaveCrewMode: () => $('#chart').closest('.chart-card').classList.remove('crew-mode') };
})();
