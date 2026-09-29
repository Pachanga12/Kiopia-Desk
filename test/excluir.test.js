"use strict";

// Excluir carpetas o archivos concretos (elegidos con el explorador) y el
// resumen del "Último backup" que se muestra en la tarjeta del destino.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  compileExcludes,
  excludedRelativePaths,
  scanDirectoryRecursive,
  createScanReport,
  summarizeLastBackup,
} = require("../lib/core.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kd-excluir-"));
}

function arbol() {
  const root = tmpDir();
  const w = (rel, txt = "x") => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, txt);
  };
  w("a.txt");
  w("Fotos/1.jpg");
  w("Fotos/Temp/borrador.jpg");
  w("Fotos/Temp/otro.jpg");
  w("Docs/informe.docx");
  w("Docs/secreto.txt");
  return root;
}

test("excluir una carpeta concreta salta todo su contenido, y un archivo concreto sólo ese", async () => {
  const root = arbol();
  const report = createScanReport();
  const excludes = compileExcludes(root, [], [path.join(root, "Fotos", "Temp"), path.join(root, "Docs", "secreto.txt")]);
  const files = await scanDirectoryRecursive(root, "", excludes, report);
  assert.deepEqual(Object.keys(files).sort(), ["Docs/informe.docx", "Fotos/1.jpg", "a.txt"]);
  assert.equal(report.excluded, 2, "la carpeta cuenta una vez y el archivo otra");
});

test("la ruta excluida no distingue mayúsculas (Windows) y se combina con los patrones por nombre", async () => {
  const root = arbol();
  const excludes = compileExcludes(root, ["*.docx"], [path.join(root, "FOTOS", "temp")]);
  const files = await scanDirectoryRecursive(root, "", excludes, createScanReport());
  assert.deepEqual(Object.keys(files).sort(), ["Docs/secreto.txt", "Fotos/1.jpg", "a.txt"]);
});

test("una carpeta con el mismo nombre en otro sitio NO se excluye (es por ruta, no por nombre)", async () => {
  const root = arbol();
  fs.mkdirSync(path.join(root, "Docs", "Temp"));
  fs.writeFileSync(path.join(root, "Docs", "Temp", "sigue.txt"), "x");
  const files = await scanDirectoryRecursive(root, "", compileExcludes(root, [], [path.join(root, "Fotos", "Temp")]), createScanReport());
  assert.ok(files["Docs/Temp/sigue.txt"]);
  assert.ok(!files["Fotos/Temp/otro.jpg"]);
});

test("rutas fuera de la carpeta escaneada, la carpeta misma o valores raros se ignoran", () => {
  const root = arbol();
  const otra = tmpDir();
  const set = excludedRelativePaths(root, [otra, root, path.join(root, ".."), "", null, 42, path.join(root, "Docs")]);
  assert.deepEqual([...set], ["docs"]);
  assert.equal(excludedRelativePaths(root, undefined).size, 0);
});

// --- Último backup -----------------------------------------------------------

