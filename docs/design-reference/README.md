# Referencia de diseño — "Kopia Fluent Obsidian"

`kopia-fluent-obsidian-mockup.zip` contiene un mockup estático (Stitch/IA) con
la propuesta de rediseño visual "Kopia Fluent Obsidian" (Windows 11 Fluent 2 +
Mica oscuro, acento cobalto): `code.html` (HTML con Tailwind vía CDN + Google
Fonts), `screen.png` (captura) y `DESIGN.md` (tokens de color, tipografía,
espaciado y specs de componentes).

**No se puede usar tal cual en la app.** `code.html` carga Tailwind y Google
Fonts desde CDN, pero la CSP de `renderer/index.html` es
`script-src 'self'; style-src 'self'`, así que esos recursos externos
simplemente no cargarían dentro de Electron. Además el mockup usa datos de
ejemplo inventados (carpetas, discos, estadísticas ficticias), no está
conectado a ninguna lógica real.

El lenguaje visual que propone ya está implementado de forma nativa,
CSP-safe, en `renderer/styles.css` (mismo nombre, "Fluent Obsidian": paleta
oscura con variables CSS, tipografía del sistema en vez de Google Fonts, sin
dependencias externas), conectado a la lógica real de la app. Este zip queda
sólo como referencia de diseño (paleta exacta, tokens de espaciado) por si se
quiere afinar algún detalle visual más adelante — no hace falta integrarlo de
nuevo.
