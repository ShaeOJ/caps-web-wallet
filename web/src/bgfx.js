/* Background FX: subtle hash / network / block-building lattice.
   Ported from the A.S.I.C. pool front-end so CAPS surfaces share one look.

   One fixed canvas behind all content: drifting peer nodes + connecting lines
   (network), light pulses travelling along edges (hashing), and a block that
   forms + links + ripples every ~15-25s (block building). Tinted from the
   --accent-rgb CSS var. Pauses when the tab is hidden; honours reduced-motion. */
export function initBgfx() {
  const canvas = document.getElementById('bgfx');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TAU = Math.PI * 2, LINK = 150;

  let W = 0, H = 0, DPR = 1, nodes = [], pulses = [], blocks = [];
  let accent = '245,166,35', tick = 0, raf = 0, last = 0;
  let lastBlock = 0, blockGap = 16000 + Math.random() * 9000, pulseTimer = 0;

  const readAccent = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
    if (v) accent = v;
  };

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const target = Math.max(22, Math.min(64, Math.round(W * H / 27000)));
    nodes = [];
    for (let i = 0; i < target; i++) {
      nodes.push({ x: Math.random() * W, y: Math.random() * H,
                   vx: (Math.random() - 0.5) * 0.10, vy: (Math.random() - 0.5) * 0.10 });
    }
  }

  function spawnPulse() {
    const a = nodes[(Math.random() * nodes.length) | 0]; if (!a) return;
    let best = null, bd = LINK;
    for (const b of nodes) {
      if (b === a) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) pulses.push({ a, b: best, p: 0, sp: 0.007 + Math.random() * 0.009 });
  }

  function frame(t) {
    const dt = Math.min(48, t - last); last = t;
    ctx.clearRect(0, 0, W, H);
    if (++tick % 40 === 0) readAccent();

    for (const n of nodes) {
      n.x += n.vx * dt; n.y += n.vy * dt;
      if (n.x < 0) n.x += W; else if (n.x > W) n.x -= W;
      if (n.y < 0) n.y += H; else if (n.y > H) n.y -= H;
    }

    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < LINK) {
          ctx.strokeStyle = `rgba(${accent},${(1 - d / LINK) * 0.09})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    ctx.fillStyle = `rgba(${accent},0.32)`;
    for (const n of nodes) { ctx.beginPath(); ctx.arc(n.x, n.y, 1.4, 0, TAU); ctx.fill(); }

    pulseTimer += dt;
    if (pulseTimer > 650) { pulseTimer = 0; if (pulses.length < 7) spawnPulse(); }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i]; p.p += p.sp * dt;
      if (p.p >= 1) { pulses.splice(i, 1); continue; }
      const x = p.a.x + (p.b.x - p.a.x) * p.p, y = p.a.y + (p.b.y - p.a.y) * p.p;
      ctx.fillStyle = `rgba(${accent},${0.6 * (1 - Math.abs(0.5 - p.p) * 2)})`;
      ctx.beginPath(); ctx.arc(x, y, 2, 0, TAU); ctx.fill();
    }

    if (t - lastBlock > blockGap) {
      lastBlock = t; blockGap = 15000 + Math.random() * 10000;
      const n = nodes[(Math.random() * nodes.length) | 0] || { x: W / 2, y: H / 2 };
      blocks.push({ x: n.x, y: n.y, t0: t, life: 2800 });
      if (blocks.length > 6) blocks.shift();
    }
    ctx.lineWidth = 1.5;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i], age = t - b.t0;
      const k = Math.min(1, age / 500), fade = Math.max(0, 1 - (age - 600) / (b.life - 600));
      if (i > 0) {
        const pb = blocks[i - 1];
        ctx.strokeStyle = `rgba(${accent},${0.10 * fade})`;
        ctx.beginPath(); ctx.moveTo(pb.x, pb.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      if (age < 1400) {
        const r = (age / 1400) * 55;
        ctx.strokeStyle = `rgba(${accent},${0.22 * (1 - age / 1400)})`;
        ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, TAU); ctx.stroke();
      }
      const s = 6.5 * k;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(0.785);
      ctx.fillStyle = `rgba(${accent},${0.45 * fade})`;
      ctx.strokeStyle = `rgba(${accent},${0.75 * fade})`;
      ctx.fillRect(-s, -s, s * 2, s * 2); ctx.strokeRect(-s, -s, s * 2, s * 2);
      ctx.restore();
    }
    blocks = blocks.filter(b => t - b.t0 < b.life);

    raf = requestAnimationFrame(frame);
  }

  const start = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

  readAccent(); resize();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
  if (reduce) { last = performance.now(); frame(performance.now()); stop(); } // one static frame
  else start();
}
