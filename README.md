# bearslinkup-social

Publicador automático del contenido orgánico de **Bears LinkUp** en Instagram y Facebook.
Montado por **BAdvise**.

> **Este repo no tiene nada que ver con la plataforma.** No comparte código, ni
> dependencias, ni variables de entorno, ni despliegues con `bearslinkup.com`.
> Aquí solo viven las piezas de cada semana y el script que las publica.
> Se puede borrar entero sin que la plataforma se entere.

---

## Por qué existe

Instagram exige una **URL pública** para cada pieza: su API no acepta que le subas
los bytes. Este repo es esa URL. Al ser público, cada archivo dentro de `semana/`
queda accesible en `raw.githubusercontent.com`, que es de donde Meta lo baja.

Y GitHub Actions es lo que dispara la publicación a la hora exacta — por eso el
sistema publica igual con la computadora apagada.

## Qué es público y qué no

- **Público:** las imágenes y el video de la semana. Van a salir publicados en
  Instagram y Facebook de todos modos.
- **Nunca en el repo:** el token de Meta. Vive en **Settings → Secrets and
  variables → Actions**, cifrado. Ni el script ni los logs lo imprimen.

## Cómo corre

```
Lunes 6:00 a.m. AST
  BAdvise genera las 9 piezas, monta la marca, escribe los copys
  y empuja semana/ a este repo
        │
        ▼
GitHub Actions despierta a la hora de cada pieza y publica en IG y FB
  Lun 12:00 p.m. · carrusel
  Mar  6:00 a.m. · imagen — diagnóstico
  Mié  7:00 p.m. · reel
  Vie 12:00 p.m. · imagen — precio real
  Dom  6:00 p.m. · imagen — oportunidad
```

Una vez publicada, la pieza queda marcada en `semana.json` y el propio workflow
lo comitea. Si el cron se repite, no duplica el post.

## Estructura

```
.github/workflows/publicar.yml   los cinco horarios
publicar.js                      el publicador
semana/semana.json               qué pieza va a qué hora
semana/*.png  *.mp4              las piezas de la semana
```

## semana.json

```json
{
  "semana": "2026-W38",
  "piezas": [
    { "dia": "lun", "tipo": "carrusel",
      "archivos": ["lun-1.png","lun-2.png","lun-3.png","lun-4.png","lun-5.png"],
      "copy": "…", "hora": "2026-09-14T16:00:00Z" },
    { "dia": "mar", "tipo": "imagen", "archivo": "mar.png", "copy": "…", "hora": "2026-09-15T10:00:00Z" },
    { "dia": "mie", "tipo": "reel",   "archivo": "mie.mp4", "copy": "…", "hora": "2026-09-16T23:00:00Z" },
    { "dia": "vie", "tipo": "imagen", "archivo": "vie.png", "copy": "…", "hora": "2026-09-18T16:00:00Z" },
    { "dia": "dom", "tipo": "imagen", "archivo": "dom.png", "copy": "…", "hora": "2026-09-20T22:00:00Z" }
  ]
}
```

`hora` siempre en UTC. Puerto Rico es AST (UTC-4) todo el año: no hay horario de
verano, así que la conversión nunca cambia.

## Secrets

| Secret | Valor | Obligatorio |
|---|---|---|
| `META_TOKEN` | Token del usuario de sistema `bearslinkup-publisher`, sin expiración | Sí |
| `FB_PAGE_ID` | `922908814235896` | No — está por defecto en el script |
| `IG_USER_ID` | — | No — el script se lo pregunta a Meta con el ID de la página |

## Probar sin publicar

**Actions → Publicar Bears LinkUp → Run workflow**, marca `dry`. Valida que los
archivos existan y que las URLs se arman bien, y no toca las redes.

Para forzar una pieza: mismo menú, campo `dia` = `lun`, `mar`, `mie`, `vie` o `dom`.

## Si algo falla

El log del workflow dice qué pasó, con el código de error de Meta. Los tres que
salen de verdad:

- **190** — token vencido o revocado. Se genera uno nuevo desde el usuario de sistema.
- **200** — falta un permiso. Revisa que el token traiga los cuatro:
  `instagram_basic`, `instagram_content_publish`, `pages_manage_posts`, `pages_read_engagement`.
- **9007 / 2207xxx** — Instagram no pudo bajar o procesar el medio. Casi siempre
  es el formato: la imagen tiene que ser JPG o PNG y el video MP4 con H.264 y AAC.
