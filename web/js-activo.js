"use strict";
// Va en la cabecera para que no se vea un parpadeo al cargar:
// - «js»: con JavaScript, los bloques aparecen al hacer scroll (sin él, se ven todos).
// - «con-intro»: la animación de entrada (logo y nombre), una vez por visita.
document.documentElement.classList.add("js");
try {
  if (!sessionStorage.getItem("kd-intro")) document.documentElement.classList.add("con-intro");
} catch {
  document.documentElement.classList.add("con-intro");
}
// Por seguridad: si app.js no llega a cargar (red, bloqueador), a los 5 s se
// quita la intro y se muestra todo sin animaciones, en vez de quedarse oculto.
setTimeout(() => {
  if (!window.KD_INTRO) document.documentElement.classList.remove("con-intro", "js");
}, 5000);
