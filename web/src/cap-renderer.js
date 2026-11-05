/**
 * Procedural Bottlecap Canvas Renderer for Bottlecaps (CAPC).
 * 100% self-contained client-side rendering (zero external assets, compliant with strict CSP).
 * Renders 21 crimped flutes, metallic discs, vector emblems, weathering/scratches, and tier glow coronas.
 */

export const RARITY_TIERS = {
  1: { id: 1, name: 'Scrap', color: '#8b8b8b', border: '#5a5a5a', glowColor: null, pct: '60%' },
  2: { id: 2, name: 'Brass', color: '#cd7f32', border: '#8b5a2b', glowColor: null, pct: '25%' },
  3: { id: 3, name: 'Rad-Glow Silver', color: '#00e5ff', border: '#00b4d8', glowColor: 'rgba(0, 229, 255, 0.75)', pct: '10%' },
  4: { id: 4, name: 'Vault Gold', color: '#ffd700', border: '#b8860b', glowColor: 'rgba(255, 215, 0, 0.85)', pct: '4%' },
  5: { id: 5, name: 'Mythic Obsidian', color: '#e040fb', border: '#9c27b0', glowColor: 'rgba(224, 64, 251, 0.95)', pct: '1%' },
};

const METALS = {
  rust_iron: { outer: ['#4a4540', '#2d2926'], inner: ['#5c4a3d', '#3d2b1f'], rim: '#7a6252', highlight: '#8a7b70' },
  weathered_copper: { outer: ['#8a5238', '#4a2518'], inner: ['#5a7d6b', '#2a4d3b'], rim: '#b87333', highlight: '#d48c5e' },
  antiqued_brass: { outer: ['#b89038', '#5a4218'], inner: ['#c8a048', '#6a5220'], rim: '#d4af37', highlight: '#f3e5ab' },
  rad_silver: { outer: ['#a8b8c8', '#405060'], inner: ['#8098a8', '#384858'], rim: '#d8e8f8', highlight: '#ffffff' },
  gilded_gold: { outer: ['#ffd700', '#8b6914'], inner: ['#ffb700', '#996515'], rim: '#fff0a0', highlight: '#ffffff' },
  obsidian_carbon: { outer: ['#1a1a24', '#08080c'], inner: ['#222030', '#100e18'], rim: '#484060', highlight: '#8880a8' },
  weathered_tin: { outer: ['#787880', '#383840'], inner: ['#686870', '#303038'], rim: '#9898a0', highlight: '#c0c0c8' },
};

