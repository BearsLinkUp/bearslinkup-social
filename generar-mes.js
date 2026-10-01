#!/usr/bin/env node
/**
 * BEARS LINKUP — Generador MENSUAL
 * --------------------------------
 * Corre dentro de GitHub Actions. Nadie lo ejecuta a mano.
 *
 * De punta a punta, para el mes que toca:
 *   1. Plan: usa mes/AAAA-MM/plan.json si existe. Si no, lo escribe un LLM
 *      (por fal / openrouter) siguiendo marca/reglas.md y sin repetir ganchos.
 *   2. Fotos con Seedream V4. Pide 2 candidatas por foto y una IA de visión
 *      revisa careta, texto, manos y look de IA. Si ninguna pasa, repite una vez.
 *   3. Clips: foto de Seedream revisada + Veo 3.1 Fast la anima (6 s, con audio).
 *      Un clip con "pantalla" monta la captura real de la app en el celular.
 *   4. Monta titular + logo con Chromium: A oscura (carrusel y reel),
 *      B clara (imagen de viernes). Minimalista: un titular y la marca.
 *   5. Edita los reels con ffmpeg: clips + subtítulo por clip + cierre de marca.
 *   6. Escribe mes/AAAA-MM/manifest.json. Una tarea de Claude lo lee y
 *      programa todo en Metricool.
 *
 * Es reanudable: cada pieza terminada queda en el manifiesto y una corrida
 * nueva no la vuelve a pagar. --solo=03,07 regenera solo esas.
 *
 * VARIABLES:
 *   FAL_KEY        obligatoria
 *   MODELO_IMAGEN  por defecto fal-ai/bytedance/seedream/v4/text-to-image
 *   MODELO_VIDEO   por defecto fal-ai/veo3.1/fast/image-to-video (anima la foto de Seedream)
 *   RES_VIDEO      por defecto 1080p ($0.15/s con audio)
 *   MODELO_LLM     por defecto anthropic/claude-sonnet-5
 *   MODELO_QA      por defecto google/gemini-2.5-flash
 *
 * USO:
 *   node generar-mes.js                 → el mes que toca
 *   node generar-mes.js --mes=2026-11   → fuerza un mes
 *   node generar-mes.js --solo=03,07    → regenera solo esas piezas
 *   node generar-mes.js --solo-plan     → escribe el plan y para
 *   node generar-mes.js --remontar      → re-monta sobre las crudas, gratis
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FAL = 'https://queue.fal.run';
const { FAL_KEY } = process.env;
const MODELO_IMAGEN = process.env.MODELO_IMAGEN || 'fal-ai/bytedance/seedream/v4/text-to-image';
// Video: Veo 3.1 Fast animando una foto de Seedream ya revisada (image-to-video).
// La foto fija la apariencia real de antorchas y piezas; Veo solo le da movimiento suave.
const MODELO_VIDEO = process.env.MODELO_VIDEO || 'fal-ai/veo3.1/fast/image-to-video';
const RES_VIDEO = process.env.RES_VIDEO || '1080p';
const SEG_CLIP = 6;
const MODELO_LLM = process.env.MODELO_LLM || 'anthropic/claude-sonnet-5';
const MODELO_QA = process.env.MODELO_QA || 'google/gemini-2.5-flash';
const REPO = process.env.GITHUB_REPOSITORY || 'BearsLinkUp/bearslinkup-social';
const RAMA = process.env.GITHUB_REF_NAME || 'main';

const args = process.argv.slice(2);
const arg = n => (args.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || '';
const mesArg = arg('mes');
const soloArg = arg('solo');
const soloIds = soloArg ? new Set(soloArg.split(',').map(s => s.trim().padStart(2, '0'))) : null;
const soloPlan = args.includes('--solo-plan');
const remontar = args.includes('--remontar');

const TMP = '.tmp-mes';
// Tope de gasto por corrida (USD). Las repeticiones por QA se cortan al llegar.
const PRESUPUESTO = Number(process.env.PRESUPUESTO || 20);
let gastado = 0;
const PRECIO_FOTO = 0.03;
const PRECIO_SEG = { '720p': 0.15, '1080p': 0.15, '4k': 0.35 }; // Veo 3.1 Fast con audio
const hayPresupuesto = extra => gastado + extra <= PRESUPUESTO;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// El logo NUNCA se genera con IA. Vive en marca/logo.b64 (webp en base64).
const LOGO = fs.existsSync('marca/logo.b64')
  ? `data:image/webp;base64,${fs.readFileSync('marca/logo.b64', 'utf8').trim()}`
  : null;

// ─────────────────────────── Fechas (AST, UTC-4 todo el año) ───────────────────────────

function hoyAST() { return new Date(Date.now() - 4 * 3600e3); }
const ymd = d => d.toISOString().slice(0, 10);
function mesSiguiente(m) { const [a, b] = m.split('-').map(Number); return b === 12 ? `${a + 1}-01` : `${a}-${String(b + 1).padStart(2, '0')}`; }
function mesAnterior(m) { const [a, b] = m.split('-').map(Number); return b === 1 ? `${a - 1}-12` : `${a}-${String(b - 1).padStart(2, '0')}`; }

/** Lunes carrusel 12pm · miércoles reel 7pm · viernes imagen 12pm, en AST. */
const SLOTS = { 1: { tipo: 'carrusel', hora: '12:00' }, 3: { tipo: 'reel', hora: '19:00' }, 5: { tipo: 'imagen', hora: '12:00' } };

function slotsDelMes(mes, despuesDe) {
  const [a, b] = mes.split('-').map(Number);
  const out = [];
  const ahora = hoyAST().toISOString().slice(0, 16);
  for (let d = 1; d <= 31; d++) {
    const f = new Date(Date.UTC(a, b - 1, d));
    if (f.getUTCMonth() !== b - 1) break;
    const s = SLOTS[f.getUTCDay()];
    if (!s) continue;
    const local = `${ymd(f)}T${s.hora}`;
    if (despuesDe && local <= despuesDe) continue;
    if (local <= ahora) continue;
    out.push({ fecha: `${local}:00-04:00`, tipo: s.tipo });
  }
  return out;
}

// ─────────────────────────── fal ───────────────────────────

