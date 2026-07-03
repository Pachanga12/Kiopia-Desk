# Guía por carpetas — Kopia Desk

Esta carpeta explica **qué hace cada carpeta del proyecto y cómo se conectan entre
sí**. Si `docs/arquitectura.md` es el mapa técnico (IPC, seguridad), esta guía es
el recorrido: por dónde empezar a leer el código según lo que quieras entender.

## Mapa del proyecto

```
Kopia_Desk_Beta_1/
├── main.js              ← Cerebro de la app: todo lo que toca el disco pasa por aquí
├── preload.js            ← Puente seguro entre main.js y la interfaz
├── package.json           ← Nombre, versión, dependencias y scripts (npm start / npm run build)
├── package-lock.json      ← Versiones exactas instaladas (lo genera npm, no se edita a mano)
│
├── assets/                ← Icono de la app
│   └── Kopia_Desk.png
│
├── renderer/              ← Todo lo que el usuario ve y toca
│   ├── index.html          ← Estructura de la pantalla
│   ├── app.js              ← Lógica de la interfaz (botones, escaneo, backup, restauración)
│   └── styles.css          ← Estilos visuales
│
├── docs/                  ← Documentación (este archivo vive aquí)
│   ├── arquitectura.md      ← Mapa técnico: canales IPC, seguridad, flujo de backup
│   └── estructura-carpetas/ ← Esta guía, un archivo por carpeta
│
├── dist/                  ← Se genera al ejecutar `npm run build` (el instalador .exe)
│   └── ...
│
└── node_modules/          ← Dependencias instaladas por npm (no se toca a mano)
```

## Por dónde empezar según lo que quieras hacer

| Quiero... | Empieza por... |
|---|---|
| Entender qué pasa cuando el usuario aprieta "Escanear cambios" o "Copiar aceptados" | [renderer.md](./renderer.md) → función `scanAll()` / `backupAll()` |
| Entender cómo se lee/escribe el disco o se deduplica | [raiz.md](./raiz.md) → `main.js` |
| Saber qué aspecto tiene la ventana y cómo se organizan los controles | [renderer.md](./renderer.md) → `index.html` / `styles.css` |
| Ver la lista completa de canales IPC (los "mensajes" entre interfaz y disco) | [../arquitectura.md](../arquitectura.md) |
| Saber qué contiene el instalador generado | [dist.md](./dist.md) |

## Los tres archivos que hay que entender primero

1. **`main.js`** corre con acceso total al sistema operativo (Node.js). Es el
   único archivo que lee, escribe, comprime o borra archivos de verdad.
2. **`preload.js`** es la lista exacta de lo que la interfaz puede pedirle a
   `main.js`. Si una función no está aquí, la interfaz no puede usarla — es la
   barrera de seguridad de Electron.
3. **`renderer/app.js`** corre en la ventana (sin acceso a Node.js) y sólo puede
   hablar con `main.js` a través de lo que expone `preload.js` mediante
   `window.kopiaAPI`.

Cada uno de estos tres tiene su propio archivo detallado en esta carpeta.
