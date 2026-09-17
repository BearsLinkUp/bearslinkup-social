#!/usr/bin/env node
/**
 * BEARS LINKUP — Generador semanal
 * ---------------------------------
 * Corre dentro de GitHub Actions los lunes. Nadie lo ejecuta a mano.
 *
 * Qué hace, de punta a punta:
 *   1. Escoge la semana del banco por número de semana ISO (rota sin repetir).
 *   2. Genera 8 fotos y 3 clips de video con la API de fal.ai.
 *   3. Recorta a 4:5 y 9:16 y monta la capa de marca con Chromium headless.
 *   4. Empalma los 3 clips en un reel de ~24 s y le quema la capa de texto.
 *   5. Escribe semana/ y semana.json con los copys y la hora de cada pieza.
 *
 * Después de esto, publicar.js hace el resto a la hora de cada pieza.
 *
 * VARIABLES (Secrets del repo):
 *   FAL_KEY         obligatoria
 *   MODELO_IMAGEN   opcional, por defecto fal-ai/nano-banana-pro
 *   MODELO_VIDEO    opcional, por defecto Kling v3 standard
 *
 * USO:
 *   node generar.js              → la semana que toca
 *   node generar.js --semana=w2  → fuerza una entrada del banco
 *   node generar.js --solo-plan  → escribe semana.json y no genera medios
 *   node generar.js --remontar    → re-monta la marca sobre las crudas, gratis
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FAL = 'https://queue.fal.run';
const { FAL_KEY } = process.env;

// El orden importa: se prueba de arriba abajo y gana el primero que entre.
// Solo corre UNO — los de abajo son red de seguridad si fal tiene el modelo
// caido o saturado. Un respaldo que no se usa no cuesta nada.
//
// Imagen: Nano Banana Pro. Video: Kling v3, escogido por consistencia de
// personaje — el reel son tres tomas del mismo soldador y si cambia de cara
// entre tomas el reel se cae. Veo entra solo si Kling no responde.
const MODELOS_IMAGEN = [process.env.MODELO_IMAGEN,
  'fal-ai/nano-banana-pro', 'fal-ai/nano-banana'].filter(Boolean);
const MODELOS_VIDEO = [process.env.MODELO_VIDEO,
  'fal-ai/kling-video/v3/standard/text-to-video', 'fal-ai/veo3.1/fast'].filter(Boolean);

// 8 s por clip. Es el maximo de Veo y cae comodo dentro del rango de Kling
// (3-15 s), asi que el mismo numero sirve para los dos. Tres clips = 24 s,
// dentro del minimo de 15 s y el maximo de 1 min que pide el cliente.
const SEG_CLIP = 8;

const args = process.argv.slice(2);
const forzarSemana = (args.find(a => a.startsWith('--semana=')) || '').split('=')[1] || null;
const soloPlan = args.includes('--solo-plan');
const remontar = args.includes('--remontar');
// --solo=mar,dom  → vuelve a generar SOLO esos dias y re-monta el resto sobre
// sus crudas. Sirve para arreglar una pieza sin volver a pagar la semana entera.
const soloArg = (args.find(x => x.startsWith('--solo=')) || '').split('=')[1] || '';
const soloDias = soloArg ? new Set(soloArg.split(',').map(x => x.trim()).filter(Boolean)) : null;

const SALIDA = 'semana';
const TMP = '.tmp-generacion';

// Las fotos y clips sin marca se guardan en el repo. Asi un cambio de logo, de
// color o de tipografia se re-monta gratis con --remontar, sin volver a pagar
// generacion. Es la diferencia entre que un ajuste de marca cueste $4 o $0.
const CRUDAS = path.join(SALIDA, 'crudas');

// El logo NUNCA se genera con IA: se monta en post-produccion sobre la pieza ya
// renderizada. Regla de la direccion de arte del cliente.
//
// Vive como base64 en marca/logo.b64 y no como PNG suelto porque este repo se
// edita por la web de GitHub, que no deja pegar binarios. En texto si entra, y
// el navegador lo monta como data URI sin escribir nada a disco.
const LOGO_B64 = 'marca/logo.b64';
const LOGO = fs.existsSync(LOGO_B64)
  ? `data:image/webp;base64,${fs.readFileSync(LOGO_B64, 'utf8').trim()}`
  : null;

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

/**
 * Cliente de fal con reintentos.
 *
 * Por que existe esto: el 17/sep/2026 una corrida de 11 minutos murio con
 * "fetch failed" en el clip 3 de 3. Un corte de red de un segundo tiro a la
 * basura seis imagenes y dos videos ya pagados, porque el script no guarda
 * nada hasta el final. Un fallo de RED se reintenta; un fallo de la API
 * (4xx/5xx con respuesta) no, porque ese no se arregla repitiendo.
 */
