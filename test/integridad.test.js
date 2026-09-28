"use strict";

// Tests de los arreglos de integridad (problemas conocidos 1-5 del README),
// del informe de escaneo y de la detección de disco/cifrado.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  DEFAULT_EXCLUDES,
  TMP_SUFFIX,
  FAT32_MAX_FILE_SIZE,
  isInside,
  atomicWriteFileSync,
  readJsonWithFallback,
  compileExcludePatterns,
  createScanReport,
  scanDirectoryRecursive,
  hashFileAsync,
  copyFileVerified,
  restoreFileVerified,
  writeVersionAtomic,
  ContentIndex,
  copyOneTask,
  fileSystemInfo,
  parseBitLockerProtection,
  isHomeEdition,
  startJournal,
  peekJournals,
  checkJournals,
} = require("../lib/core.js");
const zlib = require("zlib");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kopia-integridad-test-"));
}

function tempDirs(t, count) {
  const dirs = Array.from({ length: count }, makeTempDir);
  t.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  return dirs;
}

// --- isInside ----------------------------------------------------------------

test("isInside acepta subrutas y la propia carpeta, sin distinguir mayúsculas", () => {
  const root = path.resolve("D:/KopiaDesk_Backup");
  assert.ok(isInside(root, path.join(root, "Fotos", "a.jpg")));
  assert.ok(isInside(root, root));
  assert.ok(isInside(root, root.toUpperCase()));
});

test("isInside rechaza hermanas con el mismo prefijo, traversal y valores inválidos", () => {
  const root = path.resolve("D:/Backup");
  assert.ok(!isInside(root, path.resolve("D:/Backup2/x.txt")));
  assert.ok(!isInside(root, path.join(root, "..", "Windows")));
  assert.ok(!isInside(root, null));
  assert.ok(!isInside(root, "a\0b"));
});

// --- Escrituras atómicas (problema 4) ------------------------------------------

test("atomicWriteFileSync escribe el contenido y no deja temporales", (t) => {
  const [dir] = tempDirs(t, 1);
  const fp = path.join(dir, "sub", "manifest.json");
  atomicWriteFileSync(fp, JSON.stringify({ a: 1 }));
  atomicWriteFileSync(fp, JSON.stringify({ a: 2 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, "utf-8")), { a: 2 });
  assert.ok(!fs.existsSync(fp + TMP_SUFFIX));
});

test("problema 4: readJsonWithFallback usa el .prev.json si el principal está truncado", (t) => {
  const [dir] = tempDirs(t, 1);
  const fp = path.join(dir, "m.json");
  const prev = path.join(dir, "m.prev.json");
  fs.writeFileSync(fp, JSON.stringify({ "a.txt": { size: 3 } }).slice(0, 12)); // corte a mitad
  fs.writeFileSync(prev, JSON.stringify({ "a.txt": { size: 3 } }));
  const result = readJsonWithFallback(fp, prev);
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.data, { "a.txt": { size: 3 } });
  assert.ok(result.error);
});

test("readJsonWithFallback informa 'corrupt' si ninguno se puede leer y 'none' si no existe", (t) => {
  const [dir] = tempDirs(t, 1);
  const fp = path.join(dir, "m.json");
  assert.equal(readJsonWithFallback(fp, null).source, "none");
  fs.writeFileSync(fp, "[1,2]"); // JSON válido pero no es un objeto
  const result = readJsonWithFallback(fp, path.join(dir, "no-existe.json"));
  assert.equal(result.source, "corrupt");
  assert.deepEqual(result.data, {});
});

// --- Copia verificada ------------------------------------------------------------

test("copyFileVerified copia, devuelve el SHA-256, conserva la fecha y no deja temporales", async (t) => {
  const [dir] = tempDirs(t, 1);
  const src = path.join(dir, "src.bin");
  const dest = path.join(dir, "dest.bin");
  fs.writeFileSync(src, crypto.randomBytes(300 * 1024));
  const past = new Date("2020-05-01T10:00:00Z");
  fs.utimesSync(src, past, past);

  const result = await copyFileVerified(src, dest);
  assert.equal(result.hash, await hashFileAsync(src));
  assert.ok(fs.readFileSync(src).equals(fs.readFileSync(dest)));
  assert.equal(Math.round(fs.statSync(dest).mtimeMs / 1000), Math.round(past.getTime() / 1000));
  assert.ok(!fs.existsSync(dest + TMP_SUFFIX));
});