export function renderCapToCanvas(canvas, recipe) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const center = size / 2;
  const radius = size * 0.40;

  ctx.clearRect(0, 0, size, size);

  const tierId = recipe.tier || 1;
  const tier = RARITY_TIERS[tierId] || RARITY_TIERS[1];
  const traits = recipe.traits || {};
  const metalKey = traits.base_metal || 'rust_iron';
  const metal = METALS[metalKey] || METALS.rust_iron;

  // 1. Glowing Corona (Tier 3, 4, 5)
  if (tier.glowColor) {
    ctx.save();
    const glowGrad = ctx.createRadialGradient(center, center, radius * 0.7, center, center, radius * 1.25);
    glowGrad.addColorStop(0, tier.glowColor);
    glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(center, center, radius * 1.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 2. 21 Crimped Flutes
  const numFlutes = 21;
  const fluteRadius = radius * 1.12;
  ctx.save();
  for (let i = 0; i < numFlutes; i++) {
    const angle = (i * 2 * Math.PI) / numFlutes;
    const fx = center + Math.cos(angle) * radius;
    const fy = center + Math.sin(angle) * radius;
    const tipX = center + Math.cos(angle) * fluteRadius;
    const tipY = center + Math.sin(angle) * fluteRadius;

    ctx.beginPath();
    ctx.arc(tipX, tipY, size * 0.048, 0, Math.PI * 2);
    const fluteGrad = ctx.createRadialGradient(tipX - 2, tipY - 2, 1, tipX, tipY, size * 0.05);
    fluteGrad.addColorStop(0, metal.highlight);
    fluteGrad.addColorStop(0.5, metal.outer[0]);
    fluteGrad.addColorStop(1, '#0c0a08');
    ctx.fillStyle = fluteGrad;
    ctx.fill();
  }
  ctx.restore();

  // 3. Outer Cap Body & Rim
  ctx.save();
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  const outerGrad = ctx.createRadialGradient(center - radius * 0.3, center - radius * 0.3, radius * 0.1, center, center, radius);
  outerGrad.addColorStop(0, metal.outer[0]);
  outerGrad.addColorStop(0.7, metal.outer[1]);
  outerGrad.addColorStop(1, '#0a0a0c');
  ctx.fillStyle = outerGrad;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;
  ctx.fill();
  ctx.restore();

  // Rim bevel line
  ctx.save();
  ctx.beginPath();
  ctx.arc(center, center, radius * 0.94, 0, Math.PI * 2);
  ctx.lineWidth = size * 0.02;
  ctx.strokeStyle = metal.rim;
  ctx.stroke();
  ctx.restore();

  // 4. Inner Crown Face
  const innerRadius = radius * 0.82;
  ctx.save();
  ctx.beginPath();
  ctx.arc(center, center, innerRadius, 0, Math.PI * 2);
  const innerGrad = ctx.createRadialGradient(center - innerRadius * 0.35, center - innerRadius * 0.35, 5, center, center, innerRadius);
  innerGrad.addColorStop(0, metal.inner[0]);
  innerGrad.addColorStop(0.65, metal.inner[1]);
  innerGrad.addColorStop(1, '#050508');
  ctx.fillStyle = innerGrad;
  ctx.fill();
  ctx.restore();

  // 5. Draw Custom Artwork or Preset Emblem
  if (traits.custom_image) {
    drawCustomImage(ctx, center, center, innerRadius * 0.90, traits.custom_image, () => {
      renderCapToCanvas(canvas, recipe);
    });
  } else if (traits.custom_strokes && traits.custom_strokes.length > 0) {
    drawCustomStrokes(ctx, center, center, innerRadius * 0.72, traits.custom_strokes);
  } else {
    drawEmblem(ctx, center, center, innerRadius * 0.72, traits.emblem || 'atomic', tier.color);
  }

  // 6. Weathering / Wear
  applyWear(ctx, center, center, innerRadius, traits.wear || 'mint');

  // 7. Glass specular sheen highlight
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(center - innerRadius * 0.3, center - innerRadius * 0.35, innerRadius * 0.5, innerRadius * 0.25, -Math.PI / 4, 0, Math.PI * 2);
  const sheen = ctx.createLinearGradient(center - innerRadius * 0.6, center - innerRadius * 0.6, center, center);
  sheen.addColorStop(0, 'rgba(255,255,255,0.35)');
  sheen.addColorStop(1, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = sheen;
  ctx.fill();
  ctx.restore();
}

function drawEmblem(ctx, cx, cy, rad, emblemName, accentColor) {
  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.fillStyle = accentColor;
  ctx.lineWidth = Math.max(2, rad * 0.08);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (emblemName.includes('atomic') || emblemName.includes('radiation') || emblemName === 'nuka_quantum') {
    // Atomic Nucleus + 3 Orbiting Electron Rings
    ctx.beginPath();
    ctx.arc(cx, cy, rad * 0.22, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((i * Math.PI) / 3);
      ctx.beginPath();
      ctx.ellipse(0, 0, rad * 0.85, rad * 0.32, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  } else if (emblemName.includes('vault') || emblemName.includes('gear')) {
    // Vault Door Gear with 10 Teeth + Center Vault 76 / 101 Number
    const teeth = 10;
    ctx.beginPath();
    for (let i = 0; i < teeth; i++) {
      const a1 = (i * 2 * Math.PI) / teeth;
      const a2 = a1 + (Math.PI / teeth) * 0.5;
      const a3 = a1 + (Math.PI / teeth);
      ctx.lineTo(cx + Math.cos(a1) * rad * 0.9, cy + Math.sin(a1) * rad * 0.9);
      ctx.lineTo(cx + Math.cos(a2) * rad * 0.9, cy + Math.sin(a2) * rad * 0.9);
      ctx.lineTo(cx + Math.cos(a3) * rad * 0.7, cy + Math.sin(a3) * rad * 0.7);
    }
    ctx.closePath();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, rad * 0.45, 0, Math.PI * 2);
    ctx.stroke();

    ctx.font = `bold ${Math.round(rad * 0.38)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('76', cx, cy);
  } else if (emblemName.includes('star') || emblemName.includes('sunset')) {
    // Sunset Star 5-Point Emblem
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const outerA = (i * 2 * Math.PI) / 5 - Math.PI / 2;
      const innerA = outerA + Math.PI / 5;
      ctx.lineTo(cx + Math.cos(outerA) * rad * 0.95, cy + Math.sin(outerA) * rad * 0.95);
      ctx.lineTo(cx + Math.cos(innerA) * rad * 0.45, cy + Math.sin(innerA) * rad * 0.45);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = rad * 0.05;
    ctx.stroke();
  } else if (emblemName.includes('skull')) {
    // Skull & Crossbones
    ctx.beginPath();
    ctx.arc(cx, cy - rad * 0.15, rad * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - rad * 0.22, cy + rad * 0.15, rad * 0.44, rad * 0.25);

    // Eye sockets (cutout)
    ctx.fillStyle = '#100e18';
    ctx.beginPath();
    ctx.arc(cx - rad * 0.16, cy - rad * 0.12, rad * 0.11, 0, Math.PI * 2);
    ctx.arc(cx + rad * 0.16, cy - rad * 0.12, rad * 0.11, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Default Emblem: Bottlecap Stamp / Starburst
    ctx.beginPath();
    ctx.arc(cx, cy, rad * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = `bold ${Math.round(rad * 0.3)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BCAP', cx, cy);
  }
  ctx.restore();
}

function applyWear(ctx, cx, cy, rad, wear) {
  if (wear === 'mint') return;
  ctx.save();

  if (wear.includes('scratches') || wear.includes('patina')) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      const sx = cx + (Math.sin(i * 1.7) * rad * 0.65);
      const sy = cy + (Math.cos(i * 2.3) * rad * 0.65);
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 24 * Math.cos(i), sy + 18 * Math.sin(i));
      ctx.stroke();
    }
  }

  if (wear.includes('rust') || wear.includes('heavy')) {
    ctx.fillStyle = 'rgba(110, 50, 20, 0.35)';
    for (let i = 0; i < 12; i++) {
      const rx = cx + (Math.cos(i * 1.1) * rad * 0.7);
      const ry = cy + (Math.sin(i * 1.5) * rad * 0.7);
      ctx.beginPath();
      ctx.arc(rx, ry, 6 + (i % 5) * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (wear.includes('bullet') || wear.includes('dent')) {
    // 3D bullet impact dent
    const dx = cx + rad * 0.35;
    const dy = cy - rad * 0.35;
    ctx.beginPath();
    ctx.arc(dx, dy, rad * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = '#08080c';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

export function renderCapToDataURL(recipe, size = 180) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  renderCapToCanvas(canvas, recipe);
  return canvas.toDataURL('image/png');
}

const imageElementCache = new Map();

function drawCustomImage(ctx, cx, cy, rad, src, onLoaded) {
  let img = imageElementCache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    img.onload = () => {
      imageElementCache.set(src, img);
      if (onLoaded) onLoaded();
    };
    return;
  }

  if (!img.complete || img.naturalWidth === 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.clip();

  const aspect = img.width / img.height;
  let drawW = rad * 2;
  let drawH = rad * 2;
  if (aspect > 1) {
    drawW = drawH * aspect;
  } else {
    drawH = drawW / aspect;
  }
  ctx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
  ctx.restore();
}

function drawCustomStrokes(ctx, cx, cy, rad, strokes) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const s of strokes) {
    if (!s.points || s.points.length === 0) continue;
    ctx.strokeStyle = s.color || '#ffd700';
    ctx.lineWidth = Math.max(1.5, (s.width || 0.05) * rad);
    ctx.beginPath();
    const p0 = s.points[0];
    ctx.moveTo(cx + p0.x * rad, cy + p0.y * rad);
    for (let i = 1; i < s.points.length; i++) {
      const pt = s.points[i];
      ctx.lineTo(cx + pt.x * rad, cy + pt.y * rad);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function processImageToCircle(src, filter, callback) {
  const img = new Image();
  img.src = src;
  img.onload = () => {
    const size = 256;
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const ctx = off.getContext('2d');
    if (!ctx) return;

    // Center crop to square
    const aspect = img.width / img.height;
    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    if (aspect > 1) {
      sw = img.height;
      sx = (img.width - sw) / 2;
    } else {
      sh = img.width;
      sy = (img.height - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);

    if (filter !== 'none') {
      const imgData = ctx.getImageData(0, 0, size, size);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        if (filter === 'sepia') {
          d[i] = Math.min(255, gray * 1.05 + 30);
          d[i + 1] = Math.min(255, gray * 0.85 + 15);
          d[i + 2] = Math.max(0, gray * 0.60);
        } else if (filter === 'phosphor') {
          d[i] = Math.max(0, gray * 0.15);
          d[i + 1] = Math.min(255, gray * 1.25 + 20);
          d[i + 2] = Math.max(0, gray * 0.20);
        } else if (filter === 'mono') {
          d[i] = gray;
          d[i + 1] = gray;
          d[i + 2] = gray;
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }

    callback(off.toDataURL('image/png'));
  };
}
