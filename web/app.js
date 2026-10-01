"use strict";

// Kiopia Desk v4 — página del producto: barra, animaciones al hacer scroll, luz
// que sigue al cursor, demo del cifrado, historia de versiones y preguntas.

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // --- Barra: fondo al bajar, menú en móvil y sección activa --------------------------
  const barra = $("#barra");
  const menuBoton = $("#menuBoton");
  const alBajar = () => barra.classList.toggle("con-fondo", window.scrollY > 8);
  alBajar();
  window.addEventListener("scroll", alBajar, { passive: true });

  function cerrarMenu() {
    barra.classList.remove("menu-abierto");
    menuBoton.setAttribute("aria-expanded", "false");
    menuBoton.setAttribute("aria-label", "Abrir el menú");
  }
  menuBoton.addEventListener("click", () => {
    const abierto = barra.classList.toggle("menu-abierto");
    menuBoton.setAttribute("aria-expanded", String(abierto));
    menuBoton.setAttribute("aria-label", abierto ? "Cerrar el menú" : "Abrir el menú");
  });
  $$("#menu a").forEach((a) => a.addEventListener("click", cerrarMenu));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cerrarMenu();
  });

  const enlaces = new Map($$("#menu a").map((a) => [a.getAttribute("href").slice(1), a]));
  if ("IntersectionObserver" in window) {
    const activa = new IntersectionObserver(
      (entradas) => {
        for (const en of entradas) {
          if (!en.isIntersecting) continue;
          enlaces.forEach((a) => a.classList.remove("activa"));
          const a = enlaces.get(en.target.id);
          if (a) a.classList.add("activa");
        }
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    enlaces.forEach((_, id) => {
      const s = document.getElementById(id);
      if (s) activa.observe(s);
    });
  }

  // --- Aurora de la portada: quieta cuando no se ve (no gasta batería) --------------------
  const aurora = $("#aurora");
  if (aurora && "IntersectionObserver" in window) {
    new IntersectionObserver((entradas) => {
      for (const en of entradas) aurora.classList.toggle("quieta", !en.isIntersecting);
    }).observe(aurora);
  }

  // --- Animación de entrada (una vez por visita) -----------------------------------------
  // js-activo.js decide en la cabecera si toca (pone .con-intro). Dura ~2 s y se
  // salta con un clic, una tecla o la rueda. Cuando termina, entra la página.
  const DURACION_INTRO = 2000;
  const SALIDA_INTRO = 650;
  const raiz = document.documentElement;
  const introLista = new Promise((listo) => {
    const intro = $("#intro");
    if (!raiz.classList.contains("con-intro") || !intro) {
      if (intro) intro.remove();
      listo();
      return;
    }
    try {
      sessionStorage.setItem("kd-intro", "1");
    } catch {
      // sin almacenamiento: saldrá en cada visita
    }
    let saliendo = false;
    const salir = () => {
      if (saliendo) return;
      saliendo = true;
      quitarAtajos();
      raiz.classList.add("intro-saliendo");
      listo(); // la portada empieza a aparecer mientras la intro se desvanece
      setTimeout(() => {
        raiz.classList.remove("con-intro", "intro-saliendo");
        intro.remove();
      }, SALIDA_INTRO);
    };
    const atajos = ["pointerdown", "keydown", "wheel", "touchstart"];
    const quitarAtajos = () => atajos.forEach((ev) => window.removeEventListener(ev, salir));
    atajos.forEach((ev) => window.addEventListener(ev, salir, { passive: true }));
    // Contado desde que se abrió la página (la animación empieza al dibujarse, no
    // cuando llega este archivo): con conexión lenta no dura más.
    setTimeout(salir, Math.max(300, DURACION_INTRO - performance.now()));
  });
  window.KD_INTRO = introLista; // para las pruebas

  // --- Aparecer al hacer scroll ---------------------------------------------------------
  // Después de la intro: si no, los bloques de la portada aparecerían escondidos debajo.
  const aparecen = $$(".aparece");
  if (!("IntersectionObserver" in window)) {
    aparecen.forEach((el) => el.classList.add("visible"));
  } else {
    introLista.then(() => {
      const obs = new IntersectionObserver(
        (entradas) => {
          for (const en of entradas) {
            if (!en.isIntersecting) continue;
            en.target.classList.add("visible");
            obs.unobserve(en.target);
          }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
      );
      // Los hermanos aparecen uno detrás de otro.
      aparecen.forEach((el) => {
        const hermanos = [...el.parentElement.children].filter((h) => h.classList.contains("aparece"));
        el.style.transitionDelay = Math.min(hermanos.indexOf(el), 6) * 70 + "ms";
        obs.observe(el);
      });
    });
  }

  // --- Luz que sigue al cursor -------------------------------------------------------------
  if (window.matchMedia("(pointer: fine)").matches) {
    $$(".luz").forEach((el) => {
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", e.clientX - r.left + "px");
        el.style.setProperty("--my", e.clientY - r.top + "px");
      });
    });
  }

  // --- Cifras que cuentan hacia arriba ------------------------------------------------------
  const contar = (el) => {
    const fin = Number(el.dataset.contar);
    const sufijo = el.dataset.sufijo || "";
    const t0 = performance.now();
    const paso = (t) => {
      const p = Math.min(1, (t - t0) / 1200);
      el.textContent = Math.round(fin * (1 - Math.pow(1 - p, 3))) + sufijo;
      if (p < 1) requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  };
  const cifras = $$("[data-contar]");
  if ("IntersectionObserver" in window) {
    const obs = new IntersectionObserver((entradas) => {
      for (const en of entradas) {
        if (!en.isIntersecting) continue;
        contar(en.target);
        obs.unobserve(en.target);
      }
    });
    cifras.forEach((c) => obs.observe(c));
  } else {
    cifras.forEach(contar);
  }

  // --- Demo del cifrado -------------------------------------------------------------------
  // Nombres opacos con HMAC-SHA-256 y contenido con AES-256-CBC (clave derivada con
  // PBKDF2), igual que Kiopia Desk, pero en el navegador. Sin WebCrypto, se imita.
  const CLAVE_DEMO = "kiopia2026";
  const ARCHIVOS = [
    { ruta: "Fotos/Vacaciones 2025/playa al atardecer.jpg", tam: "2,4 MB", texto: "(foto JPEG de 4032 × 3024 píxeles)" },
    { ruta: "Fotos/Vacaciones 2025/cumpleaños de Sofía.jpg", tam: "3,1 MB", texto: "(foto JPEG de 4032 × 3024 píxeles)" },
    { ruta: "Documentos/notas privadas.txt", tam: "1 KB", texto: "Wi-Fi de casa: SalónAzul-5G\nClave del trastero: 4 8 1 5\nPedir cita al dentista el martes.\nRegalo de Sofía: la bici roja." },
    { ruta: "Documentos/presupuesto 2026.xlsx", tam: "48 KB", texto: "(hoja de cálculo: ingresos, gastos y ahorro por meses)" },
    { ruta: "Documentos/contrato del piso.pdf", tam: "820 KB", texto: "(documento PDF de 12 páginas)" },
  ];
  const LANZADOR = '@echo off\nrem Abre las copias cifradas de Kiopia Desk sin Kiopia Desk.\nstart "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA\n  -WindowStyle Hidden -File "%~dp0Recuperar-KiopiaDesk.ps1" -Accion Abrir';
  const LEEME = "ESTE BACKUP DE KIOPIA DESK ESTÁ CIFRADO\n\nPara ver o sacar tus archivos sin Kiopia Desk:\ndoble clic en Abrir-KiopiaDesk.cmd. Pide la\ncontraseña (o la clave de recuperación)...";

  const demo = $("#demo");
  const lista = $("#demoLista");
  const vista = $("#demoVista");
  const vistaTitulo = $("#demoVistaTitulo");
  const estado = $("#demoEstado");
  const botonCifrar = $("#demoCifrar");
  const formAbrir = $("#demoAbrir");
  const entradaClave = $("#demoClave");
  const errorClave = $("#demoError");

  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const subtle = window.crypto && window.crypto.subtle;
  let cifrado = null; // { nombres: Map ruta→opaco, datos: Map ruta→hex }
  let elegido = "Documentos/notas privadas.txt";
  let cifrando = false;

  async function prepararCifrado() {
    const sal = enc.encode("kopia-desk-demo");
    const nombres = new Map();
    const datos = new Map();
    if (subtle) {
      try {
        const base = await subtle.importKey("raw", enc.encode(CLAVE_DEMO), "PBKDF2", false, ["deriveBits"]);
        const bits = new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: 20000 }, base, 512));
        const kNombre = await subtle.importKey("raw", bits.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const kDatos = await subtle.importKey("raw", bits.slice(0, 32), "AES-CBC", false, ["encrypt"]);
        for (const a of ARCHIVOS) {
          const h = hex(await subtle.sign("HMAC", kNombre, enc.encode("archivo\0" + a.ruta)));
          nombres.set(a.ruta, h.slice(0, 2) + "/" + h.slice(2, 40) + ".kdc");
          const iv = crypto.getRandomValues(new Uint8Array(16));
          const c = await subtle.encrypt({ name: "AES-CBC", iv }, kDatos, enc.encode(a.texto.repeat(6)));
          datos.set(a.ruta, "4b444331" + hex(iv) + hex(c)); // "KDC1" + iv + datos
        }
        return { nombres, datos };
      } catch {
        // sigue con la imitación
      }
    }
    // Sin WebCrypto (p. ej. un navegador antiguo): se imita el resultado.
    let semilla = 7;
    const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2147483648), semilla);
    const hexAzar = (n) => Array.from({ length: n }, () => (azar() % 16).toString(16)).join("");
    for (const a of ARCHIVOS) {
      const h = hexAzar(40);
      nombres.set(a.ruta, h.slice(0, 2) + "/" + h.slice(2) + ".kdc");
      datos.set(a.ruta, "4b444331" + hexAzar(600));
    }
    return { nombres, datos };
  }

  function volcado(hexTexto) {
    // Como un visor hexadecimal: grupos de 2 caracteres.
    return hexTexto
      .slice(0, 560)
      .match(/.{1,32}/g)
      .map((l) => l.match(/.{1,2}/g).join(" "))
      .join("\n") + "\n…";
  }

  function fila(ico, texto, { nivel = 0, tipo = "carpeta", clase = "", clave = null } = {}) {
    const li = document.createElement("li");
    li.dataset.nivel = String(nivel);
    li.dataset.tipo = tipo;
    if (clase) li.className = clase;
    if (clave) li.dataset.clave = clave;
    const i = document.createElement("span");
    i.className = "ico";
    i.setAttribute("aria-hidden", "true");
    i.textContent = ico;
    const n = document.createElement("span");
    n.className = "nombre";
    n.textContent = texto;
    li.append(i, n);
    if (tipo === "archivo") {
      li.tabIndex = 0;
      li.setAttribute("role", "button");
    }
    return li;
  }

  function pintarClaro() {
    lista.textContent = "";
    const carpetas = new Map();
    for (const a of ARCHIVOS) {
      const partes = a.ruta.split("/");
      let camino = "";
      partes.slice(0, -1).forEach((p, i) => {
        camino += (camino ? "/" : "") + p;
        if (!carpetas.has(camino)) {
          carpetas.set(camino, true);
          lista.append(fila("📁", p, { nivel: i }));
        }
      });
      const esFoto = a.ruta.endsWith(".jpg");
      lista.append(fila(esFoto ? "🖼️" : "📄", partes[partes.length - 1] + "  ·  " + a.tam, { nivel: partes.length - 1, tipo: "archivo", clave: a.ruta }));
    }
  }

  function pintarCifrado() {
    lista.textContent = "";
    lista.append(fila("🟢", "Abrir-KiopiaDesk.cmd", { tipo: "archivo", clase: "herramienta", clave: "#lanzador" }));
    lista.append(fila("🟢", "Kiopia Desk (portable).exe", { tipo: "archivo", clase: "herramienta", clave: "#portable" }));
    lista.append(fila("📄", "LEEME-CIFRADO.txt", { tipo: "archivo", clave: "#leeme" }));
    lista.append(fila("📁", ".kiopia-data  (oculta)", { clase: "meta" }));
    lista.append(fila("📁", "datos", {}));
    for (const a of ARCHIVOS) {
      lista.append(fila("🔒", cifrado.nombres.get(a.ruta), { nivel: 1, tipo: "archivo", clave: a.ruta }));
    }
  }

  function mostrar(clave) {
    elegido = clave;
    $$("li", lista).forEach((li) => li.classList.toggle("elegido", li.dataset.clave === clave));
    const a = ARCHIVOS.find((x) => x.ruta === clave);
    if (demo.dataset.estado === "claro") {
      vistaTitulo.textContent = a ? a.ruta.split("/").pop() : "";
      vista.textContent = a ? a.texto : "";
      return;
    }
    if (clave === "#lanzador") {
      vistaTitulo.textContent = "Abrir-KiopiaDesk.cmd  (solo lectura)";
      vista.textContent = LANZADOR;
    } else if (clave === "#portable") {
      vistaTitulo.textContent = "Kiopia Desk (portable).exe";
      vista.textContent = "Kiopia Desk completa en un solo archivo.\nSe abre en cualquier Windows sin instalar nada.";
    } else if (clave === "#leeme") {
      vistaTitulo.textContent = "LEEME-CIFRADO.txt";
      vista.textContent = LEEME;
    } else if (a) {
      vistaTitulo.textContent = "datos/" + cifrado.nombres.get(a.ruta) + "  —  ¿qué archivo es? Nadie lo sabe.";
      vista.textContent = volcado(cifrado.datos.get(a.ruta));
    }
  }

  // Los nombres se «revuelven» hasta convertirse en el texto final.
  function revolver(els, finales, ms, alTerminar) {
    const signos = "0123456789abcdef";
    const t0 = performance.now();
    const paso = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      els.forEach((el, i) => {
        const fin = finales[i];
        const listos = Math.floor(fin.length * p);
        let s = fin.slice(0, listos);
        for (let k = listos; k < fin.length; k++) s += fin[k] === "/" || fin[k] === " " ? fin[k] : signos[(Math.random() * 16) | 0];
        el.textContent = s;
        el.classList.toggle("revuelto", p < 1);
      });
      if (p < 1) requestAnimationFrame(paso);
      else alTerminar();
    };
    requestAnimationFrame(paso);
  }

  async function cifrar() {
    if (cifrando) return;
    cifrando = true;
    botonCifrar.disabled = true;
    if (!cifrado) cifrado = await prepararCifrado();
    const filas = $$("li[data-tipo='archivo']", lista);
    const destinos = filas.map((li) => cifrado.nombres.get(li.dataset.clave));
    const a = ARCHIVOS.find((x) => x.ruta === elegido) || ARCHIVOS[2];
    vista.textContent = volcado(cifrado.datos.get(a.ruta));
    revolver(
      filas.map((li) => $(".nombre", li)),
      destinos,
      900,
      () => {
        demo.dataset.estado = "cifrado";
        estado.textContent = "Cifrado: sin la contraseña no se ve ni un nombre";
        pintarCifrado();
        mostrar(elegido.startsWith("#") ? "Documentos/notas privadas.txt" : elegido);
        botonCifrar.hidden = true;
        botonCifrar.disabled = false;
        formAbrir.hidden = false;
        errorClave.textContent = "";
        cifrando = false;
      }
    );
  }

  function abrir(e) {
    e.preventDefault();
    if (cifrando) return;
    if (entradaClave.value !== CLAVE_DEMO) {
      errorClave.textContent = entradaClave.value ? "No es correcta (en esta demo es «" + CLAVE_DEMO + "»)." : "Escribe la contraseña.";
      formAbrir.classList.remove("agita");
      void formAbrir.offsetWidth;
      formAbrir.classList.add("agita");
      entradaClave.focus();
      return;
    }
    cifrando = true;
    entradaClave.value = "";
    const filas = $$("li[data-tipo='archivo']", lista).filter((li) => !li.dataset.clave.startsWith("#"));
    revolver(
      filas.map((li) => $(".nombre", li)),
      filas.map((li) => li.dataset.clave.split("/").pop()),
      700,
      () => {
        demo.dataset.estado = "claro";
        estado.textContent = "Abierto con la contraseña: tus archivos, tal cual";
        pintarClaro();
        mostrar(elegido.startsWith("#") ? "Documentos/notas privadas.txt" : elegido);
        formAbrir.hidden = true;
        botonCifrar.hidden = false;
        botonCifrar.focus();
        cifrando = false;
        setTimeout(() => {
          if (demo.dataset.estado === "claro") estado.textContent = "Sin cifrar: cualquiera lo ve todo";
        }, 3500);
      }
    );
  }

  if (demo) {
    pintarClaro();
    mostrar(elegido);
    botonCifrar.addEventListener("click", cifrar);
    formAbrir.addEventListener("submit", abrir);
    lista.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-tipo='archivo']");
      if (li && !cifrando) mostrar(li.dataset.clave);
    });
    lista.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches("li[data-tipo='archivo']")) {
        e.preventDefault();
        if (!cifrando) mostrar(e.target.dataset.clave);
      }
    });
    // Se prepara al acercarse, para que «Cifrar» sea instantáneo.
    prepararCifrado().then((c) => (cifrado = c));
  }

  // --- Historia de versiones -------------------------------------------------------------
  const versiones = window.KD_VERSIONES || [];
  const linea = $("#linea");
  const detalle = $("#detalle");
  const HITOS = new Set(["V0.1", "V0.6", "V1.0", "V2.0", "V3.0", "V4.0"]);

  function elegirVersion(i, enfocar, desplazar = true) {
    const x = versiones[i];
    if (!x) return;
    $$(".hito", linea).forEach((b, k) => {
      b.setAttribute("aria-selected", String(k === i));
      b.tabIndex = k === i ? 0 : -1;
    });
    const boton = $$(".hito", linea)[i];
    if (enfocar) boton.focus();
    if (desplazar) boton.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });

    detalle.textContent = "";
    detalle.classList.remove("cambia");
    void detalle.offsetWidth;
    detalle.classList.add("cambia");
    const cabeza = document.createElement("div");
    cabeza.className = "detalle-cabeza";
    const h = document.createElement("h3");
    h.textContent = x.v + (x.nombre ? " · " + x.nombre : "");
    cabeza.append(h);
    const chips = [x.fecha, x.tipo];
    for (const c of chips) {
      const s = document.createElement("span");
      s.className = "chip";
      s.textContent = c;
      cabeza.append(s);
    }
    if (i === versiones.length - 1) {
      const s = document.createElement("span");
      s.className = "chip actual";
      s.textContent = "La que descargas";
      cabeza.append(s);
    }
    const r = document.createElement("p");
    r.className = "detalle-resumen";
    r.textContent = x.resumen;
    detalle.append(cabeza, r);
    if (x.puntos && x.puntos.length) {
      const ul = document.createElement("ul");
      for (const p of x.puntos) {
        const li = document.createElement("li");
        li.textContent = p;
        ul.append(li);
      }
      detalle.append(ul);
    }
    const nav = document.createElement("div");
    nav.className = "detalle-nav";
    const antes = document.createElement("button");
    antes.type = "button";
    antes.className = "boton boton-fantasma boton-sm";
    antes.textContent = "← " + (versiones[i - 1] ? versiones[i - 1].v : "");
    antes.disabled = i === 0;
    antes.style.visibility = i === 0 ? "hidden" : "visible";
    antes.addEventListener("click", () => elegirVersion(i - 1));
    const despues = document.createElement("button");
    despues.type = "button";
    despues.className = "boton boton-fantasma boton-sm";
    despues.textContent = (versiones[i + 1] ? versiones[i + 1].v : "") + " →";
    despues.style.visibility = i === versiones.length - 1 ? "hidden" : "visible";
    despues.addEventListener("click", () => elegirVersion(i + 1));
    nav.append(antes, despues);
    detalle.append(nav);
  }

  if (linea && versiones.length) {
    versiones.forEach((x, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hito" + (HITOS.has(x.v) ? " grande" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-controls", "detalle");
      b.textContent = x.v;
      b.title = x.v + (x.nombre ? " · " + x.nombre : "") + " — " + x.fecha;
      b.addEventListener("click", () => elegirVersion(i));
      linea.append(b);
    });
    linea.addEventListener("keydown", (e) => {
      const actual = $$(".hito", linea).findIndex((b) => b.getAttribute("aria-selected") === "true");
      let n = null;
      if (e.key === "ArrowRight") n = Math.min(versiones.length - 1, actual + 1);
      if (e.key === "ArrowLeft") n = Math.max(0, actual - 1);
      if (e.key === "Home") n = 0;
      if (e.key === "End") n = versiones.length - 1;
      if (n !== null) {
        e.preventDefault();
        elegirVersion(n, true);
      }
    });
    // Empieza en la última (la v4), sin mover la página.
    const ultima = versiones.length - 1;
    $$(".hito", linea).forEach((b, k) => {
      b.setAttribute("aria-selected", String(k === ultima));
      b.tabIndex = k === ultima ? 0 : -1;
    });
    // Sin desplazar la página hacia la línea de tiempo: sólo la línea, al final.
    elegirVersion(ultima, false, false);
    linea.scrollLeft = linea.scrollWidth;
  }

  // --- Preguntas: una abierta a la vez ----------------------------------------------------------
  const preguntas = $$("#listaPreguntas details");
  preguntas.forEach((d) =>
    d.addEventListener("toggle", () => {
      if (d.open) preguntas.forEach((o) => o !== d && (o.open = false));
    })
  );
})();