test("copyFileVerified no toca el destino anterior si la copia falla", async (t) => {
  const [dir] = tempDirs(t, 1);
  const dest = path.join(dir, "dest.txt");
  fs.writeFileSync(dest, "versión buena");
  await assert.rejects(copyFileVerified(path.join(dir, "no-existe.txt"), dest));
  assert.equal(fs.readFileSync(dest, "utf-8"), "versión buena");
  assert.ok(!fs.existsSync(dest + TMP_SUFFIX));
});

test("copyFileVerified: un origen de sólo lectura se puede respaldar dos veces", async (t) => {
  const [dir] = tempDirs(t, 1);
  const src = path.join(dir, "solo-lectura.txt");
  const dest = path.join(dir, "dest.txt");
  fs.writeFileSync(src, "v1");
  fs.chmodSync(src, 0o444);
  await copyFileVerified(src, dest);
  fs.chmodSync(src, 0o666);
  fs.writeFileSync(src, "v2 más largo");
  fs.chmodSync(src, 0o444);
  await copyFileVerified(src, dest); // no debe fallar al reemplazar el destino
  fs.chmodSync(src, 0o666);
  assert.equal(fs.readFileSync(dest, "utf-8"), "v2 más largo");
});

// --- Reintentos ante bloqueos pasajeros -------------------------------------------

// Hace fallar las primeras `n` copias con `code` (como un antivirus que tiene el
// archivo abierto) y anota qué había en el destino en cada intento.
function simularBloqueo(t, dest, n, code = "EBUSY") {
  const original = fs.promises.copyFile;
  const intentos = [];
  fs.promises.copyFile = async (s, d) => {
    intentos.push(fs.existsSync(dest) ? fs.readFileSync(dest, "utf-8") : "(NO EXISTE)");
    if (intentos.length <= n) {
      const e = new Error(code + " (simulado)");
      e.code = code;
      throw e;
    }
    return original(s, d);
  };
  t.after(() => (fs.promises.copyFile = original));
  return intentos;
}

test("copyFileVerified reintenta un bloqueo pasajero sin tocar nunca la copia buena del destino", async (t) => {
  const [dir] = tempDirs(t, 1);
  const src = path.join(dir, "correo.pst");
  const dest = path.join(dir, "backup.pst");
  fs.writeFileSync(src, "v2 nueva");
  fs.writeFileSync(dest, "v1 buena");
  const intentos = simularBloqueo(t, dest, 2);
  await copyFileVerified(src, dest, { delayMs: 5 });
  assert.deepEqual(intentos, ["v1 buena", "v1 buena", "v1 buena"], "la copia buena sigue en cada intento");
  assert.equal(fs.readFileSync(dest, "utf-8"), "v2 nueva");
  assert.ok(!fs.existsSync(dest + TMP_SUFFIX));
});

test("copyFileVerified: si el bloqueo no se libera, agota los reintentos y la copia buena sigue intacta", async (t) => {
  const [dir] = tempDirs(t, 1);
  const src = path.join(dir, "correo.pst");
  const dest = path.join(dir, "backup.pst");
  fs.writeFileSync(src, "v2 nueva");
  fs.writeFileSync(dest, "v1 buena");
  const intentos = simularBloqueo(t, dest, 99);
  await assert.rejects(copyFileVerified(src, dest, { retries: 3, delayMs: 5 }), (e) => e.code === "EBUSY");
  assert.equal(intentos.length, 4, "1 intento + 3 reintentos");
  assert.equal(fs.readFileSync(dest, "utf-8"), "v1 buena");
  assert.ok(!fs.existsSync(dest + TMP_SUFFIX));
});

test("copyFileVerified no reintenta errores que no son pasajeros (p. ej. sin permiso)", async (t) => {
  const [dir] = tempDirs(t, 1);
  const src = path.join(dir, "a.txt");
  const dest = path.join(dir, "b.txt");
  fs.writeFileSync(src, "nuevo");
  fs.writeFileSync(dest, "v1 buena");
  const intentos = simularBloqueo(t, dest, 99, "EACCES");
  await assert.rejects(copyFileVerified(src, dest, { delayMs: 5 }), (e) => e.code === "EACCES");
  assert.equal(intentos.length, 1);
  assert.equal(fs.readFileSync(dest, "utf-8"), "v1 buena");
});

