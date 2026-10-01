"use strict";

// Tutorial guiado: sombrea la ventana y deja iluminada una parte cada vez, con
// una tarjeta que explica para qué sirve. Se muestra la primera vez que se abre
// la app recién instalada (y cuando se pide desde Opciones).
//
// KopiaTutorial.start(pasos, { onEnd }) — cada paso: { target, title, text }.
// `target` es un selector o una función que devuelve el elemento (si no está
// visible, el paso se muestra centrado, sin recuadro).

(function () {
  let current = null; // { steps, index, onEnd, els }

  function resolveTarget(step) {
    const el = typeof step.target === "function" ? step.target() : document.querySelector(step.target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return el;
  }

  function build() {
    const overlay = document.createElement("div");
    overlay.className = "tour-overlay";
    const spot = document.createElement("div");
    spot.className = "tour-spot";
    const card = document.createElement("div");
    card.className = "tour-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "tourTitle");
    const count = document.createElement("span");
    count.className = "tour-count";
    const title = document.createElement("h2");
    title.id = "tourTitle";
    const text = document.createElement("p");
    const actions = document.createElement("div");
    actions.className = "tour-actions";
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "ghost tour-skip";
    skip.textContent = "Saltar tutorial";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Atrás";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "primary";
    actions.append(skip, back, next);
    card.append(count, title, text, actions);
    overlay.append(spot, card);
    document.body.appendChild(overlay);
    skip.addEventListener("click", () => end());
    back.addEventListener("click", () => go(current.index - 1));
    next.addEventListener("click", () => go(current.index + 1));
    // Los clics fuera de la tarjeta no llegan a la app mientras dura el tutorial.
    overlay.addEventListener("mousedown", (e) => {
      if (!card.contains(e.target)) e.preventDefault();
    });
    return { overlay, spot, card, count, title, text, back, next };
  }

  function place() {
    if (!current) return;
    const { els, steps, index } = current;
    const target = resolveTarget(steps[index]);
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const card = els.card.getBoundingClientRect();
    let left;
    let top;
    if (target) {
      const r = target.getBoundingClientRect();
      els.spot.hidden = false;
      els.overlay.classList.remove("tour-plain");
      els.spot.style.left = r.left - pad + "px";
      els.spot.style.top = r.top - pad + "px";
      els.spot.style.width = r.width + pad * 2 + "px";
      els.spot.style.height = r.height + pad * 2 + "px";
      // La tarjeta a la derecha del recuadro, a la izquierda, debajo o encima: la
      // primera donde quepa entera sin taparlo; si en ninguna, la que menos tape.
      const gap = pad + 16;
      const candidatos = [
        { left: r.right + gap, top: r.top },
        { left: r.left - gap - card.width, top: r.top },
        { left: r.left, top: r.bottom + gap },
        { left: r.left, top: r.top - gap - card.height },
      ].map((c) => {
        const l = Math.max(12, Math.min(c.left, vw - card.width - 12));
        const t = Math.max(12, Math.min(c.top, vh - card.height - 12));
        const ancho = Math.max(0, Math.min(l + card.width, r.right + pad) - Math.max(l, r.left - pad));
        const alto = Math.max(0, Math.min(t + card.height, r.bottom + pad) - Math.max(t, r.top - pad));
        return { left: l, top: t, tapa: ancho * alto };
      });
      const mejor = candidatos.reduce((a, b) => (b.tapa < a.tapa ? b : a));
      left = mejor.left;
      top = mejor.top;
    } else {
      els.spot.hidden = true;
      els.overlay.classList.add("tour-plain");
      left = (vw - card.width) / 2;
      top = (vh - card.height) / 2;
    }
    els.card.style.left = Math.max(12, Math.min(left, vw - card.width - 12)) + "px";
    els.card.style.top = Math.max(12, Math.min(top, vh - card.height - 12)) + "px";
  }

  function go(index) {
    if (!current) return;
    if (index < 0) return;
    if (index >= current.steps.length) {
      end();
      return;
    }
    current.index = index;
    const step = current.steps[index];
    const { els } = current;
    if (step.before) step.before();
    els.count.textContent = "Paso " + (index + 1) + " de " + current.steps.length;
    els.title.textContent = step.title;
    els.text.textContent = step.text;
    els.back.disabled = index === 0;
    els.next.textContent = index === current.steps.length - 1 ? "Empezar" : "Siguiente";
    const target = resolveTarget(step);
    if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Se coloca ya (sin un instante con la tarjeta en la esquina) y otra vez tras
    // el desplazamiento, por si cambió algo (dos cuadros: el scroll es inmediato).
    place();
    requestAnimationFrame(() => requestAnimationFrame(place));
    els.next.focus();
  }

  function onKey(e) {
    if (!current) return;
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight") go(current.index + 1);
    else if (e.key === "ArrowLeft") go(current.index - 1);
    else return;
    e.preventDefault();
  }

  function end() {
    if (!current) return;
    const { els, onEnd } = current;
    current = null;
    els.overlay.remove();
    window.removeEventListener("resize", place);
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", place, true);
    if (onEnd) onEnd();
  }

  function start(steps, options = {}) {
    if (current || !steps.length) return;
    current = { steps, index: 0, onEnd: options.onEnd, els: build() };
    window.addEventListener("resize", place);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", place, true);
    go(0);
  }

  window.KopiaTutorial = { start, isRunning: () => !!current };
})();
