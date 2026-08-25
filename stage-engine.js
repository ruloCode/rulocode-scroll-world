/*!
 * stage-world — motor de landing por estaciones.
 *
 * Sustituye al scrub-engine. La diferencia de fondo: el scroll ya no controla el
 * `currentTime` del vídeo, solo decide qué sección está activa. Cada sección
 * reproduce su clip de forma nativa, de principio a fin.
 *
 * Por qué el cambio:
 *   - El scrubbing exigía un keyframe cada 8 frames para que el seek fuese
 *     instantáneo, y eso costaba ~2x en bitrate. Con reproducción lineal basta un
 *     keyframe cada 2s, así que la misma calidad pesa la mitad (o la misma tasa
 *     compra mucha más calidad).
 *   - La fluidez ya no depende del pulso del scroll del usuario: el vídeo corre a
 *     24fps constantes pase lo que pase.
 *   - `<video src>` con preload permite empezar a reproducir con el buffer parcial,
 *     en vez de esperar la descarga completa como hacía el fetch→blob anterior.
 *
 * Config:
 *   mountStageWorld(el, {
 *     brand, cta, hint, nav,
 *     copyAt: 2.2,          // segundos de clip antes de que entre el panel
 *     sections: [{ id, label, still, stillMobile, clip, clipMobile, accent,
 *                  eyebrow, title, body, tags, cta, copyAt }]
 *   })
 */
