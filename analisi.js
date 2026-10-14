/*
 * analisi.js: analisi delle foto delle cartine nel browser. Usata da Semplice.dc.html (rilievo semplice) e da
 * Taratura.dc.html (prova in ufficio), così le due pagine misurano esattamente lo stesso codice.
 * Va caricata prima di support.js: le costanti e le funzioni sono globali.
 *
 * Segue lo stesso metodo di tools/analisi_cartine.py (Python con OpenCV, il riferimento: nel prodotto girerà sul
 * server, sulla foto originale); qui serve per la risposta immediata sul telefono, anche senza rete.
 * Verificato sulle foto della prova in ufficio (7 telefoni × 24 cartine): stessi numeri del Python entro pochi decimi.
 *   1. Fondo: colore mediano della cornice esterna del riquadro; se è chiaro e neutro (carta, tavolo) l'immagine si
 *      bilancia su quel colore, così con luce calda un fondo beige non sembra giallo. Su foglia non si bilancia.
 *   2. Cartina: pixel diversi dal fondo, cioè colorati (carta gialla, macchie blu-viola) o più scuri (macchie fitte),
 *      fuori dalle zone di foglia; uniti, con i buchi riempiti, si tiene la macchia più grande che sia un quadrilatero
 *      pieno. Se non viene, si riprova con soglie più severe (ombre del telefono attaccate alla cartina).
 *   3. Ritaglio raddrizzato con la prospettiva, dall'immagine a piena risoluzione, senza un margine ai bordi.
 *   4. Copertura frazionaria: v = ((R+G)/2 − B) / luminosità del fondo, con la luce della carta stimata zona per zona
 *      (ombre); un pixel a metà tra carta e macchia (goccia più piccola del pixel, foto sfocata) conta per metà.
 *      Si escludono foglia, riflessi, strisce di fondo lungo i bordi e la graffetta (vedi findClip).
 */
// Cambia quando cambia l'analisi: finisce nei dati raccolti, per sapere con che versione sono state fatte le foto.
const ANALISI_VERSIONE = '2026-10-08';

const GUIDE = 0.7;          // lato del riquadro guida rispetto al lato del mirino (vedi .guide in CSS)
// Ritrovamento (come in tools/analisi_cartine.py)
const MAX_SIDE = 800;       // lato massimo dell'immagine su cui si cerca la cartina, in px
const BG_RING = 0.06;       // cornice esterna da cui si stima il colore del fondo, rispetto al lato
const BG_MAX_CHROMA = 0.3;  // fondo più colorato di così: non si bilancia (foglia, o cartina che riempie il riquadro)
const FIND_DIFF = [0.3, 0.36, 0.42, 0.5];   // differenza minima dal fondo per dire "cartina", in ordine di severità
const FIND_CLOSE = 0.012;   // chiusura della maschera della cartina (graffetta, riflessi), rispetto al lato
const CARD_FILL = 0.75;     // la macchia trovata deve riempire almeno questa frazione del suo rettangolo
const QUAD_MIN = 0.9;       // il quadrilatero dagli angoli dell'inviluppo vale se copre almeno questa frazione del rettangolo
const CARD_MIN = 0.15;      // lato minimo della cartina rispetto al lato del riquadro
const LEAF_GR = 1.15;       // verde/rosso oltre cui il pixel è foglia (la carta delle cartine sta sotto 1,11 nel 99% dei casi)
const LEAF_WIN = 0.03;      // lato della finestra per decidere se una zona è foglia, rispetto al lato dell'immagine
const LEAF_FRAC = 0.3;      // zona di foglia se almeno questa frazione dei pixel vicini è verde foglia
// Ritaglio
const EDGE_INSET = 0.04;    // margine tolto a ogni bordo della cartina (taglio a mano, ombre), rispetto al lato
const CARD_SIDE = 600;      // lato massimo del ritaglio, in px (non si ingrandisce mai)
// Copertura
const PAPER_MIN = 0.5;      // la carta non è meno gialla di così (cartine tutte macchiate, dove il "giallo" è oliva)
const STAIN_MAX = -0.1;     // le macchie non sono meno blu di così (cartine quasi pulite)
const STAIN_SURE = 0.005;   // macchie sicure almeno questa frazione della cartina per stimarne il valore tipico
const STAIN_TYPICAL = 0.25; // percentile delle macchie sicure preso come macchia piena (compromesso tra DB e telefoni)
const DEAD_ZONE = 0.08;     // sotto la carta di meno di così: rumore della carta, non macchia
const LOCAL_LIGHT = 0.12;   // la luce sulla carta si stima zona per zona (ombre): raggio rispetto al lato
const LIGHT_LIMITS = [0.5, 1.3];   // la luce locale resta entro questi limiti rispetto a quella media della carta
const STRIP_NEUTRAL = 0.15; // strisce senza colore lungo un bordo del ritaglio (fondo, un'altra cartina)...
const STRIP_SIZE = [0.25, 0.3];    // ...larghe al massimo e lunghe almeno questa frazione del lato...
const STRIP_DENSE = 0.6;    // ...e compatte: riempiono almeno questa frazione del loro riquadro (non la rete grigia delle cartine molto macchiate)
const GLARE_CHROMA = 0.15;  // riflessi e nastro: meno colorati di così...
const GLARE_LUM = 1.05;     // ...e più chiari della carta
// Graffetta (08/10/2026, come graffetta() di tools/analisi_cartine.py; banco in tools/banco_graffetta/). Ogni pixel come
// a·carta + b·macchia (colori stimati sulla cartina): carta, macchie e i loro misti sfocati hanno a + b vicino alla luce
// locale, la graffetta no (metallo scuro, riflessi chiari). Si cercano tratti dritti e continui di pixel "anomali".
// Sulla prova in ufficio trova 56 graffette su 76 (prima 4) e sbaglia zona su poche foto (prima più di metà).
const CLIP_GRID = 300;      // la ricerca si fa su una copia del ritaglio con questo lato massimo
const CLIP_LIGHT = 0.05;    // luce locale: media su questo raggio, rispetto al lato
const CLIP_ODD = 0.3;       // |ln(luce del pixel / luce locale)| oltre cui il pixel è anomalo
const CLIP_SEG = 0.08;      // segmento di prova, rispetto al lato...
const CLIP_SIDES = 0.035;   // ...e le due righe parallele ai suoi lati, a questa distanza
const CLIP_ANGLES = 16;     // inclinazioni provate su 180°
const CLIP_FULL = 0.8;      // il segmento è anomalo almeno per questa frazione...
const CLIP_SIDES_MAX = 0.5; // ...e le righe ai lati al massimo per questa (non una macchia larga)
const CLIP_LEN = [0.1, 0.8];  // lunghezza della graffetta rispetto al lato
const CLIP_BLUE = 0.6;      // colore della parte scura tra carta (0) e macchia (1): oltre, è una macchia
const CLIP_EDGE = 0.03;     // fascia lungo i bordi del ritaglio dove non si cerca (fondo, ombre)
const CLIP_SIDE = 0.08;     // linea parallela a un lato ed entro questa distanza: è il bordo della cartina
const CLIP_JOIN = [0.15, 0.06];  // pezzi della stessa graffetta: distanza lungo l'asse e di lato, rispetto al lato
const CLIP_HALF = 0.012;    // mezza larghezza della barra esclusa, rispetto al lato
const CLIP_BUFFER = 0.008;  // margine escluso intorno, rispetto al lato
const CLIP_GUIDED = { full: 0.65, odd: 0.25, len: [0.05, 0.9] };   // dentro la zona cerchiata dall'operatore
// Nitidezza (08/10/2026): sui bordi netti delle macchie il gradiente fine resta più alto di quello su una copia sfocata;
// in una foto mossa o fuori fuoco i due si avvicinano. Rapporto mediano sui bordi più forti, sul ritaglio portato a
// SHARP_SIDE px. Prova in ufficio (JS): telefoni a fuoco mediana 1,28–1,43, Samsung S24 (foto sfocate) 1,13–1,18.
const SHARP_SIDE = 400;     // lato su cui si misura
const SHARP_BLUR = 2;       // sfocatura di confronto, in px
const SHARP_MIN = 1.18;     // sotto: la foto sembra sfocata (si invita a rifarla, non si blocca): segnala le 23 foto del S24 e 3 delle altre 143
// Stessa cartina due volte (vedi findDuplicate; 08/10/2026, tarato sulla prova in ufficio con js_impronta.html:
// coppie della stessa cartina fotografata da telefoni diversi e coppie di cartine diverse). Con DUP_SIMILAR riconosce
// il 90% delle coppie della stessa cartina che si possono confrontare (85% di tutte: le cartine quasi pulite o tutte
// macchiate si confrontano solo se è la stessa immagine) e nessuna delle 12.245 coppie di cartine diverse; con
// l'impronta 16 × 16 di prima ne riconosceva il 50% con lo 0,1% di falsi.
const SIG_GRID = 24;        // lato della griglia dell'impronta
const SIG_MIN_VALID = 0.4;  // cella valida se almeno questa frazione dei suoi pixel è cartina (non foglia né graffetta)
const SIG_LOCAL = 4;        // si toglie la media delle celle vicine (raggio in celle): resta il disegno delle macchie
const SIG_BORDER = 1;       // celle del bordo che non si confrontano (ritaglio diverso tra due foto)
const SIG_SHIFT = 1;        // spostamenti provati tra le due impronte, in celle
const SIG_MIN_SPREAD = 0.02; // impronta più piatta di così (cartina quasi pulita o tutta macchiata): solo il confronto esatto
const DUP_SIMILAR = 0.5;    // correlazione oltre cui due foto sembrano la stessa cartina (0,45: 2 falsi su 12.245)

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}
// Valori di arr dove sel[k] è vero (sel: array 0/1 o funzione k → bool).
function pick(arr, sel) {
  const out = [];
  for (let k = 0; k < arr.length; k++) if (sel(k)) out.push(arr[k]);
  return out;
}