test("copyFileVerified supera un bloqueo real de Windows de 300 ms", { skip: process.platform !== "win32" }, async (t) => {
  const [dir] = tempDirs(t, 1);
  const src = path.join(dir, "correo.pst");
  const dest = path.join(dir, "backup.pst");
  fs.writeFileSync(src, "v2 nueva " + "x".repeat(1000));
  fs.writeFileSync(dest, "v1 buena");
  const { spawn } = require("child_process");
  const ps = spawn("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$f = [IO.File]::Open('${src}', 'Open', 'Read', 'None'); 'LOCKED'; Start-Sleep -Milliseconds 300; $f.Close()`,
  ]);
  t.after(() => ps.kill());
  await new Promise((resolve) => ps.stdout.on("data", (d) => String(d).includes("LOCKED") && resolve()));
  // Margen amplio (hasta ~6 s) para que el test no dependa de la velocidad de la
  // máquina: en los runners de GitHub el bloqueo tarda más en liberarse que en
  // un equipo normal. Lo que se prueba es que un bloqueo real se supera
  // reintentando, no el valor por defecto de los reintentos.
  const r = await copyFileVerified(src, dest, { retries: 6, delayMs: 100 });
  assert.equal(fs.readFileSync(dest, "utf-8"), fs.readFileSync(src, "utf-8"));
  assert.equal(r.size, fs.statSync(src).size);
});

// --- writeVersionAtomic (versiones comprimidas) -----------------------------

test("writeVersionAtomic comprime, renombra y no deja temporales", async (t) => {
  const [dir] = tempDirs(t, 1);
  const src = path.join(dir, "a.txt");
  const dest = path.join(dir, "versions", "a.txt.gz");
  fs.writeFileSync(src, "contenido original ".repeat(1000));

  await writeVersionAtomic(src, dest);

  assert.ok(fs.existsSync(dest));
  assert.ok(!fs.existsSync(dest + TMP_SUFFIX));
  assert.equal(zlib.gunzipSync(fs.readFileSync(dest)).toString("utf-8"), "contenido original ".repeat(1000));
});

test("writeVersionAtomic no deja temporales ni destino a medias si el origen no existe", async (t) => {
  const [dir] = tempDirs(t, 1);
  const dest = path.join(dir, "versions", "a.txt.gz");
  await assert.rejects(writeVersionAtomic(path.join(dir, "no-existe.txt"), dest));
  assert.ok(!fs.existsSync(dest));
  assert.ok(!fs.existsSync(dest + TMP_SUFFIX));
});

// Hallazgo de la PoC de resiliencia: backup:copy-versions (main.js) no
// planificaba estas escrituras en el journal, asi que un ".kopia-tmp" huerfano
// de una version interrumpida nunca lo veian journal:peek/journal:check (solo
// miran la carpeta de journal, no .kopia-data/versions). El arreglo hace que
// main.js llame a startJournal/appendJournalDone con la ruta REAL final
// (bajo .kopia-data/versions/<...>.gz), no con la ruta de origen: esto prueba
// que, planificada asi, el temporal huerfano SI se detecta y se limpia solo.
test("hallazgo PoC: una version planificada en el journal con su ruta final limpia su temporal huerfano", (t) => {
  const [destRoot] = tempDirs(t, 1);
  const target = path.join(destRoot, "KopiaDesk_Backup", ".kopia-data", "versions", "Docs", "a.bin.gz");
  const journalRelative = path.relative(destRoot, target);
  const jDir = path.join(destRoot, "KopiaDesk_Backup", ".kopia-data", "journal");

  startJournal(jDir, [{ relativeDest: journalRelative }]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target + TMP_SUFFIX, "version a medias"); // lo que deja un crash real

  const peek = peekJournals(jDir, destRoot);
  assert.equal(peek.pendingFiles, 1);

  const result = checkJournals(jDir, destRoot);
  assert.equal(result.filesCleaned, 1);
  assert.ok(!fs.existsSync(target + TMP_SUFFIX));
});

// --- restoreFileVerified: detectar backups corruptos al restaurar (auditoría) ---
// Hallazgo de la auditoría de restauración: restore:copy-files (main.js) sólo
// verificaba que la copia restaurada coincidiera con el archivo QUE HAY en el
// backup, nunca contra el hash que quedó registrado en el manifiesto cuando
// se respaldó. Si el disco de backup se corrompía después (bit rot), la
// restauración "tenía éxito" en silencio con datos corruptos. Verificado
// también end-to-end en la app real con un USB (byte volteado a mano en el
// archivo ya respaldado, manifiesto con el hash bueno).

