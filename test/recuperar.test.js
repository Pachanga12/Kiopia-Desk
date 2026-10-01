"use strict";

// Recuperar un backup cifrado SIN Kiopia Desk: el backup lo hace Node (las mismas
// piezas que usa la app) y lo abre el Recuperar-KiopiaDesk.ps1 que quedó copiado
// en el propio disco, con PowerShell, como lo haría alguien en otro equipo.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const core = require("../lib/core.js");
const almacen = require("../lib/almacen.js");

const soloWindows = { skip: process.platform !== "win32" && "requiere Windows (PowerShell)" };
const SCRIPT = path.join(__dirname, "..", "lib", "Recuperar-KiopiaDesk.ps1");
const PASSWORD = "Contraseña Ñandú €9!";

// Nombres difíciles: tildes, eñes, apóstrofo, corchetes, &, %, emoji.
const ARCHIVOS = {
  Fotos: {
    "año 2025/niño's día.jpg": crypto.randomBytes(70000),
    "año 2025/[final] & copia 100%.png": crypto.randomBytes(1234),
    "🎉 fiesta.txt": Buffer.from("¡Hola, mundo!"),
    "vacío.txt": Buffer.alloc(0),
    "grande.bin": crypto.randomBytes(9 * 1024 * 1024 + 5), // más de dos bloques de 4 MB
  },
  "Documentos del trabajo": {
    "informe.docx": crypto.randomBytes(5000),
    // Ruta de más de 260 caracteres al recuperarla.
    [Array.from({ length: 6 }, (_, i) => "carpeta con un nombre bastante largo número " + i).join("/") + "/profundo.txt"]: Buffer.from("muy adentro"),
  },
};

async function hacerBackup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kd-recuperar-"));
  t.after(() => fs.rmSync("\\\\?\\" + dir, { recursive: true, force: true }));
  const usb = path.join(dir, "USB");
  fs.mkdirSync(usb);
  const { masterKey: mk, recoveryKey } = almacen.enableEncryption(usb, PASSWORD, { iterations: 1000, scriptSource: SCRIPT });
  const fechas = {};
  for (const [fuente, files] of Object.entries(ARCHIVOS)) {
    const src = path.join(dir, "origen", fuente);
    const ctx = { index: new core.ContentIndex(), pendingWrites: new Map(), madeDirs: new Set(), masterKey: mk };
    const manifest = {};
    let i = 0;
    for (const [rel, data] of Object.entries(files)) {
      const full = "\\\\?\\" + path.join(src, ...rel.split("/"));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, data);
      const when = new Date(Date.UTC(2020, 0, 1 + i++, 10, 20, 30));
      fs.utimesSync(full, when, when);
      const { relative } = almacen.dataRelative(mk, "KiopiaDesk_Backup/" + core.safeName(fuente) + "/" + rel);
      const r = await core.copyOneTask({ srcPath: full, destRoot: usb, relativeDest: relative, dedup: true }, ctx);
      manifest[rel] = { path: rel, size: data.length, lastModified: when.getTime(), hash: r.hash };
      fechas[fuente + "/" + rel] = when.getTime();
    }
    almacen.saveManifest(usb, mk, fuente, manifest);
  }
  return { dir, usb, mk, recoveryKey, fechas, root: path.join(usb, "KiopiaDesk_Backup") };
}

// Ejecuta el script COPIADO en el disco, sin ventana. `backup` es lo que se
// le pasa en -Backup (la carpeta KiopiaDesk_Backup o la raíz del disco).
function recuperar(root, destino, secreto, extra = [], backup = root) {
  const script = path.join(root, "Recuperar-KiopiaDesk.ps1");
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Accion", "Recuperar", "-Backup", backup, "-Destino", destino, "-Secreto", secreto, ...extra],
    { encoding: "utf-8", timeout: 180000 }
  );
  const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("KD-RESUMEN "));
  return { status: r.status, out: r.stdout, err: r.stderr, resumen: line ? JSON.parse(line.slice(11)) : null };
}

const leer = (p) => fs.readFileSync("\\\\?\\" + p);

test("sin la app: el script del disco recupera todo, con sus nombres, carpetas, contenido y fechas", soloWindows, async (t) => {
  const b = await hacerBackup(t);
  assert.ok(fs.existsSync(path.join(b.root, "Abrir-KiopiaDesk.cmd")), "queda el lanzador de doble clic");
  const destino = path.join(b.dir, "Recuperado");
  const r = recuperar(b.root, destino, PASSWORD);
  assert.equal(r.status, 0, r.out + r.err);
  const total = Object.values(ARCHIVOS).reduce((n, f) => n + Object.keys(f).length, 0);
  assert.deepEqual(r.resumen, { recuperados: total, total, fallidos: 0, faltan: 0 });
  for (const [fuente, files] of Object.entries(ARCHIVOS)) {
    for (const [rel, data] of Object.entries(files)) {
      const out = path.join(destino, core.safeName(fuente), ...rel.split("/"));
      assert.ok(leer(out).equals(data), rel);
      const mtime = fs.statSync("\\\\?\\" + out).mtimeMs;
      assert.ok(Math.abs(mtime - b.fechas[fuente + "/" + rel]) < 1000, "fecha original: " + rel);
    }
  }
  const largo = path.join(destino, "Documentos del trabajo", ...Object.keys(ARCHIVOS["Documentos del trabajo"])[1].split("/"));
  assert.ok(largo.length > 260, "la prueba de ruta larga pasa de 260 caracteres");
  const restos = [];
  (function buscar(d) {
    for (const e of fs.readdirSync("\\\\?\\" + d, { withFileTypes: true })) {
      if (e.isDirectory()) buscar(path.join(d, e.name));
      else if (e.name.endsWith(".kiopia-tmp")) restos.push(e.name);
    }
  })(destino);
  assert.deepEqual(restos, [], "no quedan temporales");
});