// Filtro a finestra quadrata su una maschera 0/1, con l'immagine integrale:
// test(pixel accesi nella finestra, pixel della finestra) decide il nuovo valore.
function boxFilter(m, w, h, rad, test) {
  const W = w + 1, sum = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += m[y * w + x];
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
      const n = sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0];
      out[y * w + x] = test(n, (x1 - x0) * (y1 - y0)) ? 1 : 0;
    }
  }
  return out;
}
const dilate = (m, w, h, rad) => boxFilter(m, w, h, rad, (n) => n > 0);
const erode = (m, w, h, rad) => boxFilter(m, w, h, rad, (n, a) => n === a);
const closeMask = (m, w, h, rad) => erode(dilate(m, w, h, rad), w, h, rad);
// Dilatazione con un disco di raggio r (margine intorno alla graffetta).
function dilateDisc(m, w, h, r) {
  const out = new Uint8Array(w * h), offs = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) offs.push([dx, dy]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (const [dx, dy] of offs) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1; }
  }
  return out;
}

// Media mobile su una finestra (2·rad+1)², solo sui pixel dentro l'immagine.
function boxBlur(src, w, h, rad) {
  const W = w + 1, sum = new Float64Array(W * (h + 1)), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src[y * w + x]; sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row; }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
      out[y * w + x] = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}
// Sfocatura gaussiana approssimata con tre medie mobili (deviazione standard sigma, in px).
function gaussBlur(src, w, h, sigma) {
  const n = 3, wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let out = src;
  for (let i = 0; i < n; i++) out = boxBlur(out, w, h, ((i < m ? wl : wl + 2) - 1) / 2);
  return out;
}

// Macchie connesse (8 vicini) di una maschera 0/1: etichette (−1 = fuori) e per ognuna area e riquadro.
function components(m, w, h) {
  const n = w * h, lab = new Int32Array(n).fill(-1), stack = new Int32Array(n), comps = [];
  for (let s = 0; s < n; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    const id = comps.length, c = { id: id, area: 0, x0: w, y0: h, x1: 0, y1: 0 };
    let sp = 0; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const k = stack[--sp], x = k % w, y = (k / w) | 0;
      c.area++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (m[q] && lab[q] < 0) { lab[q] = id; stack[sp++] = q; }
        }
      }
    }
    comps.push(c);
  }
  return { lab: lab, comps: comps };
}

// ---- Ritrovamento della cartina ----
// 1 = zona di foglia verde: abbastanza pixel vicini con verde/rosso oltre LEAF_GR.
function leafZones(data, w, h) {
  const rad = Math.max(1, Math.floor(Math.max(w, h) * LEAF_WIN / 2));
  const m = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) { const r = data[4 * k], g = data[4 * k + 1], b = data[4 * k + 2]; m[k] = g > LEAF_GR * Math.max(r, 1) && g > b ? 1 : 0; }
  return boxFilter(m, w, h, rad, (n, a) => n > LEAF_FRAC * a);
}

// Colore del fondo dalla cornice: { gains, lum } per bilanciare, o null (fondo colorato o coperto di foglia).
function borderBalance(data, leaf, w, h) {
  const t = Math.max(2, Math.round(Math.min(w, h) * BG_RING)), R = [], G = [], B = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= t && x < w - t && y >= t && y < h - t) continue;
      const k = y * w + x;
      if (leaf[k]) continue;
      R.push(data[4 * k]); G.push(data[4 * k + 1]); B.push(data[4 * k + 2]);
    }
  }
  if (R.length < 0.5 * 2 * t * (w + h - 2 * t)) return null;
  const med = (a) => { const s = Float32Array.from(a).sort(), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const r = med(R), g = med(G), b = med(B), mx = Math.max(r, g, b);
  if (mx < 50 || (mx - Math.min(r, g, b)) / mx > BG_MAX_CHROMA) return null;
  const m = (r + g + b) / 3, clamp = (v) => Math.min(1.6, Math.max(0.6, v));
  const gains = [clamp(m / Math.max(r, 1)), clamp(m / Math.max(g, 1)), clamp(m / Math.max(b, 1))];
  return { gains: gains, lum: Math.max(r * gains[0], g * gains[1], b * gains[2]) };
}

// Inviluppo convesso (catena monotona) di punti [x, y].
function convexHull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
const polyArea = (p) => Math.abs(p.reduce((a, q, i) => { const r = p[(i + 1) % p.length]; return a + q[0] * r[1] - r[0] * q[1]; }, 0)) / 2;