test("restoreFileVerified: si el archivo del backup no coincide con el hash del manifiesto, no se entrega en silencio", async (t) => {
  const [dir] = tempDirs(t, 1);
  const backupFile = path.join(dir, "backup", "A.txt");
  const dest = path.join(dir, "restaurado", "A.txt");
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(backupFile, "contenido CORRUPTO (bit rot)");

  const hashOriginalBueno = "hash-que-quedo-en-el-manifiesto-cuando-se-respaldo";
  await assert.rejects(
    restoreFileVerified(backupFile, dest, hashOriginalBueno),
    (err) => err.code === "BACKUP_CORRUPTED" && /no coincide/.test(err.message)
  );
  assert.ok(!fs.existsSync(dest), "no debe quedar un archivo corrupto en el destino de restauración");
});

test("restoreFileVerified: si el hash coincide, restaura normalmente", async (t) => {
  const [dir] = tempDirs(t, 1);
  const backupFile = path.join(dir, "backup", "A.txt");
  const dest = path.join(dir, "restaurado", "A.txt");
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(backupFile, "contenido bueno");
  const goodHash = await hashFileAsync(backupFile);

  const result = await restoreFileVerified(backupFile, dest, goodHash);
  assert.equal(result.hash, goodHash);
  assert.equal(fs.readFileSync(dest, "utf-8"), "contenido bueno");
});

test("restoreFileVerified: sin hash esperado (manifiesto legado), restaura sin comparar", async (t) => {
  const [dir] = tempDirs(t, 1);
  const backupFile = path.join(dir, "backup", "A.txt");
  const dest = path.join(dir, "restaurado", "A.txt");
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(backupFile, "contenido de un manifiesto viejo sin hash");

  const result = await restoreFileVerified(backupFile, dest, undefined);
  assert.equal(fs.readFileSync(dest, "utf-8"), "contenido de un manifiesto viejo sin hash");
  assert.ok(result.hash);
});

// --- Problema 2: sobrescribir un hardlink no altera sus otros enlaces --------------

test("problema 2: sobrescribir un archivo enlazado no cambia el contenido de sus enlaces", async (t) => {
  const [dir] = tempDirs(t, 1);
  const a = path.join(dir, "A.txt");
  const b = path.join(dir, "B.txt");
  fs.writeFileSync(a, "contenido X");
  fs.linkSync(a, b); // B comparte contenido con A (dedup)

  const src = path.join(dir, "nuevo.txt");
  fs.writeFileSync(src, "contenido Y distinto");
  await copyFileVerified(src, b);

  assert.equal(fs.readFileSync(b, "utf-8"), "contenido Y distinto");
  assert.equal(fs.readFileSync(a, "utf-8"), "contenido X", "A no debe cambiar al sobrescribir B");
});

// --- Problema 1: índice de dedup obsoleto -------------------------------------------

test("ContentIndex.record olvida los hashes viejos de una ruta sobrescrita", () => {
  const rel = path.join("KopiaDesk_Backup", "F", "A.txt");
  const index = new ContentIndex({ hashX: rel }); // formato legado: hash -> "ruta"
  assert.equal(index.get("hashX").path, rel);
  index.record("hashY", { path: rel, size: 1 });
  assert.equal(index.get("hashX"), null);
  assert.equal(index.get("hashY").size, 1);
  assert.deepEqual(Object.keys(index.toJSON()), ["hashY"]);
});

test("problema 1: A con X, A cambia a Y, aparece B con X → B termina con X", async (t) => {
  const [destRoot, srcDir] = tempDirs(t, 2);
  const index = new ContentIndex();
  const run = (srcPath, relativeDest) =>
    copyOneTask({ srcPath, destRoot, relativeDest, dedup: true }, { index, pendingWrites: new Map() });

  const srcA = path.join(srcDir, "A.txt");
  fs.writeFileSync(srcA, "contenido X");
  await run(srcA, "KopiaDesk_Backup/F/A.txt");

  fs.writeFileSync(srcA, "contenido Y"); // mismo tamaño, otro contenido
  await run(srcA, "KopiaDesk_Backup/F/A.txt");

  const srcB = path.join(srcDir, "B.txt");
  fs.writeFileSync(srcB, "contenido X");
  await run(srcB, "KopiaDesk_Backup/F/B.txt");

  assert.equal(fs.readFileSync(path.join(destRoot, "KopiaDesk_Backup/F/B.txt"), "utf-8"), "contenido X");
  assert.equal(fs.readFileSync(path.join(destRoot, "KopiaDesk_Backup/F/A.txt"), "utf-8"), "contenido Y");
});

