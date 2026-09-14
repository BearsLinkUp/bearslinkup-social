#!/usr/bin/env node
/**
 * BEARS LINKUP — Generador semanal
 * ---------------------------------
 * Corre dentro de GitHub Actions los lunes. Nadie lo ejecuta a mano.
 *
 * Qué hace, de punta a punta:
 *   1. Escoge la semana del banco por número de semana ISO (rota sin repetir).
 *   2. Genera 8 fotos y 3 clips de video con la API de ElevenLabs.
 *   3. Recorta a 4:5 y 9:16 y monta la capa de marca con Chromium headless.
 *   4. Empalma los 3 clips en un reel de ~22 s y le quema la capa de texto.
 *   5. Escribe semana/ y semana.json con los copys y la hora de cada pieza.
 *
 * Después de esto, publicar.js hace el resto a la hora de cada pieza.
 *
 * VARIABLES (Secrets del repo):
 *   ELEVENLABS_API_KEY   obligatoria
 *   MODELO_IMAGEN        opcional, por defecto gemini-3-pro-image
 *   MODELO_VIDEO         opcional, por defecto veo-3.1-fast-generate-001
 *
 * USO:
 *   node generar.js              → la semana que toca
 *   node generar.js --semana=w2  → fuerza una entrada del banco
 *   node generar.js --solo-plan  → escribe semana.json y no genera medios
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const XI = 'https://api.elevenlabs.io/v1';
const { ELEVENLABS_API_KEY } = process.env;

const MODELOS_IMAGEN = [process.env.MODELO_IMAGEN, 'gemini-3-pro-image', 'gpt-image-2', 'gemini-2.5-flash-image'].filter(Boolean);
const MODELOS_VIDEO = [process.env.MODELO_VIDEO, 'veo-3.1-fast-generate-001', 'veo-3.1-generate-001'].filter(Boolean);

const args = process.argv.slice(2);
const forzarSemana = (args.find(a => a.startsWith('--semana=')) || '').split('=')[1] || null;
const soloPlan = args.includes('--solo-plan');

const SALIDA = 'semana';
const TMP = '.tmp-generacion';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ─────────────────────────── Calendario ───────────────────────────

/** Número de semana ISO. Decide qué entrada del banco toca y qué idioma abre. */
function semanaISO(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dia = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dia);
  const enero1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { anio: t.getUTCFullYear(), num: Math.ceil(((t - enero1) / 86400000 + 1) / 7) };
}

/** Lunes de la semana en curso, en UTC. Las horas de publicación cuelgan de aquí. */
function lunesDeEstaSemana() {
  const h = new Date();
  const d = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()));
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dia - 1));
  return d;
}

/** Puerto Rico es AST (UTC-4) todo el año: no hay horario de verano que ajustar. */
const HORARIO = {
  lun: { dias: 0, utc: 16 },
  mar: { dias: 1, utc: 10 },
  mie: { dias: 2, utc: 23 },
  vie: { dias: 4, utc: 16 },
  dom: { dias: 6, utc: 22 },
};

function horaDe(dia) {
  const base = lunesDeEstaSemana();
  const { dias, utc } = HORARIO[dia];
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + dias);
  d.setUTCHours(utc, 0, 0, 0);
  return d.toISOString().replace('.000', '');
}

// ─────────────────────────── ElevenLabs ───────────────────────────