// Rettangolo di area minima che contiene l'inviluppo: lati, area e i 4 angoli.
function minAreaRect(hull) {
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length], a = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const ca = Math.cos(a), sa = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ca + y * sa, v = -x * sa + y * ca;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const pt = (u, v) => [u * ca - v * sa, u * sa + v * ca];
      best = { area: area, w: u1 - u0, h: v1 - v0, box: [pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1)] };
    }
  }
  return best;
}
// Angoli in ordine alto-sx, alto-dx, basso-dx, basso-sx.
function orderCorners(p) {
  const by = (f, mx) => p.reduce((b, q) => ((mx ? f(q) > f(b) : f(q) < f(b)) ? q : b));
  return [by((q) => q[0] + q[1], false), by((q) => q[1] - q[0], false), by((q) => q[0] + q[1], true), by((q) => q[1] - q[0], true)];
}

// La cartina con una soglia: angoli (in px dell'immagine ridotta) del quadrilatero pieno più grande, o il motivo.
function findCard(data, leaf, w, h, bgLum, diffMin) {
  const n = w * h, m = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (leaf[k]) continue;
    const r = data[4 * k], g = data[4 * k + 1], b = data[4 * k + 2], mx = Math.max(r, g, b);
    const diff = Math.max((mx - Math.min(r, g, b)) / Math.max(mx, 1), bgLum ? 1 - mx / bgLum : 0);
    if (mx > 25 && diff > diffMin) m[k] = 1;
  }
  const closed = closeMask(m, w, h, Math.max(1, Math.round(Math.min(w, h) * FIND_CLOSE)));
  const { lab, comps } = components(closed, w, h), side = Math.min(w, h);
  // area con i buchi riempiti: si conta il fuori, partendo dal bordo del riquadro della macchia
  const filledArea = (c) => {
    const bw = c.x1 - c.x0 + 3, bh = c.y1 - c.y0 + 3, out = new Uint8Array(bw * bh), stack = new Int32Array(bw * bh);
    const inside = (x, y) => x >= 1 && y >= 1 && x < bw - 1 && y < bh - 1 && lab[(c.y0 + y - 1) * w + c.x0 + x - 1] === c.id;
    let sp = 0, outside = 0; stack[sp++] = 0; out[0] = 1;
    while (sp) {
      const q = stack[--sp], x = q % bw, y = (q / bw) | 0; outside++;
      if (x > 0 && !out[q - 1] && !inside(x - 1, y)) { out[q - 1] = 1; stack[sp++] = q - 1; }
      if (x < bw - 1 && !out[q + 1] && !inside(x + 1, y)) { out[q + 1] = 1; stack[sp++] = q + 1; }
      if (y > 0 && !out[q - bw] && !inside(x, y - 1)) { out[q - bw] = 1; stack[sp++] = q - bw; }
      if (y < bh - 1 && !out[q + bw] && !inside(x, y + 1)) { out[q + bw] = 1; stack[sp++] = q + bw; }
    }
    return bw * bh - outside;
  };
  let reason = 'nessuna macchia abbastanza grande';
  for (const c of comps.sort((a, b) => b.area - a.area)) {
    if (c.area < 0.03 * n) break;
    const area = filledArea(c);
    const pts = [];
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      const k = y * w + x;
      if (lab[k] !== c.id) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || lab[k - 1] !== c.id || lab[k + 1] !== c.id || lab[k - w] !== c.id || lab[k + w] !== c.id) pts.push([x, y]);
    }
    const hull = convexHull(pts), rect = minAreaRect(hull);
    if (!rect) continue;
    const lo = Math.min(rect.w, rect.h), hi = Math.max(rect.w, rect.h);
    if (lo < CARD_MIN * side) reason = 'piccola';
    else if (hi / Math.max(lo, 1) > 1.4) reason = 'non quadrata';
    else if (area < CARD_FILL * rect.area) reason = 'non piena';
    else if (c.x0 <= 0 || c.y0 <= 0 || c.x1 >= w - 1 || c.y1 >= h - 1) reason = 'tocca il bordo';
    else {
      // angoli: i punti dell'inviluppo più vicini agli angoli del rettangolo (seguono la prospettiva), se il
      // quadrilatero che formano copre quasi tutto il rettangolo; altrimenti il rettangolo
      const quad = rect.box.map((p) => hull.reduce((b, q) => ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < (b[0] - p[0]) ** 2 + (b[1] - p[1]) ** 2 ? q : b)));
      return { corners: orderCorners(polyArea(quad) > QUAD_MIN * rect.area ? quad : rect.box) };
    }
  }
  return { reason: reason };
}

// Omografia che porta i 4 punti src nei 4 punti dst (matrice 3×3 per righe).
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {   // eliminazione di Gauss con pivot
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = b.map((v, i) => v / A[i][i]);
  return [x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 1];
}
const applyH = (H, x, y) => { const d = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; };

// Ritaglio raddrizzato (cw × ch) della cartina dagli angoli in px di src, senza il margine ai bordi.
// Restituisce i pixel e l'omografia ritaglio → src.
function warpCard(src, corners) {
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]), [tl, tr, br, bl] = corners;
  const lw = (d(tr, tl) + d(br, bl)) / 2, lh = (d(bl, tl) + d(br, tr)) / 2, k = Math.min(1, CARD_SIDE / Math.max(lw, lh));
  const cw = Math.max(8, Math.round(lw * k)), ch = Math.max(8, Math.round(lh * k)), mw = EDGE_INSET * cw, mh = EDGE_INSET * ch;
  const H = homography([[-mw, -mh], [cw + mw, -mh], [cw + mw, ch + mh], [-mw, ch + mh]], corners);
  // pixel a piena risoluzione della zona della cartina
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
  const X0 = Math.max(0, Math.floor(Math.min.apply(null, xs)) - 2), Y0 = Math.max(0, Math.floor(Math.min.apply(null, ys)) - 2);
  const X1 = Math.min(sw, Math.ceil(Math.max.apply(null, xs)) + 3), Y1 = Math.min(sh, Math.ceil(Math.max.apply(null, ys)) + 3);
  const SW = X1 - X0, SH = Y1 - Y0, c = document.createElement('canvas');
  c.width = SW; c.height = SH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, X0, Y0, SW, SH, 0, 0, SW, SH);
  const S = ctx.getImageData(0, 0, SW, SH).data, out = new ImageData(cw, ch), o = out.data;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let [u, v] = applyH(H, x, y);
      u = Math.min(SW - 1, Math.max(0, u - X0)); v = Math.min(SH - 1, Math.max(0, v - Y0));   // bordi: si ripete l'ultimo pixel
      const u0 = Math.floor(u), v0 = Math.floor(v), u1 = Math.min(SW - 1, u0 + 1), v1 = Math.min(SH - 1, v0 + 1), fu = u - u0, fv = v - v0;
      const i00 = 4 * (v0 * SW + u0), i10 = 4 * (v0 * SW + u1), i01 = 4 * (v1 * SW + u0), i11 = 4 * (v1 * SW + u1), q = 4 * (y * cw + x);
      for (let c2 = 0; c2 < 3; c2++) o[q + c2] = (S[i00 + c2] * (1 - fu) + S[i10 + c2] * fu) * (1 - fv) + (S[i01 + c2] * (1 - fu) + S[i11 + c2] * fu) * fv;
      o[q + 3] = 255;
    }
  }
  return { crop: out, cw: cw, ch: ch, H: H };
}