async function fal(ruta, metodo = 'GET', cuerpo = null, intentos = 4) {
  const url = ruta.startsWith('http') ? ruta : `${FAL}${ruta}`;
  let ultimo;
  for (let n = 1; n <= intentos; n++) {
    let r;
    try {
      r = await fetch(url, {
        method: metodo,
        headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
    } catch (e) {
      ultimo = e;
      if (n === intentos) break;
      log(`   · red falló (${e.message}). Reintento ${n}`);
      await sleep(2000 * n);
      continue;
    }
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
    if (!r.ok) throw new Error(`fal ${r.status} en ${ruta}: ${txt.slice(0, 300)}`);
    return j;
  }
  throw new Error(`fal sin respuesta en ${ruta}: ${ultimo && ultimo.message}`);
}

/** Encola, espera y devuelve el resultado. */
async function correr(modelo, cuerpo, maxMin = 15) {
  const j = await fal(`/${modelo}`, 'POST', cuerpo);
  const estado = j.status_url || `/${modelo}/requests/${j.request_id}/status`;
  const resultado = j.response_url || `/${modelo}/requests/${j.request_id}`;
  const limite = Date.now() + maxMin * 60000;
  while (Date.now() < limite) {
    const s = await fal(estado);
    if (s.status === 'COMPLETED') return fal(resultado);
    if (s.status === 'FAILED' || s.status === 'ERROR') throw new Error(`${modelo} falló: ${JSON.stringify(s).slice(0, 300)}`);
    await sleep(5000);
  }
  throw new Error(`Timeout en ${modelo}`);
}

async function bajar(url, destino) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude bajar ${url}: ${r.status}`);
  fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
  return destino;
}

async function llm(system, prompt, maxTokens = 16000) {
  const r = await correr('openrouter/router', { model: MODELO_LLM, system_prompt: system, prompt, max_tokens: maxTokens, temperature: 0.8 }, 10);
  return r.output || '';
}

/** Sube un archivo local al CDN de fal para que la IA de visión lo pueda ver. */
async function subirFal(archivo, tipo) {
  try {
    const ini = await fal('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', 'POST',
      { content_type: tipo, file_name: path.basename(archivo) });
    const put = await fetch(ini.upload_url, { method: 'PUT', headers: { 'Content-Type': tipo }, body: fs.readFileSync(archivo) });
    if (!put.ok) throw new Error(`PUT ${put.status}`);
    return ini.file_url;
  } catch (e) {
    log(`   · no pude subir a fal (${e.message.slice(0, 120)}); uso data URI`);
    return `data:${tipo};base64,${fs.readFileSync(archivo).toString('base64')}`;
  }
}

// ─────────────────────────── Revisión por visión ───────────────────────────

const QA_SISTEMA = `You are a strict photo editor for a welding-trade brand. You reject images that would embarrass the brand.
Answer ONLY with JSON: {"ok": true|false, "problemas": ["short reason", ...], "nota": 0-10}
Reject (ok=false) if ANY of these is true:
1. A human face is visible while an arc, spark, weld glow or lit torch is visible, or while a torch/electrode holder is in the hands.
2. Someone is welding with the helmet up or without eye protection.
3. Bare hands or bare forearms near hot metal or welding.
4. Clearly readable letters, words, numbers, logos or watermarks anywhere (tiny illegible marks are fine).
5. Deformed or extra fingers, melted or impossible objects, warped geometry.
6. It looks like AI or a 3D render: plastic skin, over-glossy, fake cinematic grading, colored neon light.
7. The image does not show what was requested.
8. A welding torch, MIG gun or electrode holder looks fake, toy-like, melted, oversized or physically impossible, or has no cable/hose attached, or someone appears to weld with no machine connected.
9. A weld bead is in a place that makes no sense (for example on the open end of a pipe instead of at the joint).
"nota" is how real and premium it looks (10 = indistinguishable from a real documentary photo).`;

async function revisar(urlImagen, pedido) {
  try {
    const r = await correr('openrouter/router/vision', {
      model: MODELO_QA, system_prompt: QA_SISTEMA, image_urls: [urlImagen], temperature: 0,
      prompt: `Requested scene: ${pedido}\nReview the image. JSON only.`, max_tokens: 400,
    }, 5);
    const m = (r.output || '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (!j || typeof j.ok !== 'boolean') return { ok: true, problemas: ['QA sin respuesta legible'], nota: 5, sinQA: true };
    return j;
  } catch (e) {
    log(`   · QA no disponible: ${e.message.slice(0, 160)}`);
    return { ok: true, problemas: ['QA no disponible'], nota: 5, sinQA: true };
  }
}

// ─────────────────────────── Prompts ───────────────────────────

const SEGURIDAD = 'Every person in frame wears the protection the task requires. ' +
  'If an electrode holder, MIG gun or TIG torch is in the hands, or if any arc, spark or weld glow is visible anywhere in frame, ' +
  'the welding helmet is DOWN and covers the whole face, dark lens forward, and the face is not visible. ' +
  'If the face is visible, then there is no torch in the hands and no arc, no spark and no glow anywhere in frame. ' +
  'These two situations never mix. Long sleeves to the wrists, a welding jacket or full work shirt, and leather gloves whenever metal work is shown.';

const ESTILO = 'Candid documentary photograph shot on 35mm film. Natural available light, muted true-to-life colors, soft film grain, ' +
  'slightly imperfect framing, real dust, real wear, real skin texture. Not glossy, not a 3D render, not stock photography, ' +
  'no dramatic color grading, no colored or neon lighting. Any welding arc is a small intense point of white light with no sparks flying.';

function promptFoto(escena, layout) {
  const encuadre = layout === 'R'
    ? 'Vertical 9:16 frame for a phone video. The main subject fills the upper two thirds; keep the bottom third simple and darker because a subtitle will be placed there.'
    : layout === 'B'
    ? 'Vertical 4:5 frame. The main subject sits in the upper two thirds; the bottom quarter is simple floor or wall with nothing important.'
    : 'Vertical 4:5 frame. The main subject sits in the upper and right part of the frame; the lower-left area is darker and calm, with nothing important, because a headline will be placed there.';
  const vacia = /no people|no person|nobody/i.test(escena)
    ? '\n\nEMPTY SCENE: there are absolutely no people, no hands, no arms and no gloves anywhere in the frame. No one is welding. Only objects.'
    : '';
  return `${ESTILO}\n\nSCENE: ${escena}${vacia}\n\nFRAMING: ${encuadre}\n\nSAFETY (non-negotiable): ${SEGURIDAD}\n\nNO TEXT: no letters, words, numbers, signs, watermarks or logos anywhere in the image.`;
}

const NEG_VIDEO = 'uncovered face near a lit arc, helmet up while welding, bare forearms, sparks, orange sparks, blue light, neon, text, subtitles, watermark, logo, distorted hands, extra fingers, 3d render, glossy, cartoon';

function promptClip(escena) {
  return `Documentary footage, handheld 35mm look, natural light, muted true-to-life colors, real textures. ${escena} ` +
    `Safety: ${SEGURIDAD} No text anywhere. Slow, calm movement.`;
}

// ─────────────────────────── Generación con revisión ───────────────────────────

/** Genera la foto de una pieza: 2 candidatas, la IA escoge; si ninguna pasa, una ronda más. */
async function fotoRevisada(escena, layout, destino, size = { width: 1728, height: 2160 }) {
  const prompt = promptFoto(escena, layout);
  let mejor = null;
  for (let ronda = 1; ronda <= 2; ronda++) {
    if (ronda > 1 && !hayPresupuesto(2 * PRECIO_FOTO)) { log('   · sin presupuesto para repetir'); break; }
    gastado += 2 * PRECIO_FOTO;
    const r = await correr(MODELO_IMAGEN, {
      prompt, image_size: size, num_images: 2, max_images: 1,
      enable_safety_checker: true, enhance_prompt_mode: 'standard',
    });
    for (const img of r.images || []) {
      const qa = await revisar(img.url, escena);
      log(`   · candidata ${qa.ok ? 'PASA' : 'NO pasa'} (nota ${qa.nota}) ${qa.problemas?.length ? '— ' + qa.problemas.join('; ') : ''}`);
      const puntos = (qa.ok ? 100 : 0) + (qa.nota || 0);
      if (!mejor || puntos > mejor.puntos) mejor = { url: img.url, qa, puntos };
      if (qa.ok && (qa.nota || 0) >= 7) break;
    }
    if (mejor && mejor.qa.ok) break;
    log(`   · ninguna pasó en la ronda ${ronda}${ronda === 1 ? '; repito' : ''}`);
  }
  if (!mejor) throw new Error('El modelo de imagen no devolvió imágenes');
  await bajar(mejor.url, destino);
  return { ok: mejor.qa.ok, nota: mejor.qa.nota, problemas: mejor.qa.problemas || [], sinQA: !!mejor.qa.sinQA, url: mejor.url };
}

function cuadro(clip, seg, destino) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(seg), '-i', clip, '-frames:v', '1', '-q:v', '3', destino]);
  return destino;
}

const MOV_DEFECTO = 'Realistic documentary footage that continues this exact photo. Very slow, steady camera push-in. ' +
  'Natural, subtle motion only: hands move slowly and steadily, a small white welding arc flickers if one is present, faint smoke drifts. ' +
  'Every object keeps its exact shape and size. Nothing new appears. No sudden movements, no cuts, no camera shake. Ambient shop sound.';

/**
 * Un clip del reel: primero la foto (Seedream, revisada), luego Veo la anima.
 * Si el clip trae "pantalla", el celular de la foto muestra la captura real de la app
 * (sin IA en la pantalla).
 */
const BANCO_VIDEO = fs.existsSync('marca/banco-video.json') ? JSON.parse(fs.readFileSync('marca/banco-video.json', 'utf8')).tomas : [];

const BANCO_MUSICA = fs.existsSync('marca/banco-musica.json') ? JSON.parse(fs.readFileSync('marca/banco-musica.json', 'utf8')).pistas : [];
function efectoPara(tags = []) {
  const f = tags.includes('esmeril') ? 'marca/audio/esmeril-1.mp3'
    : tags.some(t => ['tig', 'mig', 'stick', 'arco'].includes(t)) ? 'marca/audio/arco-1.mp3' : null;
  return f && fs.existsSync(f) ? f : null;
}

/** Toma real del banco (Pexels): se baja, se corta a SEG_CLIP desde "inicio" y se lleva a 1080x1920. */
async function clipStock(spec, destino) {
  const t = BANCO_VIDEO.find(x => x.id === spec.stock);
  if (!t) throw new Error(`La toma ${spec.stock} no está en marca/banco-video.json`);
  const crudo = path.join(TMP, `stock-${t.id}.mp4`);
  if (!fs.existsSync(crudo)) await bajar(t.url, crudo);
  const ini = Math.max(0, Math.min(Number(spec.inicio || 0), Math.max(0, t.dur - SEG_CLIP - 0.2)));
  // Sonido: el audio original de la toma (si trae) + el efecto que le toca por tags (arco o esmeril).
  const sfx = efectoPara(t.tags);
  const conAudio = tieneAudio(crudo);
  const entradas = ['-ss', String(ini), '-i', crudo];
  const mezcla = [];
  if (conAudio) mezcla.push('[0:a]volume=0.8[o]');
  if (sfx) { entradas.push('-stream_loop', '-1', '-i', sfx); mezcla.push(`[${1}:a]volume=0.9[s]`); }
  entradas.push('-f', 'lavfi', '-t', String(SEG_CLIP), '-i', 'anullsrc=r=44100:cl=stereo');
  const silencio = sfx ? 2 : 1;
  const etiquetas = [conAudio ? '[o]' : '', sfx ? '[s]' : '', `[${silencio}:a]`].filter(Boolean);
  mezcla.push(`${etiquetas.join('')}amix=inputs=${etiquetas.length}:duration=longest:normalize=0,atrim=0:${SEG_CLIP}[a]`);
  ff([...entradas, '-t', String(SEG_CLIP), '-filter_complex',
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=30,setsar=1,eq=saturation=0.92:contrast=1.04[v];` + mezcla.join(';'),
    '-map', '[v]', '-map', '[a]', '-t', String(SEG_CLIP),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', destino]);
  return { ok: true, stock: t.id };
}

/** Celular dibujado (sin IA) sobre negro con resplandor verde, con la app real adentro. */
async function clipMockup(nav, pantalla, destino) {
  const app = await videoPantalla(nav, pantalla, path.join(TMP, 'app.mp4'));
  const fondo = path.join(TMP, 'mock-fondo.png');
  const pag = await nav.newPage({ viewport: { width: 1080, height: 1920 } });
  await pag.setContent(`<html><body style="margin:0"><div style="width:1080px;height:1920px;background:radial-gradient(ellipse 70% 45% at 50% 42%,rgba(22,163,74,.45),rgba(22,163,74,.08) 55%,rgba(7,9,8,0) 75%),#070908;position:relative">
    <div style="position:absolute;left:260px;top:300px;width:560px;height:1140px;border-radius:72px;background:#111;box-shadow:0 40px 120px rgba(0,0,0,.6),inset 0 0 0 3px #2a2a2a"></div>
    <div style="position:absolute;left:278px;top:318px;width:524px;height:1104px;border-radius:56px;background:#00FF00"></div>
    <div style="position:absolute;left:470px;top:334px;width:140px;height:34px;border-radius:20px;background:#111"></div></div></body></html>`);
  await pag.screenshot({ path: fondo }); await pag.close();
  const W = 524, H = 1104, X = 278, Y = 318, T = SEG_CLIP;
  const tecleo = fs.existsSync('marca/audio/tecleo-1.mp3') ? 'marca/audio/tecleo-1.mp3' : null;
  ff(['-loop', '1', '-t', String(T), '-i', fondo, '-i', app,
    ...(tecleo ? ['-stream_loop', '-1', '-i', tecleo] : ['-f', 'lavfi', '-t', String(T), '-i', 'anullsrc=r=44100:cl=stereo']),
    '-filter_complex',
    `[1:v]scale=${W}:-2,pad=${W}:${H}:0:(oh-ih)/2:0xF4F5F5[a];[0:v][a]overlay=${X}:${Y}[f];` +
    `[0:v]colorkey=0x00FF00:0.3:0.05[k];[f][k]overlay=0:0,scale=w='1080*(1+0.03*t/${T})':h=-2:eval=frame,crop=1080:1920,fps=30,format=yuv420p[v]`,
    '-map', '[v]', '-map', '2:a', '-af', `volume=0.7,afade=t=out:st=${T - 0.6}:d=0.6`, '-t', String(T), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-c:a', 'aac', '-ar', '44100', '-ac', '2', destino]);
  return destino;
}

/**
 * Un clip del reel. Orden de preferencia, sin IA donde se suelda:
 *  - "stock": toma real del banco (Pexels).
 *  - "pantalla" sin "escena": celular dibujado con la app real.
 *  - "escena": foto Seedream + Veo (solo para escenas SIN herramientas de soldar).
 */
async function clipRevisado(spec, destino, fotoDestino, nav) {
  if (spec.stock) return clipStock(spec, destino);
  if (spec.pantalla && !spec.escena) { await clipMockup(nav, spec.pantalla, destino); return { ok: true, pantalla: true }; }
  const foto = await fotoRevisada(spec.escena, 'R', fotoDestino, { width: 1080, height: 1920 });
  if (spec.pantalla) {
    await clipPantalla(nav, fotoDestino, spec.pantalla, destino);
    return { ok: foto.ok, problemas: foto.problemas, sinQA: foto.sinQA, pantalla: true };
  }
  let ultimo = null;
  const costo = SEG_CLIP * (PRECIO_SEG[RES_VIDEO] || 0.15);
  // Un solo intento de video: el filtro de calidad caro es la FOTO (barata) antes de animar.
  // Repetir Veo por la revisión gastó el saldo el 1 oct 2026 sin mejorar el resultado.
  for (let intento = 1; intento <= 1; intento++) {
    if (!hayPresupuesto(costo)) throw new Error(`Tope de gasto alcanzado ($${gastado.toFixed(2)} de $${PRESUPUESTO})`);
    gastado += costo;
    const r = await correr(MODELO_VIDEO, {
      prompt: `${spec.movimiento || MOV_DEFECTO} Safety: ${SEGURIDAD} No text anywhere.`,
      image_url: foto.url, duration: `${SEG_CLIP}s`, aspect_ratio: '9:16', resolution: RES_VIDEO,
      generate_audio: true, negative_prompt: NEG_VIDEO,
    }, 20);
    const url = r.video?.url || r.video_url;
    if (!url) throw new Error(`Veo terminó sin video: ${JSON.stringify(r).slice(0, 200)}`);
    await bajar(url, destino);
    const f = cuadro(destino, 3, path.join(TMP, 'cuadro.jpg'));
    const qa = await revisar(await subirFal(f, 'image/jpeg'), spec.escena);
    log(`   · clip ${qa.ok ? 'PASA' : 'NO pasa'} ${qa.problemas?.length ? '— ' + qa.problemas.join('; ') : ''}`);
    ultimo = qa;
    if (qa.ok) break;
  }
  return { ok: ultimo.ok, problemas: ultimo.problemas || [], sinQA: !!ultimo.sinQA };
}

/** Busca el rectángulo verde (la pantalla del celular) en la foto. */
async function bboxVerde(nav, ruta) {
  const pag = await nav.newPage();
  const data = 'data:image/jpeg;base64,' + fs.readFileSync(ruta).toString('base64');
  const r = await pag.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4, R = d[i], G = d[i + 1], B = d[i + 2];
      if (G > 140 && G > R * 1.6 && G > B * 1.6) { n++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    }
    return { W, H, x0, y0, x1, y1, n };
  }, data);
  await pag.close();
  if (r.n < 2000) throw new Error('La foto del celular no trae pantalla verde');
  return r;
}

/**
 * Video de la pantalla: la captura real del registro con un usuario de muestra escribiendo
 * (correo, contraseña y toque en el botón). Nada se envía: es una animación sobre la captura.
 * Posiciones en px de marca/app-registro.png (737 de ancho).
 */
const PANTALLA_CAMPOS = { correo: { x: 110, y: 433 }, clave: { x: 110, y: 555 }, boton: { x: 48, y: 606, w: 641, h: 46 } };
async function videoPantalla(nav, pantalla, destino) {
  const dims = await (async () => { const p = await nav.newPage(); const src = 'data:image/png;base64,' + fs.readFileSync(pantalla).toString('base64');
    const r = await p.evaluate(async s => { const i = new Image(); i.src = s; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, src); await p.close(); return r; })();
  const [W, H] = dims;
  const pag = await nav.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const src = 'data:image/png;base64,' + fs.readFileSync(pantalla).toString('base64');
  const F = PANTALLA_CAMPOS;
  await pag.setContent(`<html><body style="margin:0"><div style="position:relative;width:${W}px;height:${H}px;background:url('${src}') 0 0/100% 100%;font-family:system-ui,Segoe UI,sans-serif">
    <div id="c" style="position:absolute;left:${F.correo.x}px;top:${F.correo.y - 14}px;width:520px;height:30px;background:#fff;font-size:19px;color:#111;line-height:30px"></div>
    <div id="k" style="position:absolute;left:${F.clave.x}px;top:${F.clave.y - 14}px;width:480px;height:30px;background:#F6F7F8;font-size:22px;color:#111;line-height:30px;letter-spacing:3px"></div>
    <div id="b" style="position:absolute;left:${F.boton.x}px;top:${F.boton.y}px;width:${F.boton.w}px;height:${F.boton.h}px;border-radius:12px;background:#16A34A;color:#fff;font-weight:700;font-size:16px;letter-spacing:.06em;display:flex;align-items:center;justify-content:center;opacity:0;transition:none">CREAR CUENTA ↗</div>
    <div id="t" style="position:absolute;width:56px;height:56px;border-radius:50%;background:rgba(0,0,0,.18);left:${F.boton.x + F.boton.w / 2 - 28}px;top:${F.boton.y - 5}px;opacity:0"></div>
  </div></body></html>`);
  await pag.evaluate(() => document.fonts.ready);
  const correo = 'jose.rivera@gmail.com', fps = 15, total = SEG_CLIP * fps;
  const dir = path.join(TMP, 'frames'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (let f = 0; f < total; f++) {
    const t = f / fps;
    const nc = Math.max(0, Math.min(correo.length, Math.floor((t - 0.6) / 1.9 * correo.length)));
    const nk = Math.max(0, Math.min(10, Math.floor((t - 2.8) / 1.0 * 10)));
    const caret = Math.floor(t * 2) % 2 ? '|' : ' ';
    await pag.evaluate(([c, k, bOp, tOp]) => {
      document.getElementById('c').textContent = c; document.getElementById('k').textContent = k;
      document.getElementById('b').style.opacity = bOp; document.getElementById('t').style.opacity = tOp;
    }, [correo.slice(0, nc) + (t > 0.4 && t < 2.7 ? caret : ''), '•'.repeat(nk) + (t >= 2.7 && t < 3.9 ? caret : ''),
      t > 4.0 ? '1' : '0', t > 4.3 && t < 4.9 ? '1' : '0']);
    await pag.screenshot({ path: path.join(dir, `${String(f).padStart(4, '0')}.png`) });
  }
  await pag.close();
  ff(['-framerate', String(fps), '-i', path.join(dir, '%04d.png'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '16', destino]);
  return destino;
}

/** Monta el video de la app dentro de la pantalla verde, con un leve zoom. */
async function clipPantalla(nav, foto, pantalla, destino) {
  const base = path.join(TMP, 'pantalla-base.jpg');
  ff(['-i', foto, '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920', '-q:v', '2', base]);
  const b = await bboxVerde(nav, base);
  const w = b.x1 - b.x0 + 6, h = b.y1 - b.y0 + 6, x = Math.max(0, b.x0 - 3), y = Math.max(0, b.y0 - 3);
  const app = await videoPantalla(nav, pantalla, path.join(TMP, 'app.mp4'));
  const T = SEG_CLIP;
  ff(['-loop', '1', '-t', String(T), '-i', base, '-i', app,
    '-filter_complex',
    `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:${Math.round(h * 0.05)}:0xF4F5F5[app];` +
    `[0:v][app]overlay=${x}:${y}[f];` +
    `[0:v]chromakey=0x00FF00:0.28:0.06,despill=green[k];` +
    `[f][k]overlay=0:0,scale=w='1080*(1+0.035*t/${T})':h=-2:eval=frame,crop=1080:1920,fps=30,format=yuv420p[v]`,
    '-map', '[v]', '-t', String(T), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', destino]);
  return destino;
}

// ─────────────────────────── Montaje (HTML → JPG/PNG) ───────────────────────────

const FUENTES = path.resolve('node_modules/@fontsource');
const CSS = `
@font-face{font-family:'Inter';src:url('file://${FUENTES}/inter/files/inter-latin-900-normal.woff2') format('woff2');font-weight:900;}
@font-face{font-family:'Inter';src:url('file://${FUENTES}/inter/files/inter-latin-800-normal.woff2') format('woff2');font-weight:800;}
@font-face{font-family:'Inter';src:url('file://${FUENTES}/inter/files/inter-latin-700-normal.woff2') format('woff2');font-weight:700;}
@font-face{font-family:'Inter';src:url('file://${FUENTES}/inter/files/inter-latin-600-normal.woff2') format('woff2');font-weight:600;}
*{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased;}
html,body{width:1080px;overflow:hidden;background:transparent;}
.s{position:relative;width:1080px;height:1350px;overflow:hidden;background:#070908;color:#fff;font-family:'Inter';}
.s.v{height:1920px;background:transparent;}
.ph{position:absolute;inset:0;background-size:cover;background-position:center;filter:contrast(1.05) saturate(.95);}
.logo{position:absolute;left:72px;top:72px;width:150px;height:150px;border-radius:30px;box-shadow:0 14px 40px rgba(0,0,0,.45);}
h1{font-weight:900;letter-spacing:-.035em;line-height:.98;text-wrap:balance;text-shadow:0 4px 24px rgba(0,0,0,.45);}
h1 em{font-style:normal;color:#22C55E;}
h1 br+em,h1 em{}
.bar{width:150px;height:12px;background:#16A34A;margin:40px 0 30px;}
.linea{font-weight:700;font-size:40px;line-height:1.3;color:#fff;letter-spacing:-.005em;text-shadow:0 2px 12px rgba(0,0,0,.5);}
/* A · foto a sangre, texto abajo */
.A .grad{position:absolute;inset:0;background:linear-gradient(to top,rgba(5,7,6,.97) 0%,rgba(5,7,6,.88) 30%,rgba(5,7,6,.35) 52%,rgba(5,7,6,0) 66%);}
.A .txt{position:absolute;left:72px;right:72px;bottom:88px;}
.A h1{font-size:104px;max-width:900px;}
/* B · foto a la derecha, texto a la izquierda sobre negro */
.B .ph{left:22%;}
.B .grad{position:absolute;inset:0;background:linear-gradient(to right,#070908 0%,#070908 22%,rgba(7,9,8,.88) 40%,rgba(7,9,8,.35) 62%,rgba(7,9,8,0) 78%),linear-gradient(to top,rgba(7,9,8,.75) 0%,rgba(7,9,8,0) 35%);}
.B .txt{position:absolute;left:72px;right:200px;top:50%;transform:translateY(-38%);}
.B h1{font-size:100px;}
/* T · tarjeta de texto del carrusel: negro con resplandor verde */
.T{background:radial-gradient(ellipse 70% 55% at 75% 30%,rgba(22,163,74,.38) 0%,rgba(22,163,74,.10) 45%,rgba(7,9,8,0) 70%),#070908;}
.T .txt{position:absolute;left:72px;right:72px;bottom:120px;}
.T h1{font-size:92px;line-height:1.02;}
.T .lista{font-weight:900;font-size:112px;line-height:1.0;letter-spacing:-.035em;}
.T .lista div{padding:18px 0;}
.T .lista div:nth-child(2){color:#22C55E;}
/* C · cierre */
.C{background:radial-gradient(ellipse 80% 60% at 50% 35%,rgba(22,163,74,.55) 0%,rgba(22,163,74,.15) 45%,rgba(7,9,8,0) 72%),#070908;}
.C .txt{position:absolute;left:72px;right:72px;bottom:120px;}
.C h1{font-size:112px;}
.C .linea{color:rgba(255,255,255,.9);}
/* Reel · subtitulo sobre el clip */
.R .grad{position:absolute;left:0;right:0;bottom:0;height:50%;background:linear-gradient(to top,rgba(5,7,6,.9),rgba(5,7,6,0));}
.R .txt{position:absolute;left:80px;right:80px;bottom:330px;}
.R h1{font-size:118px;}
.R .logo{top:110px;left:80px;width:130px;height:130px;}
.s.v.RC{background:radial-gradient(ellipse 80% 50% at 50% 40%,rgba(22,163,74,.55) 0%,rgba(22,163,74,.15) 45%,rgba(7,9,8,0) 72%),#070908;}
.RC .txt{bottom:520px;}
.RC h1{font-size:124px;}
.RC .logo{width:190px;height:190px;border-radius:40px;top:auto;bottom:1020px;left:80px;}
`;

const logo = () => LOGO ? `<img class="logo" src="${LOGO}">` : '';
const pie = d => d.linea ? `<div class="bar"></div><div class="linea">${d.linea}</div>` : '';

function htmlPieza(tipo, d) {
  const foto = d.foto ? `<div class="ph" style="background-image:url('${d.foto}')"></div>` : '';
  switch (tipo) {
    case 'A': return `<div class="s A">${foto}<div class="grad"></div>${logo()}<div class="txt"><h1>${d.titular}</h1>${pie(d)}</div></div>`;
    case 'B': return `<div class="s B">${foto}<div class="grad"></div>${logo()}<div class="txt"><h1>${d.titular}</h1>${pie(d)}</div></div>`;
    case 'T': {
      const cuerpo = d.lista
        ? `<div class="lista">${d.lista.map(x => `<div>${x}</div>`).join('')}</div>${d.texto ? `<div class="bar"></div><div class="linea">${d.texto}</div>` : ''}`
        : `<h1>${d.texto}</h1>`;
      return `<div class="s T">${logo()}<div class="txt">${cuerpo}</div></div>`;
    }
    case 'C': return `<div class="s C">${logo()}<div class="txt"><h1>${d.titular}</h1>${pie({ linea: d.linea || 'bearslinkup.com' })}</div></div>`;
    case 'R': if (!d.titular) return `<div class="s v R"></div>`;
      return `<div class="s v R"><div class="grad"></div><div class="txt"><h1>${d.titular}</h1></div></div>`;
    case 'RC': return `<div class="s v C RC">${logo()}<div class="txt"><h1>${d.titular}</h1>${pie({ linea: d.linea || 'bearslinkup.com' })}</div></div>`;
  }
  throw new Error(`Plantilla desconocida ${tipo}`);
}

async function montar(nav, tipo, d, destino) {
  const alto = (tipo === 'R' || tipo === 'RC') ? 1920 : 1350;
  const pag = await nav.newPage({ viewport: { width: 1080, height: alto }, deviceScaleFactor: 1 });
  const datos = { ...d };
  if (d.fotoRuta) datos.foto = 'data:image/jpeg;base64,' + fs.readFileSync(d.fotoRuta).toString('base64');
  const archivo = path.resolve(TMP, `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.html`);
  fs.writeFileSync(archivo, `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${htmlPieza(tipo, datos)}</body></html>`);
  await pag.goto('file://' + archivo);
  await pag.evaluate(() => document.fonts.ready);
  await pag.waitForTimeout(300);
  const png = destino.endsWith('.png');
  await pag.screenshot({ path: destino, type: png ? 'png' : 'jpeg', quality: png ? undefined : 92, omitBackground: tipo === 'R', clip: { x: 0, y: 0, width: 1080, height: alto } });
  await pag.close();
  return destino;
}

// ─────────────────────────── Reel ───────────────────────────

function ff(a) { execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...a], { stdio: 'inherit' }); }
function tieneAudio(f) {
  try { return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', f]).toString().trim().length > 0; }
  catch { return false; }
}

/** Cada clip lleva su subtítulo encima; al final, 3 s de cierre de marca. Corte seco, nunca disolvencia. */
function armarReel(segmentos, cierrePng, destino, musica) {
  const partes = segmentos.map((s, i) => {
    const o = path.join(TMP, `seg${i}.mp4`);
    const audio = tieneAudio(s.clip);
    let dur = SEG_CLIP;
    try { dur = Math.min(SEG_CLIP, parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', s.clip]).toString()) || SEG_CLIP); } catch {}
    ff(['-i', s.clip, '-i', s.capa, '-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=44100:cl=stereo',
      '-filter_complex', '[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=30,setsar=1[b];[b][1:v]overlay=0:0[v]',
      '-map', '[v]', '-map', audio ? '0:a' : '2:a', '-t', String(dur),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', o]);
    return o;
  });
  const cierre = path.join(TMP, 'cierre.mp4');
  ff(['-loop', '1', '-t', '3', '-i', cierrePng, '-f', 'lavfi', '-t', '3', '-i', 'anullsrc=r=44100:cl=stereo',
    '-vf', 'scale=1080:1920,fps=30,setsar=1,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-shortest', cierre]);
  partes.push(cierre);
  const lista = path.join(TMP, 'lista.txt');
  fs.writeFileSync(lista, partes.map(f => `file '${path.resolve(f)}'`).join('\n'));
  const unido = path.join(TMP, 'unido.mp4');
  ff(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', unido]);
  // Música de fondo (Pixabay) debajo de los efectos, con salida suave y volumen normalizado para Reels.
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', unido]).toString()) || 21;
  if (musica && fs.existsSync(musica.archivo)) {
    ff(['-i', unido, '-ss', String(musica.inicio || 0), '-i', musica.archivo, '-filter_complex',
      `[1:a]atrim=0:${dur},asetpts=PTS-STARTPTS,afade=t=in:d=0.3,afade=t=out:st=${dur - 1.5}:d=1.5,volume=0.55[m];` +
      `[0:a]volume=0.9[e];[e][m]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]`,
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-movflags', '+faststart', destino]);
  } else {
    ff(['-i', unido, '-c', 'copy', '-movflags', '+faststart', destino]);
  }
  return destino;
}

/** Escoge la pista de música para un reel: la del plan si la trae; si no, rota por mes y número de pieza. */
async function musicaPara(p, mes) {
  if (!BANCO_MUSICA.length) return null;
  const n = Number(mes.replace('-', '')) + Number(p.id);
  const pista = p.musica ? BANCO_MUSICA.find(x => x.id === p.musica) : BANCO_MUSICA[n % BANCO_MUSICA.length];
  if (!pista) return null;
  const archivo = path.join(TMP, `musica-${pista.id}.mp3`);
  try { if (!fs.existsSync(archivo)) await bajar(pista.url, archivo); } catch (e) { log(`   · no pude bajar la música ${pista.id}: ${e.message}`); return null; }
  return { archivo, inicio: pista.inicio || 0, id: pista.id };
}

// ─────────────────────────── Plan con LLM ───────────────────────────

const PROHIBIDAS = ['conviértete', 'conviertete', 'domina', 'la magia', 'otro nivel', 'explora', 'mundo', 'imagina', 'maravilla', 'te animas', 'descubre', 'sin resumé', 'sin resume', 'garantiza', 'master ', 'magic', 'explore', 'get started', 'book a demo'];

function validarPlan(plan, slots) {
  const err = [];
  if (!plan || !Array.isArray(plan.piezas)) return ['No hay "piezas"'];
  if (plan.piezas.length !== slots.length) err.push(`Deben ser ${slots.length} piezas y hay ${plan.piezas.length}`);
  plan.piezas.forEach((p, i) => {
    const s = slots[i]; const id = p.id || i + 1;
    if (s && (p.fecha !== s.fecha || p.tipo !== s.tipo)) err.push(`Pieza ${id}: fecha/tipo deben ser ${s.fecha} ${s.tipo}`);
    if (!p.titular || !/<em>.+<\/em>/.test(p.titular)) err.push(`Pieza ${id}: titular con una palabra clave en <em>`);
    if (p.titular && p.titular.replace(/<[^>]+>/g, '').length > 60) err.push(`Pieza ${id}: titular de más de 60 caracteres`);
    if (!p.copy || !p.hashtags) err.push(`Pieza ${id}: falta copy o hashtags`);
    if (!p.linea) err.push(`Pieza ${id}: falta "linea" (segmento · CTA corto)`);
    if (p.tipo !== 'reel' && !p.foto) err.push(`Pieza ${id}: falta "foto"`);
    if (p.tipo === 'carrusel' && (!Array.isArray(p.slides) || p.slides.length !== 4)) err.push(`Pieza ${id}: el carrusel lleva 4 "slides" después de la portada`);
    if (p.tipo === 'reel' && Array.isArray(p.clips)) p.clips.forEach((c, k) => { if (c.stock && !BANCO_VIDEO.some(t => t.id === c.stock)) err.push(`Pieza ${id}: clip ${k + 1} usa una toma que no está en el banco`); });
    if (p.tipo === 'reel' && (!Array.isArray(p.clips) || p.clips.length < 3 || p.clips.length > 4 || !p.cierre)) err.push(`Pieza ${id}: el reel lleva 3 "clips" y "cierre"`);
    const texto = JSON.stringify(p).toLowerCase();
    for (const w of PROHIBIDAS) if (texto.includes(w)) err.push(`Pieza ${id}: palabra prohibida "${w.trim()}"`);
  });
  return err;
}

async function escribirPlan(mes, slots, previos) {
  const reglas = fs.readFileSync('marca/reglas.md', 'utf8');
  const ultimoIdioma = previos.ultimoIdioma || 'en';
  const ejemplo = fs.existsSync('marca/ejemplo-plan.json') ? fs.readFileSync('marca/ejemplo-plan.json', 'utf8') : '';
  const pedido = `Escribe el plan de contenido orgánico de Bears LinkUp para ${mes}.

ESPACIOS (fecha y tipo exactos, en este orden):
${slots.map((s, i) => `${String(i + 1).padStart(2, '0')}. ${s.fecha} · ${s.tipo}`).join('\n')}

IDIOMA: alterna pieza por pieza. La primera va en ${ultimoIdioma === 'es' ? 'inglés (en)' : 'español (es)'}.

GANCHOS YA USADOS — prohibido repetirlos o parafrasearlos:
${previos.titulares.map(t => '- ' + t).join('\n') || '- (ninguno)'}

FORMATO: devuelve SOLO un JSON válido, sin texto antes ni después, con esta forma:
${ejemplo}`;

  let plan = null; let fallos = [];
  for (let intento = 1; intento <= 3; intento++) {
    const txt = await llm(reglas, fallos.length ? `${pedido}\n\nTU VERSIÓN ANTERIOR TENÍA ESTOS ERRORES. CORRÍGELOS:\n- ${fallos.join('\n- ')}` : pedido);
    const m = txt.match(/\{[\s\S]*\}/);
    try { plan = JSON.parse(m ? m[0] : txt); } catch { fallos = ['El JSON no es válido']; continue; }
    plan.mes = mes;
    plan.piezas = (plan.piezas || []).map((p, i) => ({ ...p, id: String(i + 1).padStart(2, '0') }));
    fallos = validarPlan(plan, slots);
    log(`   · plan intento ${intento}: ${fallos.length ? fallos.length + ' errores' : 'válido'}`);
    if (!fallos.length) return plan;
  }
  throw new Error(`El plan no pasó la validación: ${fallos.slice(0, 8).join(' | ')}`);
}

function leerPrevios(mes) {
  const titulares = []; let ultimaFecha = null; let ultimoIdioma = null;
  if (!fs.existsSync('mes')) return { titulares, ultimaFecha, ultimoIdioma };
  for (const m of fs.readdirSync('mes').sort()) {
    if (m >= mes) continue;
    const f = path.join('mes', m, 'plan.json');
    if (!fs.existsSync(f)) continue;
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const x of p.piezas || []) {
      titulares.push((x.titular || '').replace(/<[^>]+>/g, ''));
      if (!ultimaFecha || x.fecha > ultimaFecha) { ultimaFecha = x.fecha; ultimoIdioma = x.idioma; }
    }
  }
  if (fs.existsSync('marca/ganchos-usados.txt')) {
    titulares.push(...fs.readFileSync('marca/ganchos-usados.txt', 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
  }
  return { titulares, ultimaFecha, ultimoIdioma };
}

/** Qué mes trabajar: el que se pida; si no, el más viejo con plan sin terminar; si no, el siguiente (desde el día 15). */
function mesQueToca() {
  if (mesArg) return mesArg;
  if (fs.existsSync('mes')) {
    for (const m of fs.readdirSync('mes').sort()) {
      const plan = path.join('mes', m, 'plan.json');
      const man = path.join('mes', m, 'manifest.json');
      if (!fs.existsSync(plan)) continue;
      const estado = fs.existsSync(man) ? JSON.parse(fs.readFileSync(man, 'utf8')).estado : null;
      if (estado !== 'completo') return m;
    }
  }
  const h = hoyAST();
  const actual = h.toISOString().slice(0, 7);
  return h.getUTCDate() >= 15 ? mesSiguiente(actual) : actual;
}

// ─────────────────────────── Corrida ───────────────────────────

(async () => {
  if (!FAL_KEY && !remontar) { console.error('Falta FAL_KEY en los Secrets del repo. No genero nada.'); process.exit(1); }

  const mes = mesQueToca();
  const dir = path.join('mes', mes);
  const crudas = path.join(dir, 'crudas');
  fs.mkdirSync(crudas, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  log(`Bears LinkUp · mes ${mes}`);

  // 1 · Plan
  const planRuta = path.join(dir, 'plan.json');
  let plan;
  if (fs.existsSync(planRuta)) {
    plan = JSON.parse(fs.readFileSync(planRuta, 'utf8'));
    log(`Plan existente: ${plan.piezas.length} piezas`);
  } else {
    const previos = leerPrevios(mes);
    const slots = slotsDelMes(mes, previos.ultimaFecha ? previos.ultimaFecha.slice(0, 16) : null);
    if (!slots.length) { log('No quedan espacios en ese mes. Nada que hacer.'); return; }
    log(`Escribiendo plan con ${MODELO_LLM}: ${slots.length} piezas`);
    plan = await escribirPlan(mes, slots, previos);
    fs.writeFileSync(planRuta, JSON.stringify(plan, null, 2));
    log('Plan escrito.');
  }
  if (soloPlan) return;

  // 2 · Manifiesto (reanudable)
  const manRuta = path.join(dir, 'manifest.json');
  const man = fs.existsSync(manRuta) ? JSON.parse(fs.readFileSync(manRuta, 'utf8')) : { mes, piezas: [] };
  man.base = `https://raw.githubusercontent.com/${REPO}/${RAMA}/${dir}/`;
  const guardar = () => {
    man.piezas.sort((a, b) => a.id.localeCompare(b.id));
    const listas = man.piezas.filter(p => p.listo).length;
    man.estado = listas === plan.piezas.length ? 'completo' : 'parcial';
    man.actualizado = new Date().toISOString();
    fs.writeFileSync(manRuta, JSON.stringify(man, null, 2));
  };

  const { chromium } = require('playwright');
  const nav = await chromium.launch();
  let fallidas = 0;

  for (const p of plan.piezas) {
    const previa = man.piezas.find(x => x.id === p.id);
    const toca = soloIds ? soloIds.has(p.id) : !(previa && previa.listo);
    if (!toca && !remontar) continue;
    log(`\n── ${p.id} · ${p.fecha.slice(0, 16)} · ${p.tipo} · ${p.idioma} · ${p.titular.replace(/<[^>]+>/g, '')}`);
    const reg = { id: p.id, fecha: p.fecha, tipo: p.tipo, idioma: p.idioma, copy: p.copy, hashtags: p.hashtags, primer_comentario: p.primer_comentario || '', qa: {} };
    const forzar = !!(soloIds && soloIds.has(p.id));

    try {
      if (p.tipo === 'carrusel' || p.tipo === 'imagen') {
        const layout = p.tipo === 'imagen' ? 'B' : 'A';
        const cruda = path.join(crudas, `${p.id}.jpg`);
        if (forzar || !fs.existsSync(cruda)) reg.qa.foto = await fotoRevisada(p.foto, layout, cruda);
        else { reg.qa.foto = previa?.qa?.foto || { ok: true, provista: true }; log('   · uso la foto ya guardada en crudas/'); }
        if (p.tipo === 'imagen') {
          await montar(nav, 'B', { titular: p.titular, linea: p.linea, fotoRuta: cruda }, path.join(dir, `${p.id}.jpg`));
          reg.archivos = [`${p.id}.jpg`];
        } else {
          reg.archivos = [];
          await montar(nav, 'A', { titular: p.titular, linea: p.linea, fotoRuta: cruda }, path.join(dir, `${p.id}-1.jpg`));
          reg.archivos.push(`${p.id}-1.jpg`);
          for (let s = 0; s < p.slides.length; s++) {
            const sl = p.slides[s];
            const n = `${p.id}-${s + 2}.jpg`;
            if (sl.cierre) await montar(nav, 'C', { titular: sl.cierre, linea: p.linea_cierre }, path.join(dir, n));
            else await montar(nav, 'T', { texto: sl.texto, lista: sl.lista }, path.join(dir, n));
            reg.archivos.push(n);
          }
        }
      } else if (p.tipo === 'reel') {
        const segmentos = [];
        reg.qa.clips = [];
        for (let c = 0; c < p.clips.length; c++) {
          const clip = path.join(TMP, `${p.id}-c${c}.mp4`);
          const guardado = path.join(crudas, `${p.id}-c${c}.mp4`);
          if (!forzar && fs.existsSync(guardado)) { fs.copyFileSync(guardado, clip); reg.qa.clips.push(previa?.qa?.clips?.[c] || { ok: true }); }
          else { reg.qa.clips.push(await clipRevisado(p.clips[c], clip, path.join(crudas, `${p.id}-c${c}.jpg`), nav)); fs.copyFileSync(clip, guardado); }
          const capa = await montar(nav, 'R', { titular: p.clips[c].sub }, path.join(TMP, `${p.id}-s${c}.png`));
          segmentos.push({ clip, capa });
          log(`   ✓ clip ${c + 1}/${p.clips.length}`);
        }
        const cierre = await montar(nav, 'RC', { titular: p.cierre, linea: p.linea }, path.join(TMP, `${p.id}-cierre.png`));
        const musica = await musicaPara(p, mes);
        armarReel(segmentos, cierre, path.join(dir, `${p.id}.mp4`), musica);
        reg.musica = musica ? musica.id : null;
        cuadro(path.join(dir, `${p.id}.mp4`), 1.0, path.join(dir, `${p.id}-portada.jpg`));
        reg.archivos = [`${p.id}.mp4`];
        reg.portada = `${p.id}-portada.jpg`;
      }
      const dudas = [reg.qa.foto, ...(reg.qa.clips || [])].filter(q => q && q.ok === false);
      reg.revisar = dudas.length > 0;
      reg.listo = true;
      log(`   ✓ lista${reg.revisar ? ' (marcada para revisar: la IA de QA no quedó conforme)' : ''}`);
    } catch (e) {
      fallidas++;
      reg.listo = false;
      reg.error = e.message;
      console.error(`   ✗ ${e.message}`);
      if (/Exhausted balance|User is locked/i.test(e.message)) {
        man.piezas = man.piezas.filter(x => x.id !== p.id).concat(reg);
        guardar();
        throw new Error('fal.ai sin saldo. Recarga en fal.ai/dashboard/billing y vuelve a correr: lo hecho no se repite.');
      }
    }
    man.piezas = man.piezas.filter(x => x.id !== p.id).concat(reg);
    guardar();
  }

  await nav.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  guardar();
  log(`\n${man.piezas.filter(p => p.listo).length}/${plan.piezas.length} piezas listas · estado ${man.estado} · gasto estimado $${gastado.toFixed(2)}`);
  if (fallidas) process.exit(1);
})().catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