function escribirLog(dir, source, stamp, report) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${source}_${stamp}.json`), JSON.stringify(report));
}

test("último backup: junta las carpetas de la corrida más reciente (misma marca run)", () => {
  const dir = path.join(tmpDir(), "logs");
  escribirLog(dir, "Viejo", "2026-09-01T10-00-00-000Z", { run: "r1", date: "2026-09-01T10:00:00.000Z", source: "Viejo", copied: 50, failed: [] });
  escribirLog(dir, "Fotos", "2026-09-28T22-14-00-000Z", { run: "r2", date: "2026-09-28T22:14:00.000Z", source: "Fotos", copied: 3, failed: [] });
  escribirLog(dir, "Docs", "2026-09-28T22-14-05-000Z", { run: "r2", date: "2026-09-28T22:14:05.000Z", source: "Docs", copied: 4, failed: [{ file: "x", error: "EBUSY" }] });
  const r = summarizeLastBackup(dir);
  assert.equal(r.date, "2026-09-28T22:14:05.000Z");
  assert.equal(r.copied, 7);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.sources, ["Fotos", "Docs"]);
});

test("último backup: informes viejos sin run cuentan solos; dañados o ajenos se saltan; sin carpeta = null", () => {
  const dir = path.join(tmpDir(), "logs");
  escribirLog(dir, "A", "2026-09-10T08-00-00-000Z", { date: "2026-09-10T08:00:00.000Z", source: "A", copied: 9, failed: [] });
  escribirLog(dir, "B", "2026-09-10T08-00-01-000Z", { date: "2026-09-10T08:00:01.000Z", source: "B", copied: 2, failed: [] });
  fs.writeFileSync(path.join(dir, "C_2026-09-11T08-00-00-000Z.json"), "{ dañado");
  fs.writeFileSync(path.join(dir, "notas.json"), JSON.stringify({ copied: 999 }));
  const r = summarizeLastBackup(dir);
  assert.equal(r.copied, 2, "sin run no se puede saber qué más era de esa corrida: sólo el más reciente");
  assert.deepEqual(r.sources, ["B"]);
  assert.equal(summarizeLastBackup(path.join(dir, "no-existe")), null);
  assert.equal(summarizeLastBackup(tmpDir()), null);
});

test("último backup: el orden es por la fecha del nombre, aunque el nombre de la carpeta lleve guiones bajos", () => {
  const dir = path.join(tmpDir(), "logs");
  escribirLog(dir, "zz_ultima_carpeta", "2026-09-01T00-00-00-000Z", { run: "a", date: "2026-09-01T00:00:00.000Z", source: "zz", copied: 1, failed: [] });
  escribirLog(dir, "aa", "2026-09-20T00-00-00-000Z", { run: "b", date: "2026-09-20T00:00:00.000Z", source: "aa", copied: 5, failed: [] });
  assert.equal(summarizeLastBackup(dir).copied, 5);
});

// --- Qué se excluyó y por qué (grupo "Excluidos por filtros") -------------------

test("el informe del escaneo dice qué se excluyó y por qué regla (patrón o elegido en Excluir)", async () => {
  const { EXCLUDED_BY_USER } = require("../lib/core.js");
  const root = arbol();
  fs.writeFileSync(path.join(root, "desktop.ini"), "x");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "x");
  const report = createScanReport();
  await scanDirectoryRecursive(root, "", compileExcludes(root, ["desktop.ini", ".git"], [path.join(root, "Fotos", "Temp")]), report);
  const items = report.excludedItems.map((i) => i.path + "|" + i.rule + "|" + i.folder).sort();
  assert.deepEqual(items, [".git|.git|true", "Fotos/Temp|" + EXCLUDED_BY_USER + "|true", "desktop.ini|desktop.ini|false"]);
  assert.equal(report.excluded, 3);
});

// --- Detener una copia -----------------------------------------------------------

test("runTasks con shouldStop deja de empezar tareas nuevas, pero termina las que están en curso", async () => {
  const { runTasks } = require("../lib/core.js");
  const empezadas = [];
  const terminadas = [];
  let parar = false;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const r = await runTasks(
    items,
    async (i) => {
      empezadas.push(i);
      if (i === 4) parar = true; // el usuario pulsa Detener mientras se copia el 5.º
      await new Promise((res) => setTimeout(res, 5));
      terminadas.push(i);
    },
    { concurrency: 2, shouldStop: () => parar }
  );
  assert.equal(r.stopped, true);
  assert.ok(empezadas.length < items.length, "no se empiezan todas");
  assert.deepEqual([...terminadas].sort((a, b) => a - b), [...empezadas].sort((a, b) => a - b), "toda tarea empezada termina");
});

test("runTasks sin detener devuelve stopped: false (también con la prueba adaptativa)", async () => {
  const { runTasks } = require("../lib/core.js");
  const r1 = await runTasks([1, 2, 3], async () => {}, { concurrency: 2 });
  assert.equal(r1.stopped, false);
  let n = 0;
  const r2 = await runTasks(Array.from({ length: 30 }, (_, i) => i), async () => n++, { adaptive: true, probeSize: 5 });
  assert.equal(r2.stopped, false);
  assert.equal(n, 30);
});
