"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  DEFAULT_EXCLUDES,
  safeName,
  safePath,
  compileExcludePatterns,
  isExcluded,
  scanDirectoryRecursive,
  hashFileAsync,
  quickHashFile,
  pickConcurrency,
  startJournal,
  appendJournalDone,
  finishJournal,
  peekJournals,
  checkJournals,
} = require("../lib/core.js");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kopia-core-test-"));
}

// --- safeName --------------------------------------------------------------

test("safeName reemplaza caracteres inválidos de nombres de archivo", () => {
  assert.equal(safeName('Fotos:2023<>|?*"'), "Fotos_2023______");
});

test("safeName trunca a 120 caracteres", () => {
  const long = "a".repeat(200);
  assert.equal(safeName(long).length, 120);
});

test("safeName nunca devuelve string vacío", () => {
  assert.equal(safeName(""), "carpeta");
});

test("safeName reemplaza barras pero no las considera vacías", () => {
  assert.equal(safeName("///"), "___");
});

// --- safePath ----------------------------------------------------------------

test("safePath resuelve una ruta relativa dentro del root", () => {
  const root = path.resolve("D:/KopiaDesk_Backup");
  const resolved = safePath(root, "Fotos/img.jpg");
  assert.equal(resolved, path.join(root, "Fotos", "img.jpg"));
});

test("safePath permite que la ruta resuelta sea exactamente el root", () => {
  const root = path.resolve("D:/KopiaDesk_Backup");
  assert.equal(safePath(root, "."), path.resolve(root));
});

test("safePath rechaza un path traversal fuera del root", () => {
  const root = path.resolve("D:/KopiaDesk_Backup");
  assert.throws(() => safePath(root, "../../Windows/System32"), /fuera del disco destino/);
});

test("safePath rechaza una carpeta hermana con el mismo prefijo de nombre", () => {
  // D:\Backup2 no debe colarse por empezar igual que D:\Backup (sin separador de por medio)
  const root = path.resolve("D:/Backup");
  assert.throws(() => safePath(root, "../Backup2/evil.txt"), /fuera del disco destino/);
});

test("safePath rechaza rutas con bytes nulos", () => {
  const root = path.resolve("D:/KopiaDesk_Backup");
  assert.throws(() => safePath(root, "archivo\0.txt"), /caracteres nulos/);
});

test("safePath rechaza rutas vacías o no-string", () => {
  const root = path.resolve("D:/KopiaDesk_Backup");
  assert.throws(() => safePath(root, ""));
  assert.throws(() => safePath(root, null));
});

// --- exclusiones -------------------------------------------------------------

test("compileExcludePatterns + isExcluded soportan comodines '*' y '?'", () => {
  const compiled = compileExcludePatterns(["*.tmp", "~$*", "Thumbs.db"]);
  assert.equal(isExcluded("archivo.tmp", compiled), true);
  assert.equal(isExcluded("~$documento.docx", compiled), true);
  assert.equal(isExcluded("Thumbs.db", compiled), true);
  assert.equal(isExcluded("thumbs.db", compiled), true); // case-insensitive
  assert.equal(isExcluded("foto.jpg", compiled), false);
});

test("compileExcludePatterns ignora patrones vacíos o no-string", () => {
  const compiled = compileExcludePatterns(["", "   ", null, undefined, "*.log"]);
  assert.equal(compiled.length, 1);
  assert.equal(isExcluded("error.log", compiled), true);
});

test("DEFAULT_EXCLUDES incluye las exclusiones documentadas en el README", () => {
  for (const pattern of ["Thumbs.db", "desktop.ini", "$RECYCLE.BIN", ".git", "node_modules", "*.tmp"]) {
    assert.ok(DEFAULT_EXCLUDES.includes(pattern), `falta ${pattern}`);
  }
});

// --- scanDirectoryRecursive ---------------------------------------------------

test("scanDirectoryRecursive encuentra archivos anidados y aplica exclusiones", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, "a.txt"), "hola");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "b.txt"), "mundo");
  fs.writeFileSync(path.join(dir, "Thumbs.db"), "ignorar");
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "c.txt"), "ignorar también");

  const compiled = compileExcludePatterns(DEFAULT_EXCLUDES);
  const result = await scanDirectoryRecursive(dir, "", compiled);

  assert.deepEqual(Object.keys(result).sort(), ["a.txt", "sub/b.txt"]);
  assert.equal(result["a.txt"].size, 4);
  assert.equal(result["sub/b.txt"].fullPath, path.join(dir, "sub", "b.txt"));
});