// ---- Copertura ----
// Strisce senza colore lungo un bordo del ritaglio: fondo o un'altra cartina entrati nel riquadro. Si cercano lato
// per lato, dentro una fascia larga STRIP_SIZE[0], così una striscia resta tale anche se tocca altre zone grigie.
function borderStrips(sat, ok, w, h) {
  const m = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) m[k] = ok[k] && sat[k] < STRIP_NEUTRAL ? 1 : 0;
  const closed = closeMask(m, w, h, 1), out = new Uint8Array(w * h), [wide, long] = STRIP_SIZE;
  const bw = Math.max(1, Math.round(wide * w)), bh = Math.max(1, Math.round(wide * h));
  // fasce: [x0, y0, larghezza, altezza, lato che deve toccare]
  for (const [x0, y0, fw, fh, edge] of [[0, 0, bw, h, 'l'], [w - bw, 0, bw, h, 'r'], [0, 0, w, bh, 't'], [0, h - bh, w, bh, 'b']]) {
    const f = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) f[y * fw + x] = closed[(y0 + y) * w + x0 + x];
    const { lab, comps } = components(f, fw, fh), keep = new Set();
    comps.forEach((c) => {
      if (c.area < 0.003 * w * h || c.area < STRIP_DENSE * (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) return;
      const touches = edge === 'l' ? c.x0 === 0 : edge === 'r' ? c.x1 === fw - 1 : edge === 't' ? c.y0 === 0 : c.y1 === fh - 1;
      const longEnough = edge === 'l' || edge === 'r' ? c.y1 - c.y0 + 1 >= long * h : c.x1 - c.x0 + 1 >= long * w;
      if (touches && longEnough) keep.add(c.id);
    });
    if (keep.size) for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) if (keep.has(lab[y * fw + x])) out[(y0 + y) * w + x0 + x] = 1;
  }
  return out;
}

// Valori per pixel che non dipendono dalla graffetta: v (con la luce locale), livelli di carta e macchie, esclusioni.
function prepareCard(crop, cw, ch, gains, leaf, bgLum) {
  const n = cw * ch, d = crop.data;
  if (gains) for (let i = 0; i < d.length; i += 4) { d[i] = d[i] * gains[0]; d[i + 1] = d[i + 1] * gains[1]; d[i + 2] = d[i + 2] * gains[2]; }
  const sat = new Float32Array(n), lum = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const r = d[4 * k], g = d[4 * k + 1], b = d[4 * k + 2], mx = Math.max(r, g, b);
    lum[k] = mx; sat[k] = (mx - Math.min(r, g, b)) / Math.max(mx, 1);
  }
  const notLeaf = new Uint8Array(n);
  for (let k = 0; k < n; k++) notLeaf[k] = leaf[k] ? 0 : 1;
  const strip = borderStrips(sat, notLeaf, cw, ch), ok = new Uint8Array(n);
  let nOk = 0;
  for (let k = 0; k < n; k++) { ok[k] = notLeaf[k] && !strip[k] ? 1 : 0; nOk += ok[k]; }
  const okSel = (k) => ok[k] === 1;
  const lumRef = bgLum || percentile(pick(lum, okSel), 0.95) || 255;
  let v = new Float32Array(n);
  for (let k = 0; k < n; k++) v[k] = ((d[4 * k] + d[4 * k + 1]) / 2 - d[4 * k + 2]) / lumRef;
  const levels = (v) => {
    const p95 = nOk ? percentile(pick(v, okSel), 0.95) : PAPER_MIN, lim = 0.75 * Math.max(p95, PAPER_MIN);
    const paperPx = new Uint8Array(n);
    let cnt = 0;
    for (let k = 0; k < n; k++) if (ok[k] && v[k] > lim) { paperPx[k] = 1; cnt++; }
    const paper = cnt > 0.05 * nOk ? percentile(pick(v, (k) => paperPx[k] === 1), 0.5) : PAPER_MIN;
    return { paperPx: paperPx, cnt: cnt, paper: Math.max(paper, PAPER_MIN) };
  };
  let L = levels(v);
  const lumPaper = L.cnt ? percentile(pick(lum, (k) => L.paperPx[k] === 1), 0.5) : lumRef;
  if (L.cnt > 0.05 * nOk) {
    // luce zona per zona, dalla carta: in ombra la carta è meno gialla in assoluto, ma non è una macchia
    const sig = LOCAL_LIGHT * Math.min(cw, ch), wp = new Float32Array(n), wl = new Float32Array(n);
    for (let k = 0; k < n; k++) { wp[k] = L.paperPx[k]; wl[k] = L.paperPx[k] * lum[k]; }
    const W = gaussBlur(wp, cw, ch, sig), Lm = gaussBlur(wl, cw, ch, sig);
    for (let k = 0; k < n; k++) {
      const loc = W[k] > 0.05 ? Lm[k] / Math.max(W[k], 1e-6) : lumPaper;
      v[k] /= Math.min(LIGHT_LIMITS[1], Math.max(LIGHT_LIMITS[0], loc / lumPaper));
    }
    L = levels(v);
  }
  // macchia piena: un valore tipico delle macchie sicure (sotto la metà tra carta e STAIN_MAX), non il più estremo
  const sure = pick(v, (k) => ok[k] === 1 && v[k] < (L.paper + STAIN_MAX) / 2);
  const stain = Math.min(sure.length > STAIN_SURE * nOk ? percentile(sure, STAIN_TYPICAL) : STAIN_MAX, STAIN_MAX);
  const glare = new Uint8Array(n), bg = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (ok[k] && sat[k] < GLARE_CHROMA && lum[k] > GLARE_LUM * lumPaper) glare[k] = 1;
    bg[k] = leaf[k] ? 1 : strip[k] ? 5 : glare[k] ? 4 : 0;   // codici della maschera (2 = graffetta)
  }
  return { sat: sat, lum: lum, ok: ok, v: v, paper: L.paper, stain: stain, lumPaper: lumPaper, bg: bg };
}