test("problema 1: un índice legado que apunta a contenido cambiado no se usa para enlazar", async (t) => {
  const [destRoot, srcDir] = tempDirs(t, 2);
  // Índice escrito por la versión anterior: X -> A, pero A ya contiene Y.
  const relA = path.join("KopiaDesk_Backup", "F", "A.txt");
  fs.mkdirSync(path.join(destRoot, "KopiaDesk_Backup", "F"), { recursive: true });
  fs.writeFileSync(path.join(destRoot, relA), "contenido Y");
  const srcB = path.join(srcDir, "B.txt");
  fs.writeFileSync(srcB, "contenido X");
  const hashX = await hashFileAsync(srcB);
  const index = new ContentIndex({ [hashX]: relA });

  const result = await copyOneTask(
    { srcPath: srcB, destRoot, relativeDest: "KopiaDesk_Backup/F/B.txt", dedup: true },
    { index, pendingWrites: new Map() }
  );
  assert.equal(result.dedup, false, "no debe enlazar a un archivo con otro contenido");
  assert.equal(fs.readFileSync(path.join(destRoot, "KopiaDesk_Backup/F/B.txt"), "utf-8"), "contenido X");
  assert.equal(index.get(hashX).path, path.join("KopiaDesk_Backup", "F", "B.txt"));
});

test("dedup: dos archivos iguales en el mismo lote se guardan una sola vez (hardlink)", async (t) => {
  const [destRoot, srcDir] = tempDirs(t, 2);
  const index = new ContentIndex();
  const pendingWrites = new Map();
  const names = ["uno.txt", "dos.txt"];
  for (const name of names) fs.writeFileSync(path.join(srcDir, name), "igual");
  const results = await Promise.all(
    names.map((name) =>
      copyOneTask(
        { srcPath: path.join(srcDir, name), destRoot, relativeDest: "KopiaDesk_Backup/F/" + name, dedup: true },
        { index, pendingWrites }
      )
    )
  );
  assert.equal(results.filter((r) => r.dedup).length, 1);
  assert.equal(fs.statSync(path.join(destRoot, "KopiaDesk_Backup/F/uno.txt")).nlink, 2);
});

test("copyOneTask sin dedup igual mantiene el índice al día", async (t) => {
  const [destRoot, srcDir] = tempDirs(t, 2);
  const rel = path.join("KopiaDesk_Backup", "F", "A.txt");
  const index = new ContentIndex({ hashViejo: rel });
  const src = path.join(srcDir, "A.txt");
  fs.writeFileSync(src, "nuevo");
  const result = await copyOneTask({ srcPath: src, destRoot, relativeDest: rel }, { index });
  assert.equal(index.get("hashViejo"), null);
  assert.equal(index.get(result.hash).path, rel);
});

test("copyOneTask rechaza archivos más grandes que el límite del sistema de archivos", async (t) => {
  const [destRoot] = tempDirs(t, 1);
  const src = path.join(destRoot, "grande.bin");
  fs.writeFileSync(src, "0123456789");
  await assert.rejects(
    copyOneTask({ srcPath: src, destRoot, relativeDest: "KopiaDesk_Backup/g.bin" }, { maxFileSize: 5 }),
    (err) => err.code === "FILE_TOO_LARGE"
  );
  assert.ok(!fs.existsSync(path.join(destRoot, "KopiaDesk_Backup", "g.bin")));
});

// --- Hallazgo PoC: content-index.json sólo se guardaba al final del lote -------
// backup:copy-files (main.js) guarda el índice de contenido con
// atomicWriteFileSync + JSON.stringify (igual que acá abajo, sólo que ahí
// tiene nombres propios: loadContentIndex/saveContentIndex). Antes del
// arreglo sólo se llamaba una vez, al final de TODO el lote: un crash a mitad
// dejaba el índice en disco sin ninguna actualización del lote, aunque los
// archivos ya copiados y journalados quedaran completos. El arreglo lo guarda
// también cada N archivos. Esto reproduce ese patrón (guardar cada N) y
// confirma que acota la ventana de perdida en vez de perderla toda.