test("scanDirectoryRecursive devuelve mapa vacío para una carpeta vacía", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = await scanDirectoryRecursive(dir, "", []);
  assert.deepEqual(result, {});
});

// --- hashing -------------------------------------------------------------------

test("quickHashFile da el mismo hash para el mismo contenido", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fileA = path.join(dir, "a.txt");
  const fileB = path.join(dir, "b.txt");
  fs.writeFileSync(fileA, "contenido idéntico");
  fs.writeFileSync(fileB, "contenido idéntico");

  const hashA = await quickHashFile(fileA, fs.statSync(fileA).size);
  const hashB = await quickHashFile(fileB, fs.statSync(fileB).size);
  assert.equal(hashA, hashB);
});

test("quickHashFile da distinto hash si el contenido difiere", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fileA = path.join(dir, "a.txt");
  const fileB = path.join(dir, "b.txt");
  fs.writeFileSync(fileA, "contenido uno");
  fs.writeFileSync(fileB, "contenido dos");

  const hashA = await quickHashFile(fileA, fs.statSync(fileA).size);
  const hashB = await quickHashFile(fileB, fs.statSync(fileB).size);
  assert.notEqual(hashA, hashB);
});

test("quickHashFile funciona con archivos más grandes que el bloque de 64 KB", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, "grande.bin");
  const buf = Buffer.alloc(200 * 1024);
  buf.fill(1, 0, 65536); // cabecera
  buf.fill(2, buf.length - 65536); // cola
  fs.writeFileSync(filePath, buf);

  const hash1 = await quickHashFile(filePath, buf.length);

  // Cambiar sólo el medio del archivo no debería afectar el hash rápido,
  // ya que sólo lee cabecera+cola — esto documenta la limitación conocida.
  buf.fill(9, 100000, 100010);
  fs.writeFileSync(filePath, buf);
  const hash2 = await quickHashFile(filePath, buf.length);

  assert.equal(hash1, hash2);
});

test("hashFileAsync calcula un SHA-256 completo y determinista", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, "archivo.txt");
  fs.writeFileSync(filePath, "contenido de prueba");

  const hash = await hashFileAsync(filePath);
  assert.equal(hash, "f3a7a67ab20351ddf47e87ecbf0e5a0868fc0e257d0aea65d018b0405b9a34f3");
});

// --- journal ---------------------------------------------------------------------

test("journal: limpia sólo los archivos que quedaron pendientes al interrumpirse", async (t) => {
  const destRoot = makeTempDir();
  t.after(() => fs.rmSync(destRoot, { recursive: true, force: true }));
  const jDir = path.join(destRoot, "journal");

  const tasks = [
    { relativeDest: "a.txt" },
    { relativeDest: "sub/b.txt" },
    { relativeDest: "c.txt" },
  ];
  const journalPath = startJournal(jDir, tasks);
  assert.ok(journalPath);

  // Simular la interrupción: a.txt y sub/b.txt se copiaron completos (y quedaron
  // registrados como done); c.txt quedó a medias sin registrarse.
  fs.writeFileSync(path.join(destRoot, "a.txt"), "completo");
  fs.mkdirSync(path.join(destRoot, "sub"), { recursive: true });
  fs.writeFileSync(path.join(destRoot, "sub", "b.txt"), "completo");
  fs.writeFileSync(path.join(destRoot, "c.txt"), "parcial");
  appendJournalDone(journalPath, "a.txt");
  appendJournalDone(journalPath, "sub/b.txt");

  const result = checkJournals(jDir, destRoot);
  assert.equal(result.found, 1);
  assert.equal(result.filesCleaned, 1);
  assert.ok(result.lastInterruptedAt);

  assert.ok(fs.existsSync(path.join(destRoot, "a.txt")), "los archivos completos no deben borrarse");
  assert.ok(fs.existsSync(path.join(destRoot, "sub", "b.txt")), "los archivos completos no deben borrarse");
  assert.ok(!fs.existsSync(path.join(destRoot, "c.txt")), "el archivo parcial debe limpiarse");
  assert.equal(fs.readdirSync(jDir).length, 0, "el journal procesado debe eliminarse");
});