function mountStageWorld(container, config) {
  if (!container || !config) return;
  const SECTIONS = config.sections || [];
  const N = SECTIONS.length;
  if (!N) return;

  injectStageCSS();
  container.classList.add('sw-root');

  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const smallMQ = window.matchMedia('(max-width:860px)');
  const isMobile = () => coarse || smallMQ.matches;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COPY_AT = config.copyAt != null ? config.copyAt : 2.2;

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) {
    sky.appendChild(el('div', 'sw-sky__grad'));
    sky.appendChild(el('div', 'sw-sky__glow'));
  }
  const particles = el('div', 'sw-particles'); sky.appendChild(particles);

  const scrollbar = el('div', 'sw-scrollbar');
  const scrollbarFill = el('span'); scrollbar.appendChild(scrollbarFill);

  const topbar = el('div', 'sw-topbar');
  if (config.brand) {
    const brand = el('a', 'sw-brand'); brand.href = (config.brand.href || '#');
    // brand.logo (URL de imagen) sustituye al cuadrado degradado por defecto.
    if (config.brand.logo) {
      const lg = el('img', 'sw-brand__logo'); lg.src = config.brand.logo; lg.alt = '';
      brand.appendChild(lg);
    } else {
      brand.appendChild(el('span', 'sw-brand__mark'));
    }
    const nm = el('span', 'sw-brand__name'); nm.textContent = config.brand.name || ''; brand.appendChild(nm);
    topbar.appendChild(brand);
  }
  const nav = el('nav', 'sw-nav'); if (config.nav !== false) topbar.appendChild(nav);
  if (config.cta && config.cta.label) {
    const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label;
    topbar.appendChild(c);
  }

  const stage = el('div', 'sw-stage');
  const copylayer = el('div', 'sw-copylayer');
  const route = el('div', 'sw-route');
  const hint = el('div', 'sw-hint');
  const hintText = el('span'); hintText.textContent = config.hint || 'scroll'; hint.appendChild(hintText);
  hint.appendChild(el('i'));
  const track = el('div', 'sw-track');

  [sky, scrollbar, topbar, stage, copylayer, route, hint, track].forEach(n => container.appendChild(n));

  // Una escena por sección (póster + hueco para el vídeo) y un spacer que da el
  // scroll y el punto de anclaje del snap.
  const S = SECTIONS.map((s, i) => {
    const scene = el('div', 'sw-scene'); scene.style.setProperty('--sw-accent', s.accent || '');
    const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = 'async';
    const poster = (isMobile() && s.stillMobile) ? s.stillMobile : s.still;
    if (poster) { img.src = poster; if (i > 1) img.loading = 'lazy'; }
    scene.appendChild(img); stage.appendChild(scene);

    const spacer = el('section', 'sw-snap'); spacer.dataset.i = String(i);
    if (s.id) spacer.id = s.id;
    track.appendChild(spacer);

    return { cfg: s, el: scene, img, spacer, video: null, playing: false, copyShown: false };
  });

  // Copy, dots y nav
  const copies = [], dots = [];
  SECTIONS.forEach((s, i) => {
    const c = el('article', 'sw-copy'); c.style.setProperty('--sw-accent', s.accent || '');
    c.innerHTML =
      `<span class="sw-copy__num">${pad(i + 1)} / ${pad(N)}</span>` +
      (s.eyebrow ? `<span class="sw-copy__eyebrow">${esc(s.eyebrow)}</span>` : '') +
      (s.title ? `<h2 class="sw-copy__title">${esc(s.title)}</h2>` : '') +
      (s.body ? `<p class="sw-copy__body">${esc(s.body)}</p>` : '') +
      (s.tags && s.tags.length ? `<ul class="sw-copy__tags">${s.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (s.cta ? `<div class="sw-copy__cta">${ctaBtns(s.cta)}</div>` : '');
    copylayer.appendChild(c); copies.push(c);

    const dot = el('button', 'sw-route__dot'); dot.style.setProperty('--sw-accent', s.accent || '');
    dot.innerHTML = `<span class="sw-route__label">${esc(s.label || '')}</span><i></i>`;
    dot.addEventListener('click', () => jumpTo(i)); route.appendChild(dot); dots.push(dot);

    if (config.nav !== false) {
      const b = el('button', 'sw-nav__item'); b.textContent = s.label || '';
      b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b);
    }
  });

  // ---- vídeo ----
  // `src` directo en vez de fetch→blob: así el navegador puede empezar a pintar con
  // el buffer parcial y gestiona él mismo el ancho de banda.
  function ensureVideo(s, eager) {
    if (s.video) { if (eager) s.video.preload = 'auto'; return s.video; }
    const src = (isMobile() && s.cfg.clipMobile) ? s.cfg.clipMobile : s.cfg.clip;
    if (!src) return null;
    const v = document.createElement('video');
    v.className = 'sw-scene__video';
    // Safari iOS solo deja reproducir sin gesto si muted+playsinline+autoplay están
    // como ATRIBUTOS del elemento, puestos antes del src, y el elemento ya está en
    // el DOM. Cualquier otro orden y el play() se rechaza en silencio.
    v.muted = true; v.defaultMuted = true; v.playsInline = true; v.loop = false;
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('autoplay', '');
    v.setAttribute('preload', eager ? 'auto' : 'metadata');
    v.preload = eager ? 'auto' : 'metadata';
    const poster = (isMobile() && s.cfg.stillMobile) ? s.cfg.stillMobile : s.cfg.still;
    if (poster) v.poster = poster;
    s.el.appendChild(v);      // primero al DOM…
    v.src = src;              // …y luego el src
    // El póster solo se retira cuando hay un frame pintado de verdad: en iOS un
    // vídeo cargado pero no reproducido sigue en blanco.
    const reveal = () => s.el.classList.add('has-clip');
    v.addEventListener('loadeddata', reveal, { once: true });
    v.addEventListener('playing', reveal, { once: true });
    v.addEventListener('timeupdate', () => {
      if (!s.copyShown && v.currentTime >= copyAtFor(s)) showCopy(indexOf(s));
    });
    s.video = v;
    return v;
  }

  const indexOf = s => S.indexOf(s);
  const copyAtFor = s => (s.cfg.copyAt != null ? s.cfg.copyAt : COPY_AT);

  function playSection(s) {
    const v = ensureVideo(s, true);
    if (!v) { showCopy(indexOf(s)); return; }
    if (reduce) { showCopy(indexOf(s)); return; }   // sin autoplay: póster + texto
    try { v.currentTime = 0; } catch (e) {}
    const p = v.play();
    if (p && p.catch) {
      p.then(() => { s.playing = true; }).catch(() => {
        // Autoplay rechazado: mejor enseñar el texto que dejar la sección muda.
        showCopy(indexOf(s));
      });
    }
  }

  function stopSection(s) {
    if (s.video) { try { s.video.pause(); } catch (e) {} }
    s.playing = false;
  }

  function releaseVideo(s) {
    if (!s.video) return;
    try { s.video.pause(); s.video.removeAttribute('src'); s.video.load(); } catch (e) {}
    s.video.remove();
    s.video = null; s.playing = false;
    s.el.classList.remove('has-clip');   // vuelve a mostrarse el póster
  }

  // ---- estaciones ----
  let active = -1;
  const copyTimers = [];

  function showCopy(i) {
    if (i < 0 || i >= N) return;
    S[i].copyShown = true;
    if (i === active) copies[i].classList.add('is-on');
  }
  function hideCopy(i) {
    if (i < 0 || i >= N) return;
    S[i].copyShown = false;
    copies[i].classList.remove('is-on');
  }

  function activate(i) {
    if (i === active || i < 0 || i >= N) return;
    const prev = active;
    active = i;

    // clearTimeout: sin él, el temporizador de red de seguridad de la sección que
    // se abandona dispara showCopy() más tarde y deja copyShown=true en una sección
    // inactiva — al volver a ella, el copy entraría por el fallback (+0.6s tarde).
    if (prev >= 0) { stopSection(S[prev]); hideCopy(prev); clearTimeout(copyTimers[prev]); }
    S.forEach((s, k) => s.el.classList.toggle('is-on', k === i));

    container.style.setProperty('--sw-accent', SECTIONS[i].accent || '');
    dots.forEach((d, k) => d.classList.toggle('is-active', k === i));
    nav.querySelectorAll('.sw-nav__item').forEach((n, k) => n.classList.toggle('is-active', k === i));

    playSection(S[i]);
    // Red de seguridad: si `timeupdate` no llega (vídeo que no carga, pestaña en
    // segundo plano), el panel entra igual pasado su tiempo.
    clearTimeout(copyTimers[i]);
    copyTimers[i] = setTimeout(() => showCopy(i), (copyAtFor(S[i]) + 0.6) * 1000);

    if (i + 1 < N) ensureVideo(S[i + 1], true);   // precarga de la siguiente

    // Y se sueltan las demás. Los decodificadores de vídeo del navegador son un
    // recurso limitado: con varios clips de 1440p vivos a la vez Chrome empieza a
    // devolver MEDIA_ERR_DECODE y la sección se queda congelada en el póster.
    // Mantener solo anterior/actual/siguiente también baja el uso de memoria en móvil.
    S.forEach((s, k) => { if (Math.abs(k - i) > 1) releaseVideo(s); });

    scrollbarFill.style.transform = `scaleX(${((i + 1) / N).toFixed(3)})`;
    hint.style.opacity = i === 0 ? '' : '0';
  }

  // La sección activa se deriva del scroll, no de un IntersectionObserver: con
  // umbrales fijos un salto grande (rueda rápida, barra de scroll, anclaje) puede
  // no cruzar ningún threshold y dejar la sección sin activar.
  //
  // El divisor es la altura REAL del spacer (100svh), no window.innerHeight: en
  // Safari iOS innerHeight crece cuando la barra de URL se colapsa, mientras los
  // spacers miden svh constante. Con ese desfase, round(scrollY/innerHeight) se
  // queda una estación corta a partir de la 5ª-6ª y el scroll "no cambia de escena".
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const h = S[0].spacer.offsetHeight || window.innerHeight || 1;
      const i = Math.max(0, Math.min(N - 1, Math.round(window.scrollY / h)));
      activate(i);
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  function jumpTo(i) {
    if (i < 0 || i >= N) return;
    S[i].spacer.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  // iOS exige un gesto antes de dejar decodificar. Al primer toque cebamos los
  // clips ya creados para que el siguiente `play()` sea inmediato.
  let userReady = false;
  function onFirstGesture() {
    if (userReady) return;
    userReady = true;
    // Si el autoplay de arranque fue rechazado (iOS en modo de bajo consumo, ajustes
    // restrictivos), este primer gesto es la ocasión de poner en marcha la sección
    // que el usuario está viendo. Sin esto la página se queda en el póster.
    const cur = S[active];
    if (cur && (!cur.video || cur.video.paused)) playSection(cur);
  }
  ['pointerdown', 'touchstart', 'wheel', 'keydown'].forEach(ev =>
    window.addEventListener(ev, onFirstGesture, { once: true, passive: true }));

  seedStageParticles(particles, reduce || coarse);

  // Arranque: la primera sección se activa sola, sin esperar al scroll.
  activate(0);
  window.addEventListener('load', () => { if (active === 0 && !S[0].playing) playSection(S[0]); }, { once: true });

  // ---- helpers ----
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ctaBtns(cta) {
    let h = '';
    if (cta.primary) h += `<a class="sw-btn sw-btn--primary" href="${esc(cta.primary.href || '#')}">${esc(cta.primary.label)}</a>`;
    if (cta.secondary) h += `<a class="sw-btn sw-btn--ghost" href="${esc(cta.secondary.href || '#')}">${esc(cta.secondary.label)}</a>`;
    return h;
  }
}

function seedStageParticles(host, reduce) {
  if (!host || reduce) return;
  const kinds = ['dot', 'dot', 'ring'];
  const seeds = [7, 23, 41, 58, 71, 88, 12, 34, 52, 66, 83, 95, 18, 29, 47, 63, 77, 91, 5, 38, 55, 69, 82, 97];
  for (let k = 0; k < 16; k++) {
    const s = document.createElement('span');
    s.className = 'sw-pt sw-pt--' + kinds[k % kinds.length];
    s.style.left = seeds[k % seeds.length] + 'vw';
    s.style.top = ((seeds[(k * 3) % seeds.length] * 1.3) % 100) + 'vh';
    s.style.setProperty('--sw-sc', (0.5 + ((seeds[(k * 5) % seeds.length] % 60) / 60) * 1.1).toFixed(2));
    const dur = 14 + (seeds[(k * 7) % seeds.length] % 22);
    s.style.animationDuration = dur + 's';
    s.style.animationDelay = (-(seeds[(k * 2) % seeds.length] % dur)) + 's';
    host.appendChild(s);
  }
}

function injectStageCSS() {
  if (document.getElementById('sw-css')) return;
  const css = `
  .sw-root{--sw-bg:#F5EDE0;--sw-ink:#241d2b;--sw-ink-soft:#6a6072;--sw-accent:#8a7bb5;
    --sw-font-display:ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;
    --sw-font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    color:var(--sw-ink);font-family:var(--sw-font-body);}
  html,body{margin:0;background:var(--sw-bg,#F5EDE0);}
  /* Un gesto = una sección. scroll-snap-stop:always evita que un swipe largo se
     salte estaciones.
     Solo en html: declararlo también en body hace que Safari iOS tenga dos
     contenedores de snap anidados y el scroll se queda trabado. */
  html{scroll-snap-type:y mandatory;}
  /* svh y no dvh: dvh cambia de valor cuando la barra de URL de Safari se contrae,
     y con snap mandatory eso deja al navegador reajustando la posición en bucle.
     svh es la altura con las barras visibles, o sea constante durante el scroll. */
  .sw-snap{height:100vh;height:100svh;scroll-snap-align:start;scroll-snap-stop:always;}
  .sw-sky{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:var(--sw-bg);}
  .sw-sky__grad{position:absolute;inset:-10%;background:linear-gradient(178deg,color-mix(in srgb,var(--sw-accent) 12%,var(--sw-bg)) 0%,var(--sw-bg) 55%,color-mix(in srgb,var(--sw-accent) 6%,var(--sw-bg)) 100%);}
  .sw-sky__glow{position:absolute;inset:0;background:radial-gradient(60% 42% at 74% 16%,color-mix(in srgb,var(--sw-accent) 22%,transparent),transparent 70%),radial-gradient(46% 34% at 50% 50%,color-mix(in srgb,#fff 45%,transparent),transparent 70%);}
  .sw-particles{position:absolute;inset:-6% -2%;will-change:transform;}
  .sw-pt{position:absolute;width:13px;height:13px;transform:scale(var(--sw-sc,1));opacity:0;animation:sw-drift linear infinite;}
  .sw-pt::before{content:"";position:absolute;inset:0;border-radius:50%;}
  .sw-pt--dot::before{background:radial-gradient(circle at 34% 30%,color-mix(in srgb,var(--sw-accent) 60%,#000),#000 82%);}
  .sw-pt--ring::before{background:transparent;border:2px solid color-mix(in srgb,var(--sw-accent) 55%,transparent);}
  @keyframes sw-drift{0%{opacity:0;transform:scale(var(--sw-sc)) translate(0,12vh) rotate(0)}12%{opacity:.5}88%{opacity:.45}100%{opacity:0;transform:scale(var(--sw-sc)) translate(4vw,-22vh) rotate(210deg)}}
  .sw-scrollbar{position:fixed;top:0;left:0;right:0;height:3px;z-index:60;background:color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-scrollbar span{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(0);background:var(--sw-accent);transition:transform .45s ease;}
  .sw-topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:clamp(14px,2.4vw,26px) clamp(18px,5vw,64px);}
  .sw-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--sw-ink);}
  .sw-brand__mark{width:24px;height:28px;border-radius:7px 7px 10px 10px;background:linear-gradient(160deg,var(--sw-accent),color-mix(in srgb,var(--sw-accent) 60%,#000));box-shadow:0 6px 14px color-mix(in srgb,var(--sw-accent) 40%,transparent);}
  .sw-brand__logo{width:30px;height:30px;border-radius:9px;box-shadow:0 6px 16px color-mix(in srgb,var(--sw-accent) 42%,transparent);transition:transform .25s;}
  .sw-brand:hover .sw-brand__logo{transform:rotate(-6deg) scale(1.06);}
  .sw-brand__name{font-family:var(--sw-font-display);font-weight:700;font-size:1.1rem;}
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#fff;background:var(--sw-accent);}
  .sw-topcta{text-decoration:none;font-weight:600;font-size:.9rem;color:#fff;background:var(--sw-ink);padding:10px 20px;border-radius:999px;white-space:nowrap;}
  .sw-stage{position:fixed;inset:0;z-index:10;pointer-events:none;}
  /* La escena activa entra con un fundido corto; el resto no se pinta. */
  .sw-scene{position:absolute;inset:0;opacity:0;overflow:hidden;transition:opacity .5s ease;}
  .sw-scene.is-on{opacity:1;}
  .sw-scene__video,.sw-scene__still{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;}
  .sw-scene.has-clip .sw-scene__still{opacity:0;} .sw-scene__video{z-index:1;}
  .sw-copylayer{position:fixed;inset:0;z-index:20;pointer-events:none;}
  .sw-copylayer::before{content:"";position:absolute;inset:0;width:min(58vw,780px);background:linear-gradient(90deg,var(--sw-bg) 0%,color-mix(in srgb,var(--sw-bg) 82%,transparent) 34%,color-mix(in srgb,var(--sw-bg) 40%,transparent) 62%,transparent 100%);}
  /* El panel entra cuando el motor lo decide (is-on), no en función del scroll. */
  .sw-copy{position:absolute;left:clamp(18px,5vw,64px);top:50%;width:min(42vw,460px);
    opacity:0;transform:translateY(calc(-50% + 1.4vh));transition:opacity .5s ease,transform .5s ease;}
  .sw-copy.is-on{opacity:1;transform:translateY(-50%);}
  .sw-copy__num{font-family:ui-monospace,Menlo,monospace;font-size:.74rem;letter-spacing:.12em;color:var(--sw-ink-soft);}
  .sw-copy__eyebrow{display:block;margin-top:18px;font-family:var(--sw-font-display);font-weight:700;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);}
  .sw-copy__title{font-family:var(--sw-font-display);font-weight:700;color:var(--sw-ink);font-size:clamp(2rem,4.4vw,3.5rem);line-height:1.03;margin:12px 0 0;letter-spacing:-.01em;}
  .sw-copy__body{margin-top:18px;font-size:clamp(1rem,1.25vw,1.14rem);line-height:1.55;color:color-mix(in srgb,var(--sw-ink) 78%,var(--sw-ink-soft));max-width:40ch;}
  .sw-copy__tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0;padding:0;}
  .sw-copy__tags li{font-size:.82rem;font-weight:600;color:color-mix(in srgb,var(--sw-accent) 70%,#000);padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--sw-accent) 14%,#fff);border:1px solid color-mix(in srgb,var(--sw-accent) 30%,transparent);}
  .sw-copy__cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px;pointer-events:auto;}
  .sw-btn{text-decoration:none;font-weight:600;font-size:.95rem;padding:13px 24px;border-radius:999px;transition:transform .2s;}
  .sw-btn--primary{color:#fff;background:var(--sw-ink);} .sw-btn--primary:hover{transform:translateY(-2px);}
  .sw-btn--ghost{color:var(--sw-ink);border:1.5px solid color-mix(in srgb,var(--sw-ink) 25%,transparent);} .sw-btn--ghost:hover{transform:translateY(-2px);}
  .sw-route{position:fixed;right:clamp(14px,2.4vw,30px);top:50%;z-index:40;transform:translateY(-50%);display:flex;flex-direction:column;gap:22px;padding:18px 10px;}
  .sw-route::before{content:"";position:absolute;left:50%;top:22px;bottom:22px;width:2px;transform:translateX(-50%);background:var(--sw-accent);opacity:.28;}
  .sw-route__dot{position:relative;border:0;background:transparent;cursor:pointer;width:14px;height:14px;display:grid;place-items:center;}
  .sw-route__dot i{width:9px;height:9px;border-radius:50%;background:color-mix(in srgb,var(--sw-accent) 40%,transparent);transition:transform .3s,background .3s,box-shadow .3s;}
  .sw-route__dot:hover i{transform:scale(1.25);background:var(--sw-accent);}
  .sw-route__dot.is-active i{background:var(--sw-accent);transform:scale(1.4);box-shadow:0 0 0 5px color-mix(in srgb,var(--sw-accent) 22%,transparent);}
  .sw-route__label{position:absolute;right:24px;top:50%;transform:translateY(-50%) translateX(6px);white-space:nowrap;font-size:.78rem;font-weight:600;color:var(--sw-ink);background:color-mix(in srgb,#fff 85%,transparent);backdrop-filter:blur(6px);padding:5px 11px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;border:1px solid color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-route__dot:hover .sw-route__label,.sw-route__dot.is-active .sw-route__label{opacity:1;transform:translateY(-50%) translateX(0);}
  .sw-hint{position:fixed;left:50%;bottom:26px;z-index:30;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sw-ink-soft);transition:opacity .4s;}
  .sw-hint i{width:22px;height:34px;border-radius:12px;border:2px solid color-mix(in srgb,var(--sw-ink) 28%,transparent);position:relative;}
  .sw-hint i::after{content:"";position:absolute;left:50%;top:7px;width:4px;height:7px;border-radius:2px;background:var(--sw-accent);transform:translateX(-50%);animation:sw-wheel 1.7s ease-in-out infinite;}
  @keyframes sw-wheel{0%{opacity:0;top:6px}40%{opacity:1}100%{opacity:0;top:17px}}
  .sw-track{position:relative;z-index:1;width:100%;pointer-events:none;}
  @media (max-width:860px){
    .sw-nav{display:none;}
    /* Encuadre centrado: con los clips móviles cortados más lejos ya entra la escena
       completa, así que desplazar el foco a la derecha solo la descentraba. */
    .sw-scene__video,.sw-scene__still{object-position:50% 46%;}
    .sw-copylayer::before{width:100%;height:60%;top:auto;bottom:0;background:linear-gradient(0deg,var(--sw-bg) 8%,color-mix(in srgb,var(--sw-bg) 70%,transparent) 46%,transparent 100%);}
    .sw-copy{left:clamp(18px,5vw,64px);right:clamp(18px,5vw,64px);top:auto;bottom:clamp(64px,14vh,120px);width:auto;max-width:560px;
      transform:translateY(1.4vh);}
    .sw-copy{bottom:calc(clamp(56px,12dvh,110px) + env(safe-area-inset-bottom));}
    .sw-copy.is-on{transform:none;}
    .sw-copy__title{font-size:clamp(1.9rem,7.5vw,2.7rem);}
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);}
    .sw-scene__video,.sw-scene__still{object-position:center 46%;}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:6px;} .sw-route__label{display:none;}
  }
  @media (hover:none) and (pointer:coarse){
    .sw-route{padding:14px 6px;}
    .sw-route__dot{width:28px;height:28px;}
    .sw-btn{padding:15px 26px;}
  }
  /* Sin autoplay ni deriva: el póster y el texto entran directos. */
  @media (prefers-reduced-motion:reduce){
    html{scroll-snap-type:none;}
    .sw-hint i::after{animation:none;} .sw-pt{display:none;}
    .sw-scene,.sw-copy{transition:none;}
  }
  `;
  const style = document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  document.head.appendChild(style);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { mountStageWorld };
if (typeof window !== 'undefined') window.mountStageWorld = mountStageWorld;