test("sin la app: con la clave de recuperación, sólo una carpeta, desde la raíz del disco", soloWindows, async (t) => {
  const b = await hacerBackup(t);
  const destino = path.join(b.dir, "Solo docs");
  const r = recuperar(b.root, destino, b.recoveryKey.toLowerCase(), ["-Carpeta", "Documentos del trabajo"], b.usb);
  assert.equal(r.status, 0, r.out + r.err);
  assert.equal(r.resumen.recuperados, 2);
  assert.deepEqual(fs.readdirSync(destino), ["Documentos del trabajo"]);
  assert.ok(leer(path.join(destino, "Documentos del trabajo", "informe.docx")).equals(ARCHIVOS["Documentos del trabajo"]["informe.docx"]));
});

test("sin la app: una contraseña equivocada no recupera nada", soloWindows, async (t) => {
  const b = await hacerBackup(t);
  const destino = path.join(b.dir, "Nada");
  const r = recuperar(b.root, destino, "contraseña ñandú €9!");
  assert.notEqual(r.status, 0);
  assert.equal(r.resumen, null);
  assert.match(r.err + r.out, /no es correcta/);
  assert.equal(fs.existsSync(destino) && fs.readdirSync(destino).length > 0, false);
});

test("sin la app: un archivo alterado o borrado se informa, no se entrega, y los demás se recuperan", soloWindows, async (t) => {
  const b = await hacerBackup(t);
  const alterado = almacen.dataPath(b.usb, b.mk, "Fotos", "año 2025/niño's día.jpg");
  const blob = fs.readFileSync(alterado);
  blob[500] ^= 1;
  fs.writeFileSync(alterado, blob);
  fs.unlinkSync(almacen.dataPath(b.usb, b.mk, "Fotos", "🎉 fiesta.txt"));
  const destino = path.join(b.dir, "Parcial");
  const r = recuperar(b.root, destino, PASSWORD, ["-Carpeta", "Fotos"]);
  assert.equal(r.status, 1, "termina avisando que hubo fallos");
  assert.deepEqual(r.resumen, { recuperados: 3, total: 5, fallidos: 2, faltan: 1 });
  assert.equal(fs.existsSync(path.join(destino, "Fotos", "año 2025", "niño's día.jpg")), false, "lo alterado no se entrega");
  assert.equal(fs.existsSync(path.join(destino, "Fotos", "año 2025", "niño's día.jpg.kiopia-tmp")), false);
  assert.ok(leer(path.join(destino, "Fotos", "grande.bin")).equals(ARCHIVOS.Fotos["grande.bin"]));
});

test("sin la app: no pisa nada que ya exista en el destino (guarda «nombre (2)»)", soloWindows, async (t) => {
  const b = await hacerBackup(t);
  const destino = path.join(b.dir, "Existente");
  const previo = path.join(destino, "Fotos", "🎉 fiesta.txt");
  fs.mkdirSync(path.dirname(previo), { recursive: true });
  fs.writeFileSync(previo, "lo que ya había");
  const r = recuperar(b.root, destino, PASSWORD, ["-Carpeta", "Fotos"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.equal(fs.readFileSync(previo, "utf8"), "lo que ya había", "el archivo que ya estaba sigue igual");
  assert.equal(fs.readFileSync(path.join(destino, "Fotos", "🎉 fiesta (2).txt"), "utf8"), "¡Hola, mundo!");
});

test("sin la app: si un registro de carpeta se daña, se usa su copia anterior y se avisa", soloWindows, async (t) => {
  const b = await hacerBackup(t);
  // Una segunda copia del registro deja la anterior como .prev.kdc.
  const { manifest } = almacen.loadManifest(b.usb, b.mk, "Documentos del trabajo");
  almacen.saveManifest(b.usb, b.mk, "Documentos del trabajo", manifest);
  fs.writeFileSync(almacen.manifestPath(b.usb, b.mk, "Documentos del trabajo"), Buffer.from("KDC1" + "x".repeat(100)));
  const destino = path.join(b.dir, "ConPrev");
  const r = recuperar(b.root, destino, PASSWORD, ["-Carpeta", "Documentos del trabajo"]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.equal(r.resumen.recuperados, 2);
  assert.match(r.out, /Aviso: .*copia anterior/);
});