function saveIndex(fp, index) {
  atomicWriteFileSync(fp, JSON.stringify(index));
}
function loadIndex(fp) {
  return new ContentIndex(readJsonWithFallback(fp, null).data);
}

test("guardar el indice cada N archivos (no sólo al final) acota, en vez de perder todo, lo que un crash puede costar en dedup", async (t) => {
  const [destRoot, srcDir] = tempDirs(t, 2);
  const indexPath = path.join(destRoot, "content-index.json");
  const N = 2; // INDEX_SAVE_INTERVAL en esta prueba

  const index = new ContentIndex();
  const pendingWrites = new Map();
  let copied = 0;
  for (const name of ["A.bin", "B.bin", "C.bin"]) {
    const src = path.join(srcDir, name);
    fs.writeFileSync(src, "contenido de " + name);
    await copyOneTask({ srcPath: src, destRoot, relativeDest: "KopiaDesk_Backup/Docs/" + name, dedup: true }, { index, pendingWrites });
    copied++;
    if (copied % N === 0) saveIndex(indexPath, index); // el guardado periodico del arreglo
  }
  // "Crash" antes del guardado final: C.bin nunca llega a persistirse en el
  // indice de disco, pero A.bin y B.bin si (se guardaron en el intermedio).

  const reloaded = loadIndex(indexPath);
  const hashA = [...index.byHash.entries()].find(([, v]) => v.path.endsWith("A.bin"))[0];
  const hashC = [...index.byHash.entries()].find(([, v]) => v.path.endsWith("C.bin"))[0];

  assert.ok(reloaded.get(hashA), "A.bin (guardado en el intermedio) debe seguir en el indice recargado");
  assert.equal(reloaded.get(hashC), null, "C.bin (posterior al ultimo guardado) se pierde del indice, como se espera");

  // Y lo mas importante: los 3 archivos siguen completos en el disco pase lo
  // que pase con el indice — perder una entrada del indice nunca pierde datos.
  for (const name of ["A.bin", "B.bin", "C.bin"]) {
    assert.ok(fs.existsSync(path.join(destRoot, "KopiaDesk_Backup/Docs/" + name)));
  }
});

// --- Informe de escaneo ---------------------------------------------------------

test("scanDirectoryRecursive informa excluidos y enlaces (junctions) sin seguirlos", async (t) => {
  const [dir, outside] = tempDirs(t, 2);
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  fs.writeFileSync(path.join(dir, "b.tmp"), "b");
  fs.writeFileSync(path.join(outside, "fuera.txt"), "x");
  fs.symlinkSync(outside, path.join(dir, "enlace"), "junction");

  const report = createScanReport();
  const files = await scanDirectoryRecursive(dir, "", compileExcludePatterns(DEFAULT_EXCLUDES), report);
  assert.deepEqual(Object.keys(files), ["a.txt"]);
  assert.equal(report.excluded, 1);
  assert.deepEqual(report.skipped, [{ path: "enlace", reason: "enlace" }]);
});

// --- Sistema de archivos y BitLocker ---------------------------------------------

test("fileSystemInfo: FAT32 limita a 4 GB y no tiene hardlinks; NTFS sin límite", () => {
  assert.equal(fileSystemInfo("FAT32").maxFileSize, FAT32_MAX_FILE_SIZE);
  assert.equal(fileSystemInfo("FAT32").supportsHardlinks, false);
  assert.equal(fileSystemInfo("exFAT").maxFileSize, null);
  assert.equal(fileSystemInfo("exFAT").journaled, false);
  assert.equal(fileSystemInfo("NTFS").supportsHardlinks, true);
  assert.equal(fileSystemInfo("NTFS").maxFileSize, null);
});

test("parseBitLockerProtection traduce los valores de la propiedad de shell", () => {
  assert.equal(parseBitLockerProtection(1), "on");
  assert.equal(parseBitLockerProtection(2), "off");
  assert.equal(parseBitLockerProtection("3"), "encrypting");
  assert.equal(parseBitLockerProtection(6), "locked");
  assert.equal(parseBitLockerProtection(null), "unknown");
  assert.equal(parseBitLockerProtection(99), "unknown");
});

test("isHomeEdition reconoce las variantes de Windows Home", () => {
  assert.ok(isHomeEdition("Core"));
  assert.ok(isHomeEdition("CoreSingleLanguage"));
  assert.ok(!isHomeEdition("Professional"));
  assert.ok(!isHomeEdition(null));
});