// Copertura con la graffetta indicata (clip: maschera 0/1), maschera e foto con la graffetta in arancio.
function cardResult(prep, clip) {
  const { cw, ch, v, bg, paper, stain } = prep, n = cw * ch;
  const crop = new ImageData(new Uint8ClampedArray(prep.crop.data), cw, ch);
  const mask = new ImageData(cw, ch), mk = mask.data, top = paper - DEAD_ZONE, span = Math.max(top - stain, 1e-3);
  let valid = 0, sum = 0, clipCount = 0;
  const gValid = new Float32Array(SIG_GRID * SIG_GRID), gStain = new Float32Array(SIG_GRID * SIG_GRID);
  for (let k = 0; k < n; k++) {
    let rgb, code = bg[k];
    if (clip[k] && code !== 1 && code !== 5) { code = 2; clipCount++; }
    if (code === 1) rgb = [190, 214, 178];
    else if (code === 2) {
      rgb = [224, 123, 36];
      for (let c = 0; c < 3; c++) crop.data[4 * k + c] = Math.round(0.45 * crop.data[4 * k + c] + 0.55 * rgb[c]);
    } else if (code === 4) rgb = [150, 200, 240];
    else if (code === 5) rgb = [200, 170, 220];
    else {
      const f = Math.min(1, Math.max(0, (top - v[k]) / span)), g = Math.round(255 - 220 * f);
      valid++; sum += f; rgb = [g, g, g];
      const cell = Math.min(SIG_GRID - 1, Math.floor((k / cw | 0) * SIG_GRID / ch)) * SIG_GRID + Math.min(SIG_GRID - 1, Math.floor((k % cw) * SIG_GRID / cw));
      gValid[cell]++; gStain[cell] += f;
    }
    mk[4 * k] = rgb[0]; mk[4 * k + 1] = rgb[1]; mk[4 * k + 2] = rgb[2]; mk[4 * k + 3] = 255;
  }
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const octx = out.getContext('2d');
  octx.putImageData(crop, 0, 0);
  const cropUrl = out.toDataURL('image/jpeg', 0.9);
  octx.putImageData(mask, 0, 0);
  const maskUrl = out.toDataURL('image/png');
  const cellN = n / (SIG_GRID * SIG_GRID);
  const sig = Array.from(gValid, (c, g) => (c < SIG_MIN_VALID * cellN ? '-' : Math.min(35, Math.round(35 * gStain[g] / c)).toString(36))).join('');
  return { coverage: valid ? 100 * sum / valid : 0, clipFrac: 100 * clipCount / n, cropUrl: cropUrl, maskUrl: maskUrl, sig: sig, hash: prep.hash };
}

// ---- Graffetta ----
// Arrotondamento come round() di Python (metà al pari), per avere gli stessi segmenti di prova.
function roundEven(x) { const f = Math.floor(x), d = x - f; return d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1); }
// Per ogni inclinazione: i pixel del segmento di prova e delle due righe ai suoi lati (scostamenti, senza doppioni).
function clipSegments(side) {
  const L = Math.max(5, Math.round(CLIP_SEG * side)), off = Math.max(2, Math.round(CLIP_SIDES * side)), out = [];
  for (let k = 0; k < CLIP_ANGLES; k++) {
    const t = Math.PI * k / CLIP_ANGLES, ca = Math.cos(t), sa = Math.sin(t), seg = new Map(), sides = new Map();
    for (let i = 0; i <= 2 * L; i++) {
      const u = -L / 2 + i * L / (2 * L);
      const p = [roundEven(u * ca), roundEven(u * sa)]; seg.set(p.join(), p);
      for (const g of [-1, 1]) { const q = [roundEven(u * ca - g * off * sa), roundEven(u * sa + g * off * ca)]; sides.set(q.join(), q); }
    }
    out.push([Int32Array.from([].concat(...seg.values())), Int32Array.from([].concat(...sides.values()))]);
  }
  return out;
}
// Media di m sui pixel indicati intorno a (x, y) (pts: [dx0, dy0, dx1, dy1, …]); fuori dall'immagine conta 0.
// Si ferma appena non può più arrivare a min (-1).
function clipMean(m, w, h, x, y, pts, min) {
  const n = pts.length / 2, need = min * n;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const xx = x + pts[2 * i], yy = y + pts[2 * i + 1];
    if (xx >= 0 && yy >= 0 && xx < w && yy < h) s += m[yy * w + xx];
    if (s + n - 1 - i < need) return -1;
  }
  return s / n;
}
// Asse principale di un insieme di pixel (indici k = y·w + x): centro, direzione, estensione lungo l'asse.
function clipAxis(idx, w) {
  let sx = 0, sy = 0;
  for (const k of idx) { sx += k % w; sy += (k / w) | 0; }
  const mx = sx / idx.length, my = sy / idx.length;
  let cxx = 0, cyy = 0, cxy = 0;
  for (const k of idx) { const dx = k % w - mx, dy = ((k / w) | 0) - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
  const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy), d = [Math.cos(ang), Math.sin(ang)];
  let u0 = Infinity, u1 = -Infinity;
  for (const k of idx) { const u = (k % w - mx) * d[0] + (((k / w) | 0) - my) * d[1]; if (u < u0) u0 = u; if (u > u1) u1 = u; }
  return { c: [mx, my], d: d, u: [u0, u1] };
}
const clipBlue = (r, g, b) => (b - (r + g) / 2) / (Math.max(r, g, b) + 1);