test("journal: peekJournals informa lo pendiente sin borrar nada", (t) => {
  const destRoot = makeTempDir();
  t.after(() => fs.rmSync(destRoot, { recursive: true, force: true }));
  const jDir = path.join(destRoot, "journal");

  const journalPath = startJournal(jDir, [
    { relativeDest: "a.txt" },
    { relativeDest: "b.txt" },
  ]);
  fs.writeFileSync(path.join(destRoot, "b.txt"), "parcial");
  appendJournalDone(journalPath, "a.txt");

  const peek = peekJournals(jDir);
  assert.equal(peek.found, 1);
  assert.equal(peek.pendingFiles, 1);
  assert.ok(peek.lastInterruptedAt);

  assert.ok(fs.existsSync(path.join(destRoot, "b.txt")), "peek no debe borrar el archivo parcial");
  assert.ok(fs.existsSync(journalPath), "peek no debe borrar el journal");

  // La limpieza real sigue funcionando después del peek
  const result = checkJournals(jDir, destRoot);
  assert.equal(result.filesCleaned, 1);
  assert.ok(!fs.existsSync(path.join(destRoot, "b.txt")));
});

test("journal: peekJournals sin carpeta de journal no encuentra nada", () => {
  const peek = peekJournals(path.join(os.tmpdir(), "kopia-journal-inexistente"));
  assert.deepEqual(peek, { found: 0, pendingFiles: 0, lastInterruptedAt: null });
});

test("journal: startJournal devuelve null si no hay tareas", () => {
  assert.equal(startJournal(path.join(os.tmpdir(), "no-importa"), []), null);
});

test("journal: checkJournals sin carpeta de journal no encuentra nada", () => {
  const result = checkJournals(path.join(os.tmpdir(), "kopia-journal-inexistente"), os.tmpdir());
  assert.deepEqual(result, { found: 0, filesCleaned: 0, lastInterruptedAt: null });
});

test("journal: finishJournal elimina el archivo al terminar sin errores", (t) => {
  const destRoot = makeTempDir();
  t.after(() => fs.rmSync(destRoot, { recursive: true, force: true }));
  const jDir = path.join(destRoot, "journal");

  const journalPath = startJournal(jDir, [{ relativeDest: "a.txt" }]);
  assert.ok(fs.existsSync(journalPath));
  finishJournal(journalPath);
  assert.ok(!fs.existsSync(journalPath));
});

test("journal: sigue entendiendo el formato .json de versiones anteriores", (t) => {
  const destRoot = makeTempDir();
  t.after(() => fs.rmSync(destRoot, { recursive: true, force: true }));
  const jDir = path.join(destRoot, "journal");
  fs.mkdirSync(jDir, { recursive: true });

  fs.writeFileSync(path.join(destRoot, "viejo.txt"), "parcial");
  const legacy = {
    startedAt: "2026-01-01T00:00:00.000Z",
    entries: [
      { relativeDest: "viejo.txt", status: "pending" },
      { relativeDest: "hecho.txt", status: "done" },
    ],
  };
  fs.writeFileSync(path.join(jDir, "backup_legacy.json"), JSON.stringify(legacy));

  const result = checkJournals(jDir, destRoot);
  assert.equal(result.found, 1);
  assert.equal(result.filesCleaned, 1);
  assert.equal(result.lastInterruptedAt, "2026-01-01T00:00:00.000Z");
  assert.ok(!fs.existsSync(path.join(destRoot, "viejo.txt")));
});

// --- pickConcurrency -----------------------------------------------------------

test("pickConcurrency: HDD con muchos archivos chicos usa 2", () => {
  assert.equal(pickConcurrency({ mediaType: "HDD", busType: "SATA" }, 1024 * 1024), 2);
});

test("pickConcurrency: HDD con archivos grandes usa 1", () => {
  assert.equal(pickConcurrency({ mediaType: "HDD", busType: "SATA" }, 50 * 1024 * 1024), 1);
});

test("pickConcurrency: SSD con archivos chicos usa 8", () => {
  assert.equal(pickConcurrency({ mediaType: "SSD", busType: "SATA" }, 1024), 8);
});

test("pickConcurrency: NVMe por busType cuenta como SSD aunque mediaType sea desconocido", () => {
  assert.equal(pickConcurrency({ mediaType: "Unknown", busType: "NVMe" }, 10 * 1024 * 1024), 4);
});

test("pickConcurrency: disco desconocido usa valores intermedios", () => {
  assert.equal(pickConcurrency({ mediaType: "Unknown", busType: "Unknown" }, 1024), 4);
  assert.equal(pickConcurrency({ mediaType: "Unknown", busType: "Unknown" }, 10 * 1024 * 1024), 2);
});
