'use strict';
// Share image: draws a completed workout onto a 1080x1350 canvas (4:5
// portrait, fits Instagram feed/Stories and messaging apps). Pure Canvas API.
//
// WorkoutShare.render(workout, { unit, prs, domain }) returns
//   { canvas, report } where report lists every text box drawn, so tests can
//   check nothing overflows. prs: Map(exerciseIndex -> setIndex) of PR sets.
(function () {
  const W = 1080, H = 1350;
  const PAD = 72;
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';
  const C = {
    bg: '#000000', card: '#1c1c1e', chip: '#2c2c2e', text: '#ffffff',
    text2: 'rgba(235,235,245,0.62)', accent: '#0A84FF', onAccent: '#ffffff',
  };
  const MIN_SCALE = 0.72; // smallest set text = 30px * 0.72 ≈ 22px on a 1080px image
  const KG_PER_LB = 0.45359237;

  const fmt = (n, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('en-GB', { maximumFractionDigits: d });
  const conv = (kg, unit) => (unit === 'lb' ? kg / KG_PER_LB : kg);
  const dateLine = iso => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(/,/g, '');
  };

  function roundRect(ctx, x, y, w, h, r, fill) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // Wrap text into at most maxLines lines that fit maxWidth. Words longer
  // than a line are broken by character; an over-long last line ends in "…".
  function wrap(ctx, text, maxWidth, maxLines) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    const pushWord = w => {
      const tryLine = line ? `${line} ${w}` : w;
      if (ctx.measureText(tryLine).width <= maxWidth) { line = tryLine; return; }
      if (line) { lines.push(line); line = ''; }
      while (ctx.measureText(w).width > maxWidth) {
        let i = w.length;
        while (i > 1 && ctx.measureText(w.slice(0, i)).width > maxWidth) i--;
        lines.push(w.slice(0, i));
        w = w.slice(i);
      }
      line = w;
    };
    words.forEach(pushWord);
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      let last = lines[maxLines - 1];
      while (last.length && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
      lines.length = maxLines;
      lines[maxLines - 1] = `${last.trimEnd()}…`;
    }
    return lines;
  }

  function setLabel(s, unit) {
    return `${fmt(s.reps, 0)} × ${fmt(conv(s.weight, unit))} ${unit}`;
  }

  // Lays out (and optionally draws) the exercise blocks from y0 at scale s.
  // Returns the height used and the text boxes, without touching pixels when
  // draw is false, so the fitting loop can measure first.
  function layoutExercises(ctx, exercises, opts, s, y0, draw, report) {
    const innerW = W - PAD * 2;
    const cardPad = Math.round(32 * s);
    const nameSize = Math.round(40 * s), chipSize = Math.round(30 * s);
    const chipH = Math.round(chipSize * 1.75), chipPadX = Math.round(18 * s), gap = Math.round(12 * s);
    const badgeSize = Math.round(20 * s), badgeH = Math.round(badgeSize * 1.5), badgePadX = Math.round(10 * s);
    const blockGap = Math.round(20 * s);
    let y = y0;
    for (const { ex, index } of exercises) {
      const prSet = opts.prs && opts.prs.has(index) ? opts.prs.get(index) : -1;
      ctx.font = `600 ${nameSize}px ${FONT}`;
      const nameLines = wrap(ctx, ex.name, innerW - cardPad * 2, 2);
      // chip flow
      ctx.font = `500 ${chipSize}px ${FONT}`;
      const chips = [];
      let cx = 0, rows = ex.sets.length ? 1 : 0;
      ex.sets.forEach((st, j) => {
        const label = setLabel(st, opts.unit);
        let w = ctx.measureText(label).width + chipPadX * 2;
        ctx.font = `700 ${badgeSize}px ${FONT}`;
        const badgeW = j === prSet ? ctx.measureText('PR').width + badgePadX * 2 : 0;
        ctx.font = `500 ${chipSize}px ${FONT}`;
        if (badgeW) w += badgeW + Math.round(10 * s);
        w = Math.min(w, innerW - cardPad * 2);
        if (cx && cx + w > innerW - cardPad * 2) { rows++; cx = 0; }
        chips.push({ label, w, x: cx, row: rows - 1, badgeW, pr: j === prSet });
        cx += w + gap;
      });
      const nameH = nameLines.length * Math.round(nameSize * 1.2);
      const chipsH = rows ? rows * chipH + (rows - 1) * gap : Math.round(chipSize * 1.4);
      const cardH = cardPad + nameH + Math.round(16 * s) + chipsH + cardPad;
      if (draw) {
        roundRect(ctx, PAD, y, innerW, cardH, 20, C.card);
        ctx.textBaseline = 'top';
        ctx.fillStyle = C.text;
        ctx.font = `600 ${nameSize}px ${FONT}`;
        nameLines.forEach((ln, k) => {
          const ty = y + cardPad + k * Math.round(nameSize * 1.2);
          ctx.fillText(ln, PAD + cardPad, ty);
          report.push({ text: ln, x: PAD + cardPad, y: ty, w: ctx.measureText(ln).width, h: nameSize, maxW: innerW - cardPad * 2 });
        });
        const chipTop = y + cardPad + nameH + Math.round(16 * s);
        if (!chips.length) {
          ctx.font = `500 ${chipSize}px ${FONT}`;
          ctx.fillStyle = C.text2;
          ctx.fillText('No sets', PAD + cardPad, chipTop);
          report.push({ text: 'No sets', x: PAD + cardPad, y: chipTop, w: ctx.measureText('No sets').width, h: chipSize, maxW: innerW - cardPad * 2 });
        }
        for (const ch of chips) {
          const x = PAD + cardPad + ch.x, cy = chipTop + ch.row * (chipH + gap);
          roundRect(ctx, x, cy, ch.w, chipH, chipH / 2, ch.pr ? 'rgba(10,132,255,0.22)' : C.chip);
          ctx.font = `500 ${chipSize}px ${FONT}`;
          ctx.fillStyle = C.text;
          ctx.textBaseline = 'middle';
          const tx = x + chipPadX;
          ctx.fillText(ch.label, tx, cy + chipH / 2);
          const tw = ctx.measureText(ch.label).width;
          report.push({ text: ch.label, x: tx, y: cy, w: tw, h: chipH, maxW: ch.w - chipPadX * 2 - (ch.badgeW ? ch.badgeW + Math.round(10 * s) : 0) });
          if (ch.pr) {
            const bx = tx + tw + Math.round(10 * s), by = cy + (chipH - badgeH) / 2;
            roundRect(ctx, bx, by, ch.badgeW, badgeH, badgeH / 2, C.accent);
            ctx.font = `700 ${badgeSize}px ${FONT}`;
            ctx.fillStyle = C.onAccent;
            ctx.fillText('PR', bx + badgePadX, by + badgeH / 2);
            report.push({ text: 'PR', x: bx + badgePadX, y: by, w: ctx.measureText('PR').width, h: badgeH, maxW: ch.badgeW - badgePadX * 2 });
          }
          ctx.textBaseline = 'top';
        }
      }
      y += cardH + blockGap;
    }
    return y - y0;
  }

  function render(workout, opts = {}) {
    opts = { unit: 'kg', prs: new Map(), domain: '', ...opts };
    const canvas = document.createElement('canvas');
    canvas.width = W; // fixed pixel size, independent of devicePixelRatio
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const report = [];
    const text = (str, x, y, font, color, align = 'left') => {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = 'top';
      ctx.fillText(str, x, y);
      const w = ctx.measureText(str).width;
      const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      report.push({ text: str, x: left, y, w, h: parseInt(font.match(/(\d+)px/)[1], 10), maxW: W - PAD * 2 });
      ctx.textAlign = 'left';
    };

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W, 0, 0, W, 0, 900);
    glow.addColorStop(0, 'rgba(10,132,255,0.28)');
    glow.addColorStop(1, 'rgba(10,132,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Header: wordmark + date
    let y = PAD;
    roundRect(ctx, PAD, y + 2, 40, 40, 11, C.accent);
    ctx.strokeStyle = C.onAccent; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(PAD + 10, y + 32); ctx.lineTo(PAD + 18, y + 22); ctx.lineTo(PAD + 24, y + 27); ctx.lineTo(PAD + 31, y + 13); ctx.stroke();
    text('Workouts', PAD + 56, y + 2, `700 36px ${FONT}`, C.text);
    y += 72;
    text(dateLine(workout.date), PAD, y, `700 76px ${FONT}`, C.text);
    y += 76 + 40;

    // Stats tiles
    const sets = workout.exercises.reduce((n, e) => n + e.sets.length, 0);
    const volume = workout.exercises.reduce((n, e) => n + e.sets.reduce((m, s) => m + s.reps * s.weight, 0), 0);
    const tiles = [
      [`${fmt(conv(volume, opts.unit), 0)}`, `Volume (${opts.unit})`],
      [String(sets), sets === 1 ? 'Set' : 'Sets'],
      [String(workout.exercises.length), workout.exercises.length === 1 ? 'Exercise' : 'Exercises'],
    ];
    const tileGap = 20, tileW = (W - PAD * 2 - tileGap * 2) / 3, tileH = 168;
    tiles.forEach(([v, label], i) => {
      const x = PAD + i * (tileW + tileGap);
      roundRect(ctx, x, y, tileW, tileH, 20, C.card);
      let size = 60;
      ctx.font = `700 ${size}px ${FONT}`;
      while (size > 32 && ctx.measureText(v).width > tileW - 48) { size -= 2; ctx.font = `700 ${size}px ${FONT}`; }
      text(v, x + 28, y + 30, `700 ${size}px ${FONT}`, i === 0 ? C.accent : C.text);
      report[report.length - 1].maxW = tileW - 48;
      text(label, x + 28, y + 108, `500 28px ${FONT}`, C.text2);
      report[report.length - 1].maxW = tileW - 48;
    });
    y += tileH + 32;

    // Footer position is fixed; exercises must end above it.
    const footerY = H - PAD - 30;
    const avail = footerY - 32 - y;
    const items = workout.exercises.map((ex, index) => ({ ex, index }));

    // 1) shrink text until everything fits or we hit the readable minimum
    let scale = 1, shown = items.length;
    const heightAt = (s, n, moreLine) =>
      layoutExercises(ctx, items.slice(0, n), opts, s, 0, false, []) + (moreLine ? Math.round(44 * s) : 0);
    while (scale > MIN_SCALE && heightAt(scale, shown, false) > avail) scale = Math.max(MIN_SCALE, +(scale - 0.04).toFixed(2));
    // 2) still too tall: show the first exercises and a "+N more" line
    if (heightAt(scale, shown, false) > avail) {
      while (shown > 1 && heightAt(scale, shown, true) > avail) shown--;
    }
    layoutExercises(ctx, items.slice(0, shown), opts, scale, y, true, report);
    const used = heightAt(scale, shown, false);
    if (shown < items.length) {
      const n = items.length - shown;
      text(`+${n} more exercise${n === 1 ? '' : 's'}`, PAD, y + used, `600 ${Math.round(32 * scale)}px ${FONT}`, C.text2);
    }

    // Footer
    if (opts.domain) text(opts.domain, W / 2, footerY, `500 30px ${FONT}`, C.text2, 'center');

    return { canvas, report, scale, shown, footerY };
  }

  // Overflow check used by the test page: every text box inside the canvas,
  // within its own max width, and every exercise line above the footer.
  function check(result) {
    const problems = [];
    for (const r of result.report) {
      if (r.x < 0 || r.x + r.w > W + 0.5 || r.y < 0 || r.y + r.h > H) problems.push(`outside canvas: ${r.text}`);
      if (r.w > r.maxW + 0.5) problems.push(`wider than its box: ${r.text}`);
    }
    const body = result.report.filter(r => r.y < result.footerY && r.y > 300);
    for (const r of body) if (r.y + r.h > result.footerY) problems.push(`overlaps footer: ${r.text}`);
    return problems;
  }

  window.WorkoutShare = { render, check, WIDTH: W, HEIGHT: H };
})();