// Maschera della graffetta sul ritaglio (0/1, cw × ch; tutta 0 se non la trova).
// zone: maschera 0/1 della zona cerchiata dall'operatore (ricerca solo lì, soglie più larghe), null = automatica.
function findClip(prep, zone) {
  const { cw, ch, ok } = prep, px = prep.crop.data;
  const full = zone ? CLIP_GUIDED.full : CLIP_FULL, odd = zone ? CLIP_GUIDED.odd : CLIP_ODD, len = zone ? CLIP_GUIDED.len : CLIP_LEN;
  const sc = Math.min(1, CLIP_GRID / Math.max(cw, ch)), gw = Math.round(cw * sc), gh = Math.round(ch * sc), gn = gw * gh, side = Math.min(gw, gh);
  // copia ridotta (media dei pixel di ogni cella) e zone valide
  const g = new Float32Array(3 * gn), cnt = new Float32Array(gn), gok = new Uint8Array(gn), gzone = new Uint8Array(gn);
  for (let y = 0; y < ch; y++) {
    const gy = Math.min(gh - 1, Math.floor(y * gh / ch));
    for (let x = 0; x < cw; x++) {
      const q = gy * gw + Math.min(gw - 1, Math.floor(x * gw / cw)), k = y * cw + x;
      g[3 * q] += px[4 * k]; g[3 * q + 1] += px[4 * k + 1]; g[3 * q + 2] += px[4 * k + 2]; cnt[q]++;
    }
  }
  for (let q = 0; q < gn; q++) for (let c = 0; c < 3; c++) g[3 * q + c] /= Math.max(1, cnt[q]);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const k = Math.min(ch - 1, Math.floor(y * ch / gh)) * cw + Math.min(cw - 1, Math.floor(x * cw / gw));
    gok[y * gw + x] = ok[k]; if (zone) gzone[y * gw + x] = zone[k];
  }
  // colori di carta e macchia: i pixel più gialli e quelli più blu della cartina
  let nOk = 0;
  for (let q = 0; q < gn; q++) nOk += gok[q];
  const use = (q) => nOk > 100 ? gok[q] === 1 : true;
  const lum = [], v = new Float32Array(gn);
  for (let q = 0; q < gn; q++) if (use(q)) lum.push(Math.max(g[3 * q], g[3 * q + 1], g[3 * q + 2]));
  const lref = Math.max(1, percentile(lum, 0.95) || 255);
  const vs = [];
  for (let q = 0; q < gn; q++) { v[q] = ((g[3 * q] + g[3 * q + 1]) / 2 - g[3 * q + 2]) / lref; if (use(q)) vs.push(v[q]); }
  const hi = percentile(vs, 0.8), lo = percentile(vs, 0.015);
  const median = (sel, c) => percentile(pick(Array.from({ length: gn }, (_, q) => g[3 * q + c]), sel), 0.5);
  const P = [0, 1, 2].map((c) => median((q) => use(q) && v[q] > hi, c));
  let Q = [0, 1, 2].map((c) => median((q) => use(q) && v[q] < lo, c));
  if (clipBlue(Q[0], Q[1], Q[2]) < 0.05) Q = [0.32, 0.30, 0.55].map((f) => f * Math.max(P[0], P[1], P[2]));   // poche macchie o non blu
  // luce del pixel = a + b, con (a, b) dai minimi quadrati su carta e macchia
  const a11 = P[0] * P[0] + P[1] * P[1] + P[2] * P[2], a12 = P[0] * Q[0] + P[1] * Q[1] + P[2] * Q[2], a22 = Q[0] * Q[0] + Q[1] * Q[1] + Q[2] * Q[2];
  const det = a11 * a22 - a12 * a12 || 1e-6, light = new Float32Array(gn);
  for (let q = 0; q < gn; q++) {
    const r = g[3 * q], gg = g[3 * q + 1], b = g[3 * q + 2];
    const bp = P[0] * r + P[1] * gg + P[2] * b, bq = Q[0] * r + Q[1] * gg + Q[2] * b;
    light[q] = ((a22 * bp - a12 * bq) + (a11 * bq - a12 * bp)) / det;
  }
  const loc = gaussBlur(light, gw, gh, CLIP_LIGHT * side), rel = new Float32Array(gn), B = new Uint8Array(gn);
  const e = Math.max(1, Math.round(CLIP_EDGE * side));
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const q = y * gw + x;
    rel[q] = light[q] / Math.max(loc[q], 0.05);
    B[q] = gok[q] && Math.abs(Math.log(Math.max(rel[q], 0.05))) > odd && x >= e && y >= e && x < gw - e && y < gh - e && (!zone || gzone[q]) ? 1 : 0;
  }
  // centri dei tratti dritti: segmento quasi tutto anomalo, righe ai lati no. Prima un filtro veloce: intorno
  // al punto ci devono essere almeno tanti pixel anomali quanti ne chiede il segmento.
  const segs = clipSegments(side), line = new Uint8Array(gn), R = Math.ceil(Math.round(CLIP_SEG * side) / 2) + 1;
  const segN = Math.min(...segs.map((q) => q[0].length / 2)), W1 = gw + 1, sum = new Int32Array(W1 * (gh + 1));
  for (let y = 0; y < gh; y++) { let row = 0; for (let x = 0; x < gw; x++) { row += B[y * gw + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; } }
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const x0 = Math.max(0, x - R), x1 = Math.min(gw, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(gh, y + R + 1);
    if (sum[y1 * W1 + x1] - sum[y0 * W1 + x1] - sum[y1 * W1 + x0] + sum[y0 * W1 + x0] < full * segN - 1) continue;
    for (const [seg, sides] of segs) {
      if (clipMean(B, gw, gh, x, y, seg, full) < full) continue;
      if (clipMean(B, gw, gh, x, y, sides, 0) <= CLIP_SIDES_MAX) { line[y * gw + x] = 1; break; }
    }
  }
  const { lab, comps } = components(dilate(line, gw, gh, 1), gw, gh);
  const bP = clipBlue(P[0], P[1], P[2]), bQ = clipBlue(Q[0], Q[1], Q[2]), seg = Math.round(CLIP_SIDES * side), lim = CLIP_SIDE * side;
  const sin12 = Math.sin(12 * Math.PI / 180), pieces = [];
  const members = comps.map(() => []);
  for (let q = 0; q < gn; q++) if (lab[q] >= 0) members[lab[q]].push(q);
  comps.forEach((c, i) => {
    const idx = members[i];
    if (idx.length < 5) return;
    const ax = clipAxis(idx, gw), L = ax.u[1] - ax.u[0] + CLIP_SEG * side;   // i centri non arrivano alle punte
    // colore della parte scura vicino al tratto: tra carta (0) e macchia (1)
    const mk = new Uint8Array(gn); idx.forEach((q) => { mk[q] = 1; });
    const near = dilateDisc(mk, gw, gh, seg), blues = [];
    for (let q = 0; q < gn; q++) if (near[q] && rel[q] < 0.75) blues.push(clipBlue(g[3 * q], g[3 * q + 1], g[3 * q + 2]));
    const col = blues.length > 3 ? (percentile(blues, 0.5) - bP) / Math.max(bQ - bP, 1e-3) : 0;
    const horiz = Math.abs(ax.d[1]) < sin12, vert = Math.abs(ax.d[0]) < sin12;
    const edge = (horiz && Math.min(c.y0, gh - 1 - c.y1) <= lim) || (vert && Math.min(c.x0, gw - 1 - c.x1) <= lim);   // bordo della cartina
    if (col <= CLIP_BLUE && !edge) pieces.push(Object.assign(ax, { L: L }));
  });
  const good = pieces.filter((k) => k.L >= len[0] * side && k.L <= len[1] * side);
  let out = new Uint8Array(gn);
  if (good.length) {
    const best = good.reduce((m, k) => (k.L > m.L ? k : m)), keep = [best], nrm = [-best.d[1], best.d[0]];
    pieces.forEach((k) => {   // altri pezzi della stessa graffetta: allineati e vicini (le gambe, un riflesso in mezzo)
      if (k === best) return;
      const dv = [k.c[0] - best.c[0], k.c[1] - best.c[1]];
      if (Math.abs(dv[0] * best.d[0] + dv[1] * best.d[1]) <= (best.L + k.L) / 2 + CLIP_JOIN[0] * side &&
          Math.abs(dv[0] * nrm[0] + dv[1] * nrm[1]) <= CLIP_JOIN[1] * side &&
          Math.abs(k.d[0] * best.d[0] + k.d[1] * best.d[1]) >= Math.cos(35 * Math.PI / 180)) keep.push(k);
    });
    const half = Math.max(1, Math.round(CLIP_HALF * side)), bar = new Uint8Array(gn);
    keep.forEach((k) => {   // la barra intera lungo l'asse
      const ext = CLIP_SEG * side / 2, u0 = k.u[0] - ext, u1 = k.u[1] + ext;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const dx = x - k.c[0], dy = y - k.c[1], u = Math.min(u1, Math.max(u0, dx * k.d[0] + dy * k.d[1]));
        const ex = dx - u * k.d[0], ey = dy - u * k.d[1];
        if (ex * ex + ey * ey <= (half + 0.5) * (half + 0.5)) bar[y * gw + x] = 1;
      }
    });
    // più i pixel anomali attaccati alla barra (punte piegate), non oltre una mezza larghezza
    const zb = dilateDisc(bar, gw, gh, half), core = new Uint8Array(gn);
    for (let q = 0; q < gn; q++) core[q] = bar[q] || (B[q] && zb[q]) ? 1 : 0;
    const cc = components(core, gw, gh), hit = new Set();
    for (let q = 0; q < gn; q++) if (bar[q]) hit.add(cc.lab[q]);
    for (let q = 0; q < gn; q++) out[q] = core[q] && hit.has(cc.lab[q]) && zb[q] ? 1 : 0;
    out = dilateDisc(out, gw, gh, Math.max(1, Math.round(CLIP_BUFFER * side)));
  }
  const res = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    res[y * cw + x] = out[Math.min(gh - 1, Math.floor(y * gh / ch)) * gw + Math.min(gw - 1, Math.floor(x * gw / cw))] && ok[y * cw + x] ? 1 : 0;
  }
  return res;
}