async function fal(ruta, metodo = 'GET', cuerpo = null, intentos = 4) {
  const url = ruta.startsWith('http') ? ruta : `${FAL}${ruta}`;
  let ultimoFallo;

  for (let n = 1; n <= intentos; n++) {
    let r;
    try {
      r = await fetch(url, {
        method: metodo,
        headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
    } catch (e) {
      // Aqui no hubo respuesta: DNS, socket cortado, timeout. Eso si se reintenta.
      ultimoFallo = e;
      if (n === intentos) break;
      const espera = 2000 * n;
      log(`   · red fallo (${e.message}). Reintento ${n}/${intentos - 1} en ${espera / 1000}s`);
      await sleep(espera);
      continue;
    }

    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
    if (!r.ok) throw new Error(`fal ${r.status} en ${ruta}: ${txt.slice(0, 300)}`);
    return j;
  }

  throw new Error(`fal sin respuesta en ${ruta} tras ${intentos} intentos: ${ultimoFallo && ultimoFallo.message}`);
}

/**
 * Cada modelo nombra sus parametros distinto: Kling mide la duracion en
 * segundos (numero) y la familia Veo la nombra en texto ("8s"); el Nano Banana
 * basico rechaza `resolution` y el Pro lo acepta. En vez de una capa generica
 * que adivine, aqui va el mapeo explicito de los cuatro que usamos. Si manana
 * se agrega otro modelo, se agrega su caso aqui y nada mas.
 */
function cuerpoFoto(modelo, prompt) {
  const base = { prompt, aspect_ratio: '4:5', output_format: 'jpeg', num_images: 1 };
  return modelo.includes('-pro') ? { ...base, resolution: '2K' } : base;
}

function cuerpoVideo(modelo, prompt) {
  if (modelo.includes('kling')) {
    return {
      prompt, duration: SEG_CLIP, aspect_ratio: '9:16',
      generate_audio: true, negative_prompt: NEGATIVO,
    };
  }
  return {
    prompt, duration: `${SEG_CLIP}s`, aspect_ratio: '9:16',
    resolution: '1080p', generate_audio: true,
  };
}

/** Encola el trabajo probando los modelos en orden hasta que uno entre. */
async function arrancar(modelos, hazCuerpo) {
  let ultimo;
  for (const modelo of modelos) {
    try {
      const j = await fal(`/${modelo}`, 'POST', hazCuerpo(modelo));
      log(`   \u00b7 encolado en ${modelo} (${j.request_id})`);
      // fal devuelve las URLs ya armadas. Se usan tal cual: construirlas a mano
      // falla en los modelos de ruta larga, que responden 405 en /status.
      return {
        modelo,
        id: j.request_id,
        estado: j.status_url || `/${modelo}/requests/${j.request_id}/status`,
        resultado: j.response_url || `/${modelo}/requests/${j.request_id}`,
      };
    } catch (e) {
      ultimo = e;
      log(`   \u00b7 ${modelo} no entro: ${e.message.slice(0, 260)}`);
    }
  }
  throw ultimo;
}

/** Espera a que termine la cola y devuelve el resultado completo. */
async function esperar(trabajo, maxMin = 12) {
  const { modelo, id, estado, resultado } = trabajo;
  const limite = Date.now() + maxMin * 60000;
  while (Date.now() < limite) {
    const s = await fal(estado);
    if (s.status === 'COMPLETED') return fal(resultado);
    if (s.status === 'FAILED' || s.status === 'ERROR') {
      throw new Error(`${modelo} ${id} fallo: ${JSON.stringify(s).slice(0, 300)}`);
    }
    await sleep(6000);
  }
  throw new Error(`Timeout esperando ${modelo} ${id}`);
}

async function bajar(url, destino) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude bajar el medio: ${r.status}`);
  fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
  return destino;
}

async function generarFoto(prompt, destino) {
  const trabajo = await arrancar(MODELOS_IMAGEN, m => cuerpoFoto(m, prompt));
  const r = await esperar(trabajo);
  const url = r.images?.[0]?.url;
  if (!url) throw new Error(`${trabajo.modelo} termino sin imagen: ${JSON.stringify(r).slice(0, 200)}`);
  return bajar(url, destino);
}

async function generarClip(prompt, destino) {
  const trabajo = await arrancar(MODELOS_VIDEO, m => cuerpoVideo(m, prompt));
  const r = await esperar(trabajo, 20);
  const url = r.video?.url || r.video_url;
  if (!url) throw new Error(`${trabajo.modelo} termino sin video: ${JSON.stringify(r).slice(0, 200)}`);
  return bajar(url, destino);
}

// ─────────────────────────── Prompts ───────────────────────────

const NEGATIVO = 'no text, no lettering, no signage, no logos, no brand marks, no certification stamps, no watermarks, no uncovered face near a lit arc, no bare hands near hot metal, no exaggerated smile, no clean corporate office, no 3D render, no plastic skin, no extra fingers, no deformed hands';

// Regla de seguridad. Va en positivo y pegada al SUBJECT porque los modelos de
// imagen leen la lista de negativos como tokens normales: pedir "sin careta
// levantada" termina dibujando la careta levantada. Esta redaccion dice lo que
// SI tiene que pasar, y ata el arco a la careta en la misma oracion.
const SEGURIDAD = 'Every person in frame wears the protection the task requires. ' +
  'If an electrode holder, MIG gun or TIG torch is in the hands, or if any arc, spark or weld glow is visible anywhere in frame, ' +
  'the welding helmet is DOWN and covers the whole face, dark lens forward, and the face is not visible. ' +
  'If the face is visible, then there is no torch in the hands and no arc, no spark and no glow anywhere in frame. ' +
  'These two situations never mix. ' +
  'Skin is covered for the work: long sleeves down to the wrists, a welding jacket or a full work shirt, ' +
  'leather gloves on both hands. No bare forearms, no bare shoulders, no sleeveless shirt, no rolled-up sleeves, no shorts.';

function promptFoto(sem, shot, tercio = 'lower', sobre = {}) {
  // Una pieza puede traer su propia escena o su propio sujeto. Sin esto, la
  // escena de la semana se come la toma: si la semana pasa en el portal de una
  // casa y la pieza pide un inspector en una nave industrial, el modelo intenta
  // cumplir las dos y saca un collage.
  const sujeto = sobre.sujeto || sem.sujeto;
  const escena = sobre.escena || sem.escena;
  // Si la toma pide que no salga nadie, el bloque SUBJECT sobra y estorba.
  const sinGente = /\bno (person|face|hands)\b/i.test(shot);
  return `Vertical documentary photograph of the welding and metal fabrication trade, photorealistic, shot on a 35mm lens, hard natural light, fine film grain.
${sinGente ? '' : `
SUBJECT: ${sujeto}.
`}
SAFETY (non-negotiable): ${SEGURIDAD}

SCENE: ${escena}.

SHOT: ${shot}.

FRAMING: leave the ${tercio} third of the frame visually calm, dark and uncluttered — a text block will be composited there. Subject off-center.

MOOD: earned, unglamorous, competent. Trade documentary photography, not stock photography.

NEGATIVE: ${NEGATIVO}.`;
}

function promptClip(sem, clip) {
  return `Vertical 9:16 cinematic video, ${SEG_CLIP} seconds, photorealistic, documentary feel.

SUBJECT: ${sem.sujeto}.

SAFETY (non-negotiable): ${SEGURIDAD}

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
*{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased;}
/* Sin esto aparece una barra de desplazamiento cuando el texto desborda unos
   pixeles, el lienzo de 1080 ya no cabe, y la captura se lleva el fondo de la
   pagina por el lado derecho. Eso dejaba una franja blanca y cortaba el pie. */
html,body{width:1080px;overflow:hidden;}
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
.badge{width:96px;height:96px;display:block;filter:drop-shadow(0 10px 30px rgba(0,0,0,.35));}
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
.cierre .badge{border-radius:24px;box-shadow:0 0 0 6px #fff;}
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

const marca = () => `${LOGO ? `<img class="badge" src="${LOGO}" alt="">` : ''}<div class="dots"><i></i><i></i><i></i></div>`;

function paginaHTML(cuerpo, fuentes) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>${CSS.replace(/FONTS/g, fuentes)}</style></head><body>${ICONOS}${cuerpo}</body></html>`;
}

function slideHTML(p, fotoRuta) {
  const clases = ['slide', p.variante === 'luz' ? 'luz' : '', p.variante === 'cierre' ? 'cierre' : '', p.reel ? 'reel' : ''].filter(Boolean).join(' ');
  const foto = fotoRuta ? `<div class="photo" style="background-image:url('${fotoRuta}')"></div><div class="edge"></div>` : '';
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

// Lee ancho y alto directo del encabezado IHDR del PNG. Sin dependencias.
function medidasPNG(ruta) {
  const fd = fs.openSync(ruta, 'r');
  const cab = Buffer.alloc(24);
  fs.readSync(fd, cab, 0, 24, 0);
  fs.closeSync(fd);
  return { ancho: cab.readUInt32BE(16), alto: cab.readUInt32BE(20) };
}

async function render(navegador, p, fotoRuta, destino, fuentes) {
  const alto = p.reel ? 1920 : 1350;
  const pag = await navegador.newPage({ viewport: { width: 1080, height: alto }, deviceScaleFactor: 1 });
  // La foto viaja como data URL: asi el lienzo del navegador no queda
  // contaminado y se le puede recortar el borde antes de montar.
  let fotoURL = null;
  if (fotoRuta) {
    const tipo = fotoRuta.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    fotoURL = 'data:' + tipo + ';base64,' + fs.readFileSync(fotoRuta).toString('base64');
  }
  const html = paginaHTML(slideHTML(p, fotoURL), fuentes);
  const tmpHtml = path.join(TMP, `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.html`);
  fs.writeFileSync(tmpHtml, html);
  await pag.goto('file://' + path.resolve(tmpHtml));
  await pag.waitForTimeout(900);

  // El generador de imagen devuelve de vez en cuando la foto con un marco
  // claro de unos pixeles. Si llega asi, se recorta antes de montar; si no,
  // no se toca nada.
  const recorte = await pag.evaluate(async () => {
    const el = document.querySelector('.photo');
    if (!el) return null;
    const m = el.style.backgroundImage.match(/url\(["']?(.+?)["']?\)/);
    if (!m) return null;
    const img = new Image();
    img.src = m[1];
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const claro = (X, Y) => { const i = (Y * W + X) * 4; return d[i] > 236 && d[i+1] > 236 && d[i+2] > 236; };
    const col = X => { for (let Y = 0; Y < H; Y += 5) if (!claro(X, Y)) return false; return true; };
    const fil = Y => { for (let X = 0; X < W; X += 5) if (!claro(X, Y)) return false; return true; };
    const tope = Math.floor(Math.min(W, H) * 0.18);
    let iz = 0, de = 0, ar = 0, ab = 0;
    while (iz < tope && col(iz)) iz++;
    while (de < tope && col(W - 1 - de)) de++;
    while (ar < tope && fil(ar)) ar++;
    while (ab < tope && fil(H - 1 - ab)) ab++;
    if (!iz && !de && !ar && !ab) return { iz: 0, de: 0, ar: 0, ab: 0 };
    const nw = W - iz - de, nh = H - ar - ab;
    if (nw < W * 0.7 || nh < H * 0.7) return { iz: 0, de: 0, ar: 0, ab: 0, descartado: true };
    const c2 = document.createElement('canvas');
    c2.width = nw; c2.height = nh;
    c2.getContext('2d').drawImage(c, iz, ar, nw, nh, 0, 0, nw, nh);
    el.style.backgroundImage = "url('" + c2.toDataURL('image/jpeg', 0.95) + "')";
    return { iz, de, ar, ab };
  });
  if (recorte && (recorte.iz || recorte.de || recorte.ar || recorte.ab)) {
    console.log('   · marco claro recortado de la foto: ' + JSON.stringify(recorte));
  }
  await pag.waitForTimeout(150);

  // El reel se exporta transparente; el resto se pinta sobre negro de marca para
  // que ninguna fuga de fondo salga blanca.
  if (!p.reel) await pag.evaluate(() => { document.documentElement.style.background = '#0A0A0A'; });

  // Guardia. La franja blanca del borde derecho salia porque la pagina medía
  // menos de 1080 y la captura rellenaba el resto con fondo. Aqui se mide antes
  // de disparar: si el lienzo no esta exactamente donde debe, la corrida revienta
  // en vez de subir una pieza cortada.
  const geo = await pag.evaluate(() => {
    const r = document.querySelector('.slide').getBoundingClientRect();
    const h = document.documentElement;
    return {
      slide: [Math.round(r.width), Math.round(r.height), Math.round(r.left), Math.round(r.top)],
      layout: h.clientWidth,
      scroll: h.scrollWidth,
    };
  });
  const torcido =
    geo.slide[0] !== 1080 || geo.slide[1] !== alto ||
    geo.slide[2] !== 0 || geo.slide[3] !== 0 ||
    geo.layout !== 1080 || geo.scroll > 1080;
  if (torcido) {
    throw new Error(
      'Lienzo torcido en ' + path.basename(destino) + ': ' + JSON.stringify(geo) +
      ' (se esperaba slide 1080x' + alto + ' en 0,0 y pagina de 1080)'
    );
  }

  // Region fija en vez del cuadro del elemento: si el nodo se corre un pixel,
  // el recorte sigue siendo 1080 x alto y nunca entra fondo de pagina.
  await pag.screenshot({
    path: destino,
    clip: { x: 0, y: 0, width: 1080, height: alto },
    omitBackground: !!p.reel,
  });
  await pag.close();

  // Ultima red: el archivo que quedo en disco tiene que medir exactamente el
  // lienzo. Si mide menos, la captura se topo con una pagina mas angosta.
  const dim = destino.endsWith('.png') ? medidasPNG(destino) : { ancho: 1080, alto };
  if (dim.ancho !== 1080 || dim.alto !== alto) {
    throw new Error(
      'Pieza con medidas malas: ' + path.basename(destino) +
      ' salio ' + dim.ancho + 'x' + dim.alto + ' y debia ser 1080x' + alto
    );
  }
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
  if (!soloPlan && !remontar && !FAL_KEY) {
    console.error('Falta FAL_KEY en los Secrets del repo. No genero nada.');
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
  const pedido = (i) => (abreEn ? (i % 2 === 0 ? 'en' : 'es') : (i % 2 === 0 ? 'es' : 'en'));

  /**
   * Una pieza solo sale en inglés si SU ARTE tiene versión en inglés. Si el
   * banco no la trae, el post completo baja a español. Nunca un arte en un
   * idioma y un copy en otro: eso se ve amateur y es lo que pasaba antes.
   */
  const hayEn = o => o && o.titular_en !== undefined;
  const idiomaDe = (i) => {
    const p = sem.piezas[orden[i]];
    if (pedido(i) !== 'en') return 'es';
    const ok = p.slides ? p.slides.every(hayEn) : hayEn(p);
    return ok ? 'en' : 'es';
  };

  /** Cambia los textos del arte al idioma que toca. Los shots y clips no se tocan. */
  const enIdioma = (p, idi) => {
    if (idi !== 'en') return p;
    const tr = (o) => {
      const r = { ...o };
      for (const k of ['titular', 'sub', 'hook', 'cta', 'pie', 'tarjetas']) {
        if (o[`${k}_en`] !== undefined) r[k] = o[`${k}_en`];
      }
      return r;
    };
    const r = tr(p);
    if (p.slides) r.slides = p.slides.map(tr);
    return r;
  };

  log(`Bears LinkUp · semana ISO ${anio}-W${String(num).padStart(2, '0')} · banco "${sem.id}" · ${sem.tema}`);
  log(`Protagonista: ${sem.protagonista} · abre en ${abreEn ? 'inglés' : 'español'}\n`);

  if (remontar || soloDias) {
    if (!fs.existsSync(CRUDAS)) {
      console.error(`No hay ${CRUDAS}/. Re-montar necesita las fotos crudas de una corrida anterior.`);
      process.exit(1);
    }
    log(soloDias
      ? `Regenerando solo ${[...soloDias].join(', ')}. El resto se re-monta sobre sus crudas.\n`
      : 'Re-montando sobre las crudas guardadas. No se genera ni se paga nada.\n');
    for (const f of fs.readdirSync(SALIDA)) {
      if (f !== 'crudas') fs.rmSync(path.join(SALIDA, f), { recursive: true, force: true });
    }
  } else {
    fs.rmSync(SALIDA, { recursive: true, force: true });
    fs.mkdirSync(CRUDAS, { recursive: true });
  }
  fs.mkdirSync(SALIDA, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  /** Genera la foto, o reusa la cruda guardada si estamos re-montando. */
  async function foto(nombre, prompt, dia) {
    const ruta = path.resolve(CRUDAS, nombre);
    const reusar = remontar || (soloDias && dia && !soloDias.has(dia));
    if (reusar) {
      if (!fs.existsSync(ruta)) throw new Error(`Falta la cruda ${nombre}`);
      return ruta;
    }
    await generarFoto(prompt, ruta);
    return ruta;
  }

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

  if (!LOGO) console.error(`AVISO: falta ${LOGO_B64}. Las piezas saldran sin el sello de marca.`);

  const { chromium } = require('playwright');
  const navegador = await chromium.launch();
  const fuentes = path.resolve('node_modules/@fontsource');

  for (let i = 0; i < orden.length; i++) {
    const dia = orden[i];
    const p = sem.piezas[dia];
    const idi = idiomaDe(i);
    const copy = `${p[`copy_${idi}`]}\n\n${p[`hashtags_${idi}`]}`;
    const pl = enIdioma(p, idi);
    log(`── ${dia.toUpperCase()} · ${p.tipo} · ${idi}`);

    if (p.tipo === 'carrusel') {
      const archivos = [];
      for (let s = 0; s < p.slides.length; s++) {
        const slide = { ...pl.slides[s], variante: p.variantes[s] };
        const ruta = slide.variante === 'cierre'
          ? null
          : await foto(`lun-${s}.jpg`, promptFoto(sem, p.shots[s], 'lower', p), dia);
        const out = path.join(SALIDA, `lun-${s + 1}.png`);
        await render(navegador, slide, ruta, out, fuentes);
        archivos.push(`lun-${s + 1}.png`);
        log(`   ✓ slide ${s + 1}/${p.slides.length}`);
      }
      piezas.push({ dia, tipo: 'carrusel', archivos, copy, hora: horaDe(dia) });

    } else if (p.tipo === 'reel') {
      const clips = [];
      for (let c = 0; c < p.clips.length; c++) {
        const f = path.resolve(CRUDAS, `clip${c}.mp4`);
        if (remontar || (soloDias && !soloDias.has(dia))) {
          if (!fs.existsSync(f)) throw new Error(`Falta el clip crudo clip${c}.mp4`);
        } else {
          await generarClip(promptClip(sem, p.clips[c]), f);
        }
        clips.push(f);
        log(`   ✓ clip ${c + 1}/${p.clips.length}`);
      }
      const capa = path.join(TMP, 'capa-reel.png');
      await render(navegador, { ...pl, reel: true }, null, capa, fuentes);
      armarReel(clips, capa, path.join(SALIDA, 'mie.mp4'));
      log('   ✓ reel armado');
      piezas.push({ dia, tipo: 'reel', archivo: 'mie.mp4', copy, hora: horaDe(dia) });

    } else {
      const ruta = await foto(`${dia}.jpg`, promptFoto(sem, p.shot, 'lower', p), dia);
      const out = path.join(SALIDA, `${dia}.png`);
      await render(navegador, pl, ruta, out, fuentes);
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