async function xi(ruta, metodo = 'GET', cuerpo = null) {
  const r = await fetch(`${XI}${ruta}`, {
    method: metodo,
    headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  if (!r.ok) throw new Error(`ElevenLabs ${r.status} en ${ruta}: ${txt.slice(0, 300)}`);
  return j;
}

/** Arranca una generación probando los modelos en orden hasta que uno entre. */
async function arrancar(tipo, cuerpoBase, modelos) {
  let ultimo;
  for (const model of modelos) {
    try {
      const j = await xi(`/flows/${tipo}`, 'POST', { ...cuerpoBase, model_id: model });
      log(`   · ${tipo} arrancado con ${model} (${j.id})`);
      return j.id;
    } catch (e) {
      ultimo = e;
      log(`   · ${model} no entró: ${e.message.slice(0, 120)}`);
    }
  }
  throw ultimo;
}

/** Espera a que termine y devuelve la URL firmada del archivo. */
async function esperar(tipo, id, maxMin = 12) {
  const limite = Date.now() + maxMin * 60000;
  while (Date.now() < limite) {
    const j = await xi(`/flows/${tipo}/${id}`);
    if (j.status === 'completed') {
      const url = j.content_url || j.output?.content_url || j.result?.content_url;
      if (!url) throw new Error(`${tipo} ${id} terminó sin content_url`);
      return url;
    }
    if (j.status === 'failed') throw new Error(`${tipo} ${id} falló: ${JSON.stringify(j).slice(0, 200)}`);
    await sleep(6000);
  }
  throw new Error(`Timeout esperando ${tipo} ${id}`);
}

async function bajar(url, destino) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude bajar el medio: ${r.status}`);
  fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
  return destino;
}

async function generarFoto(prompt, destino) {
  const id = await arrancar('image', { prompt, aspect_ratio: '4:5', resolution: '2K' }, MODELOS_IMAGEN);
  return bajar(await esperar('image', id), destino);
}

async function generarClip(prompt, destino) {
  const id = await arrancar('video', {
    prompt, duration_secs: 8, aspect_ratio: '9:16', resolution: '1080p', generate_audio: true,
  }, MODELOS_VIDEO);
  return bajar(await esperar('video', id, 20), destino);
}

// ─────────────────────────── Prompts ───────────────────────────

const NEGATIVO = 'no text, no lettering, no signage, no logos, no brand marks, no certification stamps, no watermarks, no welding with the helmet up while the arc is lit, no bare hands near hot metal, no sparks toward unprotected eyes, no exaggerated smile, no clean corporate office, no 3D render, no plastic skin, no extra fingers, no deformed hands';

function promptFoto(sem, shot, tercio = 'lower') {
  return `Vertical documentary photograph of the welding and metal fabrication trade, photorealistic, shot on a 35mm lens, hard natural light, fine film grain.

SUBJECT: ${sem.sujeto}.

SCENE: ${sem.escena}.

SHOT: ${shot}.

FRAMING: leave the ${tercio} third of the frame visually calm, dark and uncluttered — a text block will be composited there. Subject off-center.

MOOD: earned, unglamorous, competent. Trade documentary photography, not stock photography.

NEGATIVE: ${NEGATIVO}.`;
}

function promptClip(sem, clip) {
  return `Vertical 9:16 cinematic video, 8 seconds, photorealistic, documentary feel.

SUBJECT: ${sem.sujeto}.

SCENE: ${sem.escena}.

ACTION: ${clip}.

CAMERA: 35mm, shallow depth of field, subtle handheld drift. The lower third stays calm and uncluttered the whole time.

MOOD: focused craft. Not dramatic, not heroic. Real.

NEGATIVE: ${NEGATIVO}, no subtitles, no fast cuts, no music video look.`;
}

// ─────────────────────── Capa de marca (HTML) ───────────────────────

const CSS = `
@font-face{font-family:'Archivo';src:url('FONTS/archivo/files/archivo-latin-800-normal.woff2') format('woff2');font-weight:800;font-display:block;}
@font-face{font-family:'Archivo';src:url('FONTS/archivo/files/archivo-latin-700-normal.woff2') format('woff2');font-weight:700;font-display:block;}
@font-face{font-family:'Inter';src:url('FONTS/inter/files/inter-latin-700-normal.woff2') format('woff2');font-weight:700;font-display:block;}
@font-face{font-family:'Inter';src:url('FONTS/inter/files/inter-latin-600-normal.woff2') format('woff2');font-weight:600;font-display:block;}
@font-face{font-family:'Inter';src:url('FONTS/inter/files/inter-latin-500-normal.woff2') format('woff2');font-weight:500;font-display:block;}
@font-face{font-family:'PlexMono';src:url('FONTS/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2') format('woff2');font-weight:500;font-display:block;}
:root{--bosque:#1A5C38;--claro:#4EAF68;--accion:#16A34A;--logo:#104028;--negro:#0A0A0A;--acero:#4A5565;--hueso:#F4F5F3;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;}
.slide{width:1080px;height:1350px;position:relative;overflow:hidden;background:var(--negro);color:#fff;}
.slide.reel{height:1920px;background:transparent;}
.photo{position:absolute;inset:0;z-index:1;background-size:cover;background-position:center;
  clip-path:polygon(44% 0, 100% 0, 100% 100%, 26% 100%);}
.edge{position:absolute;inset:0;z-index:2;background:var(--claro);
  clip-path:polygon(44% 0, 45.1% 0, 27.1% 100%, 26% 100%);opacity:.9;}
.panel{position:absolute;inset:0;z-index:3;background:linear-gradient(105deg,
  rgba(16,64,40,.97) 0%, rgba(11,32,22,.96) 34%, rgba(10,10,10,.93) 52%, rgba(10,10,10,0) 68%);}
.slide.luz{background:var(--hueso);color:#0F2A1D;}
.slide.luz .panel{background:linear-gradient(105deg,
  rgba(244,245,243,.99) 0%, rgba(244,245,243,.98) 40%, rgba(244,245,243,.94) 55%, rgba(244,245,243,0) 70%);}
.slide.luz .edge{background:var(--bosque);opacity:.85;}
.slide.luz .sub{color:#3D4A43;}
.slide.luz .head em{color:var(--bosque);}
.slide.luz .foot{border-top-color:rgba(15,42,29,.16);}
.slide.luz .site{color:#0F2A1D;}
.slide.luz .mono{color:var(--acero);}
.slide.luz .rule{background:var(--bosque);}
.slide.luz .num{color:var(--bosque);}
.slide.luz .card{background:rgba(26,92,56,.06);border-color:rgba(26,92,56,.22);}
.slide.luz .card .d{color:var(--acero);}
.inner{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;
  justify-content:space-between;padding:76px 70px;}
.badge{width:96px;height:96px;border-radius:24px;background:var(--bosque);
  display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.35);}
.badge svg{width:52px;height:52px;}
.dots{display:flex;gap:9px;margin-top:26px;}
.dots i{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.32);}
.slide.luz .dots i{background:rgba(15,42,29,.22);}
.block{max-width:600px;}
.head{font-family:'Archivo',sans-serif;font-weight:700;font-size:66px;line-height:1.06;letter-spacing:-.022em;}
.head em{font-style:normal;color:var(--claro);}
.rule{width:70px;height:7px;background:var(--claro);margin:30px 0 26px;}
.sub{font-weight:500;font-size:30px;line-height:1.38;color:rgba(255,255,255,.86);max-width:560px;}
.sub b{font-weight:700;color:var(--claro);}
.slide.luz .sub b{color:var(--bosque);}
.hook{display:inline-block;background:var(--bosque);border-radius:14px;padding:22px 28px;margin-top:30px;max-width:560px;}
.hook .lbl{font-family:'PlexMono',monospace;font-weight:500;font-size:16px;letter-spacing:.20em;
  text-transform:uppercase;color:rgba(255,255,255,.68);margin-bottom:8px;}
.hook .q{font-family:'Archivo',sans-serif;font-weight:700;font-size:40px;line-height:1.08;color:#fff;}
.foot{display:flex;justify-content:space-between;align-items:center;
  border-top:2px solid rgba(255,255,255,.15);padding-top:22px;}
.site{font-weight:600;font-size:24px;letter-spacing:.03em;color:rgba(255,255,255,.86);}
.mono{font-family:'PlexMono',monospace;font-weight:500;font-size:17px;letter-spacing:.18em;
  text-transform:uppercase;color:rgba(255,255,255,.45);}
.cards{display:flex;gap:16px;margin-top:32px;}
.card{flex:1;background:rgba(255,255,255,.07);border:1.5px solid rgba(78,175,104,.30);border-radius:16px;padding:20px 18px;}
.card .ico{width:46px;height:46px;border-radius:50%;background:var(--bosque);margin-bottom:14px;
  display:flex;align-items:center;justify-content:center;}
.card .ico svg{width:24px;height:24px;}
.card .t{font-weight:700;font-size:22px;margin-bottom:5px;}
.card .d{font-weight:500;font-size:19px;line-height:1.3;color:rgba(255,255,255,.66);}
.cta{display:inline-block;background:var(--accion);color:#fff;border-radius:12px;
  font-family:'Archivo',sans-serif;font-weight:700;font-size:30px;padding:22px 34px;margin-top:28px;}
.num{font-family:'PlexMono',monospace;font-weight:500;font-size:24px;letter-spacing:.18em;color:var(--claro);margin-bottom:16px;}
.slide.cierre{background:var(--bosque);}
.cierre .photo,.cierre .edge,.cierre .panel{display:none;}
.cierre .inner{justify-content:center;}
.cierre .head{font-size:76px;}
.cierre .head em{color:#fff;text-decoration:underline;text-decoration-color:rgba(255,255,255,.45);text-underline-offset:10px;}
.cierre .rule{background:#fff;}
.cierre .sub{color:rgba(255,255,255,.90);}
.cierre .cta{background:#fff;color:var(--logo);}
.cierre .csite{font-family:'PlexMono',monospace;font-weight:500;font-size:24px;letter-spacing:.16em;
  color:rgba(255,255,255,.80);margin-top:30px;}
.cierre .badgewrap{position:absolute;top:76px;left:70px;z-index:5;}
.cierre .badge{background:rgba(255,255,255,.14);}
.reel .photo,.reel .edge{display:none;}
.reel .panel{background:linear-gradient(to bottom,
  rgba(10,10,10,.62) 0%, rgba(10,10,10,0) 20%, rgba(10,10,10,0) 44%, rgba(10,10,10,.90) 72%, rgba(10,10,10,.96) 100%);}
.reel .inner{padding:96px 76px 116px;}
.reel .block{max-width:900px;}
.reel .head{font-size:74px;}
.reel .sub{max-width:820px;}
`;

const ICONOS = `<svg style="display:none">
<symbol id="link" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round">
<path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5l1.3-1.3a4.3 4.3 0 0 1 6 6L17 12.5"/><path d="M13 17.5l-1.3 1.3a4.3 4.3 0 0 1-6-6L7 11.5"/></symbol>
<symbol id="chk" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
<path d="M20 6 9 17l-5-5"/></symbol></svg>`;

const marca = () => `<div class="badge"><svg><use href="#link"/></svg></div><div class="dots"><i></i><i></i><i></i></div>`;

function paginaHTML(cuerpo, fuentes) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>${CSS.replace(/FONTS/g, fuentes)}</style></head><body>${ICONOS}${cuerpo}</body></html>`;
}

function slideHTML(p, fotoRuta) {
  const clases = ['slide', p.variante === 'luz' ? 'luz' : '', p.variante === 'cierre' ? 'cierre' : '', p.reel ? 'reel' : ''].filter(Boolean).join(' ');
  const foto = fotoRuta ? `<div class="photo" style="background-image:url('file://${fotoRuta}')"></div><div class="edge"></div>` : '';
  const pie = p.variante === 'cierre' ? '' :
    `<div class="foot"><div class="site">bearslinkup.com</div><div class="mono">${p.pie || 'Puerto Rico · USA'}</div></div>`;

  if (p.variante === 'cierre') {
    return `<div class="${clases}"><div class="badgewrap">${marca()}</div><div class="inner">
      <div class="block" style="max-width:760px">
        <div class="head">${p.titular}</div><div class="rule"></div>
        <div class="sub">${p.sub}</div>
        ${p.cta ? `<div class="cta">${p.cta}</div>` : ''}
        <div class="csite">bearslinkup.com</div>
      </div></div></div>`;
  }

  const tarjetas = p.tarjetas ? `<div class="cards">${p.tarjetas.map(c =>
    `<div class="card"><div class="ico"><svg><use href="#chk"/></svg></div><div class="t">${c.t}</div><div class="d">${c.d}</div></div>`).join('')}</div>` : '';
  const hook = p.hook ? `<div class="hook"><div class="lbl">${p.hook.lbl}</div><div class="q">${p.hook.q}</div></div>` : '';

  return `<div class="${clases}">${foto}<div class="panel"></div><div class="inner">
    <div>${marca()}</div>
    <div class="block"${p.tarjetas ? ' style="max-width:680px"' : ''}>
      ${p.num ? `<div class="num">${p.num}</div>` : ''}
      <div class="head">${p.titular}</div><div class="rule"></div>
      <div class="sub">${p.sub}</div>
      ${hook}${tarjetas}
    </div>
    ${pie}
  </div></div>`;
}

async function render(navegador, p, fotoRuta, destino, fuentes) {
  const alto = p.reel ? 1920 : 1350;
  const pag = await navegador.newPage({ viewport: { width: 1080, height: alto }, deviceScaleFactor: 1 });
  const html = paginaHTML(slideHTML(p, fotoRuta), fuentes);
  const tmpHtml = path.join(TMP, `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.html`);
  fs.writeFileSync(tmpHtml, html);
  await pag.goto('file://' + path.resolve(tmpHtml));
  await pag.waitForTimeout(900);
  await pag.locator('.slide').screenshot({ path: destino, omitBackground: !!p.reel });
  await pag.close();
  return destino;
}

// ─────────────────────────── Reel ───────────────────────────

function ff(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}

function armarReel(clips, capaPng, destino) {
  const normalizados = clips.map((c, i) => {
    const o = path.join(TMP, `n${i}.mp4`);
    ff(['-i', c, '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-shortest', o]);
    return o;
  });

  const lista = path.join(TMP, 'lista.txt');
  fs.writeFileSync(lista, normalizados.map(f => `file '${path.resolve(f)}'`).join('\n'));
  const unido = path.join(TMP, 'unido.mp4');
  ff(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', unido]);

  // La capa entra a los 2 s y se queda. Corte seco, nunca disolvencia.
  ff(['-i', unido, '-i', capaPng,
    '-filter_complex', "[1:v]format=rgba[capa];[0:v][capa]overlay=0:0:enable='gte(t,2)'[v]",
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', destino]);

  return destino;
}

// ─────────────────────────── Corrida ───────────────────────────

(async () => {
  if (!soloPlan && !ELEVENLABS_API_KEY) {
    console.error('Falta ELEVENLABS_API_KEY en los Secrets del repo. No genero nada.');
    process.exit(1);
  }

  const banco = JSON.parse(fs.readFileSync('banco.json', 'utf8'));
  const { anio, num } = semanaISO();
  const sem = forzarSemana
    ? banco.semanas.find(s => s.id === forzarSemana)
    : banco.semanas[(num - 1) % banco.semanas.length];
  if (!sem) { console.error('No encontré esa semana en el banco.'); process.exit(1); }

  // Semana par abre en inglés; impar abre en español. Así ningún día se casa con un idioma.
  const abreEn = num % 2 === 0;
  const idiomaDe = (i) => (abreEn ? (i % 2 === 0 ? 'en' : 'es') : (i % 2 === 0 ? 'es' : 'en'));

  log(`Bears LinkUp · semana ISO ${anio}-W${String(num).padStart(2, '0')} · banco "${sem.id}" · ${sem.tema}`);
  log(`Protagonista: ${sem.protagonista} · abre en ${abreEn ? 'inglés' : 'español'}\n`);

  fs.rmSync(SALIDA, { recursive: true, force: true });
  fs.mkdirSync(SALIDA, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const orden = ['lun', 'mar', 'mie', 'vie', 'dom'];
  const piezas = [];

  if (soloPlan) {
    orden.forEach((dia, i) => {
      const p = sem.piezas[dia];
      const idi = idiomaDe(i);
      const copy = `${p[`copy_${idi}`]}\n\n${p[`hashtags_${idi}`]}`;
      if (p.tipo === 'carrusel') {
        piezas.push({ dia, tipo: 'carrusel', archivos: p.slides.map((_, s) => `lun-${s + 1}.png`), copy, hora: horaDe(dia) });
      } else if (p.tipo === 'reel') {
        piezas.push({ dia, tipo: 'reel', archivo: 'mie.mp4', copy, hora: horaDe(dia) });
      } else {
        piezas.push({ dia, tipo: 'imagen', archivo: `${dia}.png`, copy, hora: horaDe(dia) });
      }
    });
    fs.writeFileSync(path.join(SALIDA, 'semana.json'), JSON.stringify({ semana: `${anio}-W${num}`, banco: sem.id, piezas }, null, 2));
    log('Plan escrito. No se generó ningún medio.');
    process.exit(0);
  }

  const { chromium } = require('playwright');
  const navegador = await chromium.launch();
  const fuentes = path.resolve('node_modules/@fontsource');

  for (let i = 0; i < orden.length; i++) {
    const dia = orden[i];
    const p = sem.piezas[dia];
    const idi = idiomaDe(i);
    const copy = `${p[`copy_${idi}`]}\n\n${p[`hashtags_${idi}`]}`;
    log(`── ${dia.toUpperCase()} · ${p.tipo} · ${idi}`);

    if (p.tipo === 'carrusel') {
      const archivos = [];
      for (let s = 0; s < p.slides.length; s++) {
        const slide = { ...p.slides[s], variante: p.variantes[s] };
        let foto = null;
        if (slide.variante !== 'cierre') {
          foto = path.resolve(TMP, `lun-foto-${s}.png`);
          await generarFoto(promptFoto(sem, p.shots[s]), foto);
        }
        const out = path.join(SALIDA, `lun-${s + 1}.png`);
        await render(navegador, slide, foto, out, fuentes);
        archivos.push(`lun-${s + 1}.png`);
        log(`   ✓ slide ${s + 1}/${p.slides.length}`);
      }
      piezas.push({ dia, tipo: 'carrusel', archivos, copy, hora: horaDe(dia) });

    } else if (p.tipo === 'reel') {
      const clips = [];
      for (let c = 0; c < p.clips.length; c++) {
        const f = path.resolve(TMP, `clip${c}.mp4`);
        await generarClip(promptClip(sem, p.clips[c]), f);
        clips.push(f);
        log(`   ✓ clip ${c + 1}/${p.clips.length}`);
      }
      const capa = path.join(TMP, 'capa-reel.png');
      await render(navegador, { ...p, reel: true }, null, capa, fuentes);
      armarReel(clips, capa, path.join(SALIDA, 'mie.mp4'));
      log('   ✓ reel armado');
      piezas.push({ dia, tipo: 'reel', archivo: 'mie.mp4', copy, hora: horaDe(dia) });

    } else {
      const foto = path.resolve(TMP, `${dia}-foto.png`);
      await generarFoto(promptFoto(sem, p.shot), foto);
      const out = path.join(SALIDA, `${dia}.png`);
      await render(navegador, p, foto, out, fuentes);
      log('   ✓ imagen montada');
      piezas.push({ dia, tipo: 'imagen', archivo: `${dia}.png`, copy, hora: horaDe(dia) });
    }
  }

  await navegador.close();
  fs.writeFileSync(path.join(SALIDA, 'semana.json'),
    JSON.stringify({ semana: `${anio}-W${num}`, banco: sem.id, tema: sem.tema, piezas }, null, 2));
  fs.rmSync(TMP, { recursive: true, force: true });

  log(`\nListo. ${piezas.length} piezas en ${SALIDA}/. Publican solas a su hora.`);
})().catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