// Zona indicata dall'operatore (poligono in pixel del ritaglio) come maschera 0/1.
function polygonMask(poly, cw, ch) {
  const out = new Uint8Array(cw * ch);
  if (!poly || poly.length < 3) return out;
  for (let y = 0; y < ch; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      if ((y1 <= yc) !== (y2 <= yc)) xs.push(x1 + (yc - y1) * (x2 - x1) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x <= Math.min(cw - 1, Math.floor(xs[i + 1] - 0.5)); x++) out[y * cw + x] = 1;
    }
  }
  return out;
}

// Graffetta cerchiata dall'operatore (poligono in pixel del ritaglio): { clip, found }. Se lì non trova una graffetta,
// clip è vuota e la pagina propone di escludere tutta la zona (polygonMask).
function clipZones(prep, poly) {
  if (!poly) return { clip: prep.autoClip, found: prep.autoClip.some((v) => v) };
  const clip = findClip(prep, polygonMask(poly, prep.cw, prep.ch));
  return { clip: clip, found: clip.some((v) => v) };
}

const NOT_FOUND = 'Non trovo la cartina. Prova ad avvicinarti e a metterla al centro del riquadro.';

// src: video, canvas o immagine; region: parte di src da considerare (il riquadro guida), in px di src.
function analyzeCard(src, region) {
  const scale = Math.min(1, MAX_SIDE / Math.max(region.w, region.h));
  const w = Math.round(region.w * scale), h = Math.round(region.h * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, region.x, region.y, region.w, region.h, 0, 0, w, h);
  const small = ctx.getImageData(0, 0, w, h).data;
  const leaf = leafZones(small, w, h);
  const bgInfo = borderBalance(small, leaf, w, h), gains = bgInfo && bgInfo.gains;
  if (gains) for (let i = 0; i < small.length; i += 4) { small[i] *= gains[0]; small[i + 1] *= gains[1]; small[i + 2] *= gains[2]; }

  let found = null;
  for (const d of FIND_DIFF) if ((found = findCard(small, leaf, w, h, bgInfo && bgInfo.lum, d)).corners) break;
  if (!found.corners) return { error: NOT_FOUND, reason: found.reason };

  // ritaglio raddrizzato dall'originale, a risoluzione più alta di quella su cui si è cercata la cartina
  const corners = found.corners.map(([x, y]) => [region.x + x / scale, region.y + y / scale]);
  const { crop, cw, ch, H } = warpCard(src, corners);
  const n = cw * ch, cleaf = new Uint8Array(n);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const [u, v] = applyH(H, x, y);
    const lx = Math.min(w - 1, Math.max(0, Math.round((u - region.x) * scale))), ly = Math.min(h - 1, Math.max(0, Math.round((v - region.y) * scale)));
    cleaf[y * cw + x] = leaf[ly * w + lx];
  }
  if (n - cleaf.reduce((a, v) => a + v, 0) < 0.3 * n) return { error: NOT_FOUND, reason: 'foglia' };
  let hash = 2166136261;   // FNV-1a su un pixel ogni 7: stesso file caricato due volte, stessi pixel
  for (let k = 0; k < crop.data.length; k += 28) { hash ^= crop.data[k] ^ (crop.data[k + 1] << 8) ^ (crop.data[k + 2] << 16); hash = Math.imul(hash, 16777619); }
  const p = prepareCard(crop, cw, ch, gains, cleaf, bgInfo && bgInfo.lum);
  const prep = Object.assign(p, { crop: crop, cw: cw, ch: ch, hash: cw + 'x' + ch + ':' + (hash >>> 0).toString(36) });
  prep.autoClip = findClip(prep, null);
  prep.sharp = sharpness(crop, cw, ch);
  // box: dove è stata trovata la cartina, in pixel dell'immagine originale (angoli, rettangolo diritto che la
  // contiene e bilanciamento usato), per la taratura del ritaglio
  const xs = corners.map((q) => q[0]), ys = corners.map((q) => q[1]);
  const box = { x: Math.round(Math.min.apply(null, xs)), y: Math.round(Math.min.apply(null, ys)),
    w: Math.round(Math.max.apply(null, xs) - Math.min.apply(null, xs)), h: Math.round(Math.max.apply(null, ys) - Math.min.apply(null, ys)),
    angoli: corners.map((q) => [Math.round(q[0]), Math.round(q[1])]), bilanciamento: gains ? gains.map((g) => Math.round(g * 100) / 100) : null };
  return { prep: prep, result: Object.assign(cardResult(prep, prep.autoClip), { sharp: prep.sharp }), box: box };
}

// Nitidezza del ritaglio (vedi SHARP_MIN): rapporto tra gradiente fine e gradiente dopo una sfocatura, sui bordi forti.
function sharpness(crop, cw, ch) {
  const s = SHARP_SIDE / Math.max(cw, ch), w = Math.round(cw * s), h = Math.round(ch * s);
  const src = document.createElement('canvas'); src.width = cw; src.height = ch; src.getContext('2d').putImageData(crop, 0, 0);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) g[k] = d[4 * k + 2] - (d[4 * k] + d[4 * k + 1]) / 2;   // blu − giallo: le macchie
  const grad = (m) => {
    const out = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const k = y * w + x, a = m[k - w - 1], b = m[k - w], cc = m[k - w + 1], dd = m[k - 1], f = m[k + 1], gg = m[k + w - 1], hh = m[k + w], ii = m[k + w + 1];
      out[k] = Math.hypot(cc + 2 * f + ii - a - 2 * dd - gg, gg + 2 * hh + ii - a - 2 * b - cc);
    }
    return out;
  };
  const fine = grad(g), coarse = grad(gaussBlur(g, w, h, SHARP_BLUR)), mg = Math.round(0.06 * SHARP_SIDE), cs = [];
  for (let y = mg; y < h - mg; y++) for (let x = mg; x < w - mg; x++) cs.push(coarse[y * w + x]);
  const lim = percentile(cs, 0.9), ratios = [];
  for (let y = mg; y < h - mg; y++) for (let x = mg; x < w - mg; x++) { const k = y * w + x; if (coarse[k] > lim && coarse[k] > 1e-3) ratios.push(fine[k] / coarse[k]); }
  return ratios.length > 50 ? percentile(ratios, 0.5) : null;
}

