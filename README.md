# rulocode — mundo scrolleable

Landing page inmersiva donde el scroll pilotea una cámara que **vuela dentro de cada escena** y fluye a la siguiente sin cortes — un solo vuelo continuo por un pequeño mundo generado. Presenta los servicios de **rulocode**: consultoría de IA, automatización, desarrollo frontend y performance.

**Live:** https://rulocode-scroll-world.vercel.app

## Cómo funciona

El scroll no anima nada: solo controla el *tiempo* de videos pre-renderizados. La cámara ya se movió (dentro del video); tu scroll avanza o retrocede ese metraje — la misma técnica detrás de las páginas de producto de Apple.

- **Escenas** — dioramas isométricos papercraft generados con IA: 5 escenas + 4 conectores aéreos, encadenados con costuras *frame-locked* para que no se noten los cortes.
- **Motor** — [`scrub-engine.js`](scrub-engine.js): vanilla JS sin dependencias, framework-agnóstico. Carga cada clip como blob (siempre seekable), hace scrubbing por scroll con rAF, crossfades en las costuras, nav rail, hardening móvil (coalescing de seeks, priming iOS, safe-area) y respeta el contexto de `prefers-reduced-motion`.
- **Accesibilidad** — contraste WCAG AA en todo el copy, foco visible de teclado, sin scroll horizontal y scrub funcional en móvil.

## Correr en local

```bash
python3 -m http.server 8137
# abre http://localhost:8137
```

Sitio 100 % estático (HTML + JS + assets). No requiere build.

## Estructura

```
index.html         página + configuración (marca, escenas, paleta, textos)
scrub-engine.js    motor de scroll-scrub (DOM + CSS autoinyectados)
assets/            posters (.webp) + clips de cámara (.mp4)
```

## Créditos

Construido con la skill [scroll-world](https://github.com/oso95/scroll-world). Assets generados con Higgsfield.
