#!/usr/bin/env node
/**
 * BEARS LINKUP — Publicador a Instagram y Facebook
 * -------------------------------------------------
 * Corre dentro de GitHub Actions. Nadie lo ejecuta a mano.
 *
 * Cómo funciona, en corto:
 *   · Los medios de la semana viven en este repo, en semana/. Al ser público,
 *     cada archivo tiene una URL que Meta puede bajar. Eso resuelve el único
 *     requisito duro de Instagram: exige una URL pública, no acepta bytes.
 *   · semana.json dice qué pieza va a qué hora.
 *   · El cron de Actions despierta el proceso; el proceso busca la pieza que
 *     toca ahora y publica. Si no toca ninguna, sale sin hacer nada.
 *
 * VARIABLES (Secrets del repo):
 *   META_TOKEN   token de larga duración del usuario de sistema
 *   FB_PAGE_ID   ID de la página. Por defecto: 922908814235896
 *   IG_USER_ID   opcional — si falta, se le pregunta a Meta con el ID de página
 *
 * USO:
 *   node publicar.js                 → publica la pieza que toque ahora
 *   node publicar.js --dia=mie       → fuerza una pieza
 *   node publicar.js --todas         → publica todas las pendientes
 *   node publicar.js --dry           → valida y no publica nada
 */

const fs = require('fs');
const path = require('path');

const GRAPH = 'https://graph.facebook.com/v21.0';
const { META_TOKEN, GITHUB_REPOSITORY } = process.env;

// Ojo: un Secret que no existe llega como CADENA VACIA, no como undefined, asi
// que el valor por defecto de la desestructuracion nunca entraba y la URL se
// armaba sin ID de pagina. Con || se cubren los dos casos.
const FB_PAGE_ID = process.env.FB_PAGE_ID || '922908814235896';
const GITHUB_REF_NAME = process.env.GITHUB_REF_NAME || 'main';
let IG_USER_ID = process.env.IG_USER_ID || null;

const args = process.argv.slice(2);
const soloDia = (args.find(a => a.startsWith('--dia=')) || '').split('=')[1] || null;
const todas = args.includes('--todas');
const dry = args.includes('--dry');

// Ventana de tolerancia: el cron de GitHub no es puntual al minuto.
const VENTANA_MIN = 45;