// Cartina ritagliata a mano (4 angoli in pixel di src, in senso orario da in alto a sinistra), per esempio in una
// zona di scheda dove il ritaglio automatico è dubbio. Bilanciamento sulla carta bianca della scheda: i pixel con
// tutti i canali più alti (come colore_carta in tools/analisi_schede.py). → { prep, result } come analyzeCard.
function analyzeQuad(src, corners) {
  const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
  const sc = Math.min(1, MAX_SIDE / Math.max(sw, sh)), w = Math.round(sw * sc), h = Math.round(sh * sc);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, mins = [];
  for (let k = 0; k < w * h; k++) mins.push(Math.min(d[4 * k], d[4 * k + 1], d[4 * k + 2]));
  const lim = percentile(mins, 0.9), sel = (k) => mins[k] >= lim;
  const paper = [0, 1, 2].map((ch) => percentile(pick(Array.from({ length: w * h }, (_, k) => d[4 * k + ch]), sel), 0.5));
  const m = (paper[0] + paper[1] + paper[2]) / 3, clamp = (v) => Math.min(1.6, Math.max(0.6, v));
  const gains = Math.max(...paper) > 50 ? paper.map((v) => clamp(m / Math.max(v, 1))) : null;
  const lum = gains ? Math.max(paper[0] * gains[0], paper[1] * gains[1], paper[2] * gains[2]) : null;
  const { crop, cw, ch } = warpCard(src, corners);
  const p = prepareCard(crop, cw, ch, gains, new Uint8Array(cw * ch), lum);
  const prep = Object.assign(p, { crop: crop, cw: cw, ch: ch, hash: 'quad' });
  prep.autoClip = findClip(prep, null);
  return { prep: prep, result: cardResult(prep, prep.autoClip) };
}

// ---- Stessa cartina due volte ----
// Impronta: densità delle macchie in una griglia SIG_GRID × SIG_GRID ('0'…'z', '-' = zona esclusa, foglia o graffetta).
// Due foto della stessa cartina hanno le macchie negli stessi punti, anche su sfondi diversi e girate di 90°.
// Si confronta il disegno delle macchie (meno la media dei dintorni), senza il bordo, con piccoli spostamenti e le 4
// rotazioni. Cartine quasi pulite o quasi tutte macchiate hanno un disegno piatto: per quelle si confronta solo
// l'immagine identica (e comunque l'avviso lascia sempre proseguire). Impronte di un'altra versione: nessun confronto.
function sigPrep(sig) {
  const G = SIG_GRID;
  if (!sig || sig.length !== G * G) return null;
  const v = Array.from(sig, (ch) => (ch === '-' ? null : parseInt(ch, 36) / 35)), n = G - 2 * SIG_BORDER, out = new Array(n * n).fill(null);
  for (let y = SIG_BORDER; y < G - SIG_BORDER; y++) for (let x = SIG_BORDER; x < G - SIG_BORDER; x++) {
    const c = v[y * G + x];
    if (c == null) continue;
    let a = 0, m = 0;
    for (let yy = Math.max(0, y - SIG_LOCAL); yy <= Math.min(G - 1, y + SIG_LOCAL); yy++) {
      for (let xx = Math.max(0, x - SIG_LOCAL); xx <= Math.min(G - 1, x + SIG_LOCAL); xx++) {
        const q = v[yy * G + xx];
        if (q != null) { a += q; m++; }
      }
    }
    out[(y - SIG_BORDER) * n + x - SIG_BORDER] = c - a / m;
  }
  const ok = out.filter((x) => x != null), mean = ok.reduce((s, x) => s + x, 0) / Math.max(1, ok.length);
  const spread = Math.sqrt(ok.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, ok.length));
  return spread < SIG_MIN_SPREAD ? null : { v: out, n: n };
}
function sigRotate(v, n) {   // 90° in senso antiorario, come np.rot90
  const out = new Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[(n - 1 - x) * n + y] = v[y * n + x];
  return out;
}
// Correlazione tra a e b spostata di (dx, dy) sulla parte in comune; null se le celle valide sono meno della metà.
function sigCorr(a, b, n, dx, dy) {
  const x0 = Math.max(0, dx), x1 = n + Math.min(0, dx), y0 = Math.max(0, dy), y1 = n + Math.min(0, dy), pa = [], pb = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = a[y * n + x], q = b[(y - dy) * n + x - dx];
    if (p != null && q != null) { pa.push(p); pb.push(q); }
  }
  if (pa.length < 0.5 * (x1 - x0) * (y1 - y0)) return null;
  const ma = pa.reduce((s, x) => s + x, 0) / pa.length, mb = pb.reduce((s, x) => s + x, 0) / pb.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < pa.length; i++) { const da = pa[i] - ma, db = pb[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : null;
}
// Somiglianza tra due impronte: la correlazione migliore tra rotazioni e spostamenti (−1…1), null se non si può dire.
function sigSimilarity(a, b) {
  const A = sigPrep(a), Bp = sigPrep(b);
  if (!A || !Bp) return null;
  let vb = Bp.v, best = null;
  for (let r = 0; r < 4; r++, vb = sigRotate(vb, A.n)) {
    for (let dy = -SIG_SHIFT; dy <= SIG_SHIFT; dy++) for (let dx = -SIG_SHIFT; dx <= SIG_SHIFT; dx++) {
      const c = sigCorr(A.v, vb, A.n, dx, dy);
      if (c != null && (best == null || c > best)) best = c;
    }
  }
  return best;
}
// La cartina già presente che somiglia di più a questa: { id, kind: 'same' (stessa immagine) | 'similar' }, o null.
function findDuplicate(card, others) {
  let found = null;
  others.forEach((o) => {
    if (o.id === card.id) return;
    if (card.hash && o.hash === card.hash) { found = { id: o.id, kind: 'same', score: 1 }; return; }
    if (found && found.kind === 'same') return;
    const sim = sigSimilarity(card.sig, o.sig);
    if (sim != null && sim >= DUP_SIMILAR && (!found || sim > found.score)) found = { id: o.id, kind: 'similar', score: sim };
  });
  return found ? Object.assign(found, { ok: false }) : null;
}

// Parametri dell'analisi, salvati con i dati di taratura.
const ANALISI_PARAMETRI = { GUIDE, MAX_SIDE, BG_RING, BG_MAX_CHROMA, FIND_DIFF, FIND_CLOSE, CARD_FILL, QUAD_MIN, CARD_MIN, LEAF_GR, LEAF_WIN,
  LEAF_FRAC, EDGE_INSET, CARD_SIDE, PAPER_MIN, STAIN_MAX, STAIN_SURE, STAIN_TYPICAL, DEAD_ZONE, LOCAL_LIGHT, LIGHT_LIMITS, STRIP_NEUTRAL, STRIP_SIZE, STRIP_DENSE, GLARE_CHROMA,
  GLARE_LUM, CLIP_GRID, CLIP_LIGHT, CLIP_ODD, CLIP_SEG, CLIP_SIDES, CLIP_ANGLES, CLIP_FULL, CLIP_SIDES_MAX, CLIP_LEN, CLIP_BLUE, CLIP_EDGE,
  CLIP_SIDE, CLIP_JOIN, CLIP_HALF, CLIP_BUFFER, CLIP_GUIDED, SHARP_SIDE, SHARP_BLUR, SHARP_MIN, SIG_GRID, SIG_MIN_VALID, SIG_LOCAL, SIG_BORDER, SIG_SHIFT, SIG_MIN_SPREAD, DUP_SIMILAR };