if (!META_TOKEN) { console.error('Falta META_TOKEN. Aborto sin publicar nada.'); process.exit(1); }
if (!GITHUB_REPOSITORY) { console.error('Falta GITHUB_REPOSITORY. ¿Esto corre fuera de Actions?'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RAW = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_REF_NAME}/semana`;
const urlDe = archivo => `${RAW}/${encodeURIComponent(archivo)}`;

async function meta(ruta, params = {}, metodo = 'GET') {
  const url = `${GRAPH}/${ruta}`;
  const r = metodo === 'POST'
    ? await fetch(url, { method: 'POST', body: new URLSearchParams({ ...params, access_token: META_TOKEN }) })
    : await fetch(`${url}?${new URLSearchParams({ ...params, access_token: META_TOKEN })}`);
  const j = await r.json();
  if (j.error) throw new Error(`Meta [${j.error.code}/${j.error.error_subcode || 0}]: ${j.error.message}`);
  return j;
}

/** El ig_user_id no se guarda a mano: se le pregunta a la página. */
async function resolverIg() {
  if (IG_USER_ID) return IG_USER_ID;
  const j = await meta(FB_PAGE_ID, { fields: 'instagram_business_account,name' });
  if (!j.instagram_business_account?.id) {
    throw new Error('La página no devuelve instagram_business_account. Revisa que @bearslinkup sea cuenta de empresa vinculada a la página y que el token traiga instagram_basic.');
  }
  IG_USER_ID = j.instagram_business_account.id;
  console.log(`· ig_user_id resuelto solo: ${IG_USER_ID} (página: ${j.name})`);
  return IG_USER_ID;
}

async function esperarContenedor(id, intentos = 60) {
  for (let i = 0; i < intentos; i++) {
    const s = await meta(id, { fields: 'status_code,status' });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR') throw new Error(`IG no pudo procesar el contenedor: ${s.status || ''}`);
    await sleep(5000);
  }
  throw new Error('Timeout esperando a que IG procese el contenedor');
}

async function publicarIG(pieza, urls) {
  const ig = await resolverIg();
  let container;

  if (pieza.tipo === 'carrusel') {
    const hijos = [];
    for (const url of urls) {
      const { id } = await meta(`${ig}/media`, { image_url: url, is_carousel_item: 'true' }, 'POST');
      hijos.push(id);
    }
    ({ id: container } = await meta(`${ig}/media`, {
      media_type: 'CAROUSEL', children: hijos.join(','), caption: pieza.copy,
    }, 'POST'));
  } else if (pieza.tipo === 'reel') {
    ({ id: container } = await meta(`${ig}/media`, {
      media_type: 'REELS', video_url: urls[0], caption: pieza.copy, share_to_feed: 'true',
    }, 'POST'));
    await esperarContenedor(container);
  } else {
    ({ id: container } = await meta(`${ig}/media`, { image_url: urls[0], caption: pieza.copy }, 'POST'));
  }

  const { id } = await meta(`${ig}/media_publish`, { creation_id: container }, 'POST');
  return id;
}

async function publicarFB(pieza, urls) {
  if (pieza.tipo === 'reel') {
    const { id } = await meta(`${FB_PAGE_ID}/videos`, { file_url: urls[0], description: pieza.copy }, 'POST');
    return id;
  }
  if (pieza.tipo === 'carrusel') {
    const adjuntos = {};
    for (let i = 0; i < urls.length; i++) {
      const { id } = await meta(`${FB_PAGE_ID}/photos`, { url: urls[i], published: 'false' }, 'POST');
      adjuntos[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
    }
    const { id } = await meta(`${FB_PAGE_ID}/feed`, { message: pieza.copy, ...adjuntos }, 'POST');
    return id;
  }
  const { id } = await meta(`${FB_PAGE_ID}/photos`, { url: urls[0], caption: pieza.copy, published: 'true' }, 'POST');
  return id;
}

/** Marca la pieza como publicada para que un cron repetido no la duplique. */
function marcar(planPath, plan, dia, resultado) {
  const p = plan.piezas.find(x => x.dia === dia);
  if (p) { p.publicado = resultado; }
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
}

(async () => {
  const planPath = path.join('semana', 'semana.json');
  if (!fs.existsSync(planPath)) { console.log('No hay semana/semana.json. Nada que publicar.'); process.exit(0); }

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const ahora = Date.now();

  let piezas = plan.piezas.filter(p => !p.publicado);
  if (soloDia) piezas = piezas.filter(p => p.dia === soloDia);
  else if (!todas) {
    piezas = piezas.filter(p => {
      const t = new Date(p.hora).getTime();
      return ahora >= t - VENTANA_MIN * 60000 && ahora <= t + VENTANA_MIN * 60000;
    });
  }

  if (!piezas.length) { console.log('No toca ninguna pieza ahora mismo. Salgo limpio.'); process.exit(0); }

  console.log(`Bears LinkUp · ${plan.semana || 's/f'} · ${piezas.length} pieza(s)${dry ? ' · SIMULACRO' : ''}`);

  let fallos = 0;
  for (const pieza of piezas) {
    const archivos = pieza.archivos || [pieza.archivo];
    try {
      for (const a of archivos) {
        const f = path.join('semana', a);
        if (!fs.existsSync(f)) throw new Error(`No existe semana/${a} en el repo`);
      }
      const urls = archivos.map(urlDe);
      if (dry) { console.log(`· ${pieza.dia} ${pieza.tipo} — ${urls.length} URL(s) OK`); continue; }

      const ig = await publicarIG(pieza, urls);
      const fb = await publicarFB(pieza, urls);
      console.log(`✓ ${pieza.dia} · ${pieza.tipo} — IG ${ig} · FB ${fb}`);
      marcar(planPath, plan, pieza.dia, { ig, fb, cuando: new Date().toISOString() });
    } catch (e) {
      fallos++;
      console.error(`✗ ${pieza.dia} · ${pieza.tipo} — ${e.message}`);
    }
  }

  if (dry) { console.log('\nSimulacro terminado. No se publicó nada.'); process.exit(0); }
  process.exit(fallos ? 1 : 0);
})();
