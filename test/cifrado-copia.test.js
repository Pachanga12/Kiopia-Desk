"use strict";

// Copia y restauración cifradas en el núcleo (lib/core.js, modo v3).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const core = require("../lib/core.js");
const cifrado = require("../lib/cifrado.js");

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function preparar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kd-cifcopia-"));
  const src = path.join(dir, "origen");
  const dest = path.join(dir, "destino");
  fs.mkdirSync(src);
  fs.mkdirSync(path.join(dest, "KopiaDesk_Backup", "datos"), { recursive: true });
  return { dir, src, dest, mk: crypto.randomBytes(32) };
}

test("copia cifrada y verificada: en el disco no está el contenido; al restaurar vuelve idéntico y con su fecha", async (t) => {
  const { dir, src, dest, mk } = preparar();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origen = path.join(src, "foto.jpg");
  const data = crypto.randomBytes(3 * 1024 * 1024 + 7);
  fs.writeFileSync(origen, data);
  const fecha = new Date("2024-05-06T07:08:09Z");
  fs.utimesSync(origen, fecha, fecha);
  const blob = path.join(dest, "KopiaDesk_Backup", "datos", "ab.kdc");
  const r = await core.encryptFileVerified(mk, origen, blob);
  assert.equal(r.hash, sha(origen));
  assert.equal(fs.statSync(blob).size, data.length + 20 + 32 + (16 - (data.length % 16)));
  assert.ok(!fs.readFileSync(blob).includes(data.subarray(1000, 1064)), "el contenido no aparece en claro");
  assert.equal(fs.existsSync(blob + ".kopia-tmp"), false, "no quedan temporales");
  const restaurado = path.join(dir, "restaurado.jpg");
  await core.restoreEncryptedVerified(mk, blob, restaurado, r.hash, fecha.getTime());
  assert.ok(fs.readFileSync(restaurado).equals(data));
  assert.equal(Math.round(fs.statSync(restaurado).mtimeMs / 1000), Math.round(fecha.getTime() / 1000), "con la fecha original");
});

test("un archivo cifrado alterado o con otro contenido no se restaura (y no deja nada)", async (t) => {
  const { dir, src, dest, mk } = preparar();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(src, "a"), crypto.randomBytes(50000));
  const blob = path.join(dest, "a.kdc");
  const { hash } = await core.encryptFileVerified(mk, path.join(src, "a"), blob);
  await assert.rejects(core.restoreEncryptedVerified(mk, blob, path.join(dir, "r1"), "0".repeat(64)), (e) => e.code === "BACKUP_CORRUPTED");
  const b = fs.readFileSync(blob);
  b[100] ^= 1;
  fs.writeFileSync(blob, b);
  await assert.rejects(core.restoreEncryptedVerified(mk, blob, path.join(dir, "r2"), hash), (e) => e.code === "BACKUP_CORRUPTED");
  assert.equal(fs.existsSync(path.join(dir, "r1")) || fs.existsSync(path.join(dir, "r2")), false);
  assert.equal(fs.existsSync(path.join(dir, "r2.kopia-tmp")), false);
});

test("copyOneTask cifrada: deduplica contenido idéntico con un enlace y el índice apunta al archivo cifrado", async (t) => {
  const { dir, src, dest, mk } = preparar();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = crypto.randomBytes(200000);
  fs.writeFileSync(path.join(src, "a.bin"), data);
  fs.writeFileSync(path.join(src, "copia de a.bin"), data);
  const ctx = { index: new core.ContentIndex(), pendingWrites: new Map(), masterKey: mk, madeDirs: new Set() };
  const rel = (n) => "KopiaDesk_Backup/datos/" + cifrado.opaqueName(mk, "archivo", "origen/" + n);
  const r1 = await core.copyOneTask({ srcPath: path.join(src, "a.bin"), destRoot: dest, relativeDest: rel("a.bin"), dedup: true }, ctx);
  const r2 = await core.copyOneTask({ srcPath: path.join(src, "copia de a.bin"), destRoot: dest, relativeDest: rel("copia de a.bin"), dedup: true }, ctx);
  assert.equal(r1.dedup, false);
  assert.equal(r2.dedup, true, "la segunda se enlaza");
  const b1 = path.join(dest, ...rel("a.bin").split("/"));
  const b2 = path.join(dest, ...rel("copia de a.bin").split("/"));
  assert.equal(fs.statSync(b2).nlink, 2);
  const x = await cifrado.decryptFile(mk, b2, null);
  assert.equal(x.hash, r1.hash);
  assert.ok(ctx.index.get(r1.hash), "el índice guarda el hash del contenido original");
  assert.equal(fs.existsSync(b1), true);
});

test("versión anterior cifrada: se conserva intacta aunque el archivo se sobrescriba", async (t) => {
  const { dir, src, dest, mk } = preparar();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origen = path.join(src, "doc.txt");
  fs.writeFileSync(origen, "versión 1");
  const blob = path.join(dest, "KopiaDesk_Backup", "datos", "doc.kdc");
  const v1 = await core.encryptFileVerified(mk, origen, blob);
  const version = path.join(dest, "KopiaDesk_Backup", ".kopia-data", "versions", "sello", "v.kdc");
  await core.preserveEncryptedVersion(blob, version);
  fs.writeFileSync(origen, "versión 2, más larga");
  await core.encryptFileVerified(mk, origen, blob);
  const r = path.join(dir, "vieja.txt");
  await core.restoreEncryptedVerified(mk, version, r, v1.hash);
  assert.equal(fs.readFileSync(r, "utf8"), "versión 1");
  const r2 = path.join(dir, "nueva.txt");
  await core.restoreEncryptedVerified(mk, blob, r2, null);
  assert.equal(fs.readFileSync(r2, "utf8"), "versión 2, más larga");
});

test("FAT32: el límite de 4 GB cuenta lo que añade el cifrado", async (t) => {
  const { dir, src, dest, mk } = preparar();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(src, "casi.bin"), Buffer.alloc(1000));
  const task = { srcPath: path.join(src, "casi.bin"), destRoot: dest, relativeDest: "KopiaDesk_Backup/datos/x.kdc", dedup: false };
  // Un disco cuyo máximo fuera 1030 bytes: el original (1000) cabría, cifrado (1000 + 68) no.
  await assert.rejects(core.copyOneTask(task, { masterKey: mk, maxFileSize: 1030 }), (e) => e.code === "FILE_TOO_LARGE");
  await core.copyOneTask(task, { masterKey: null, maxFileSize: 1030 });
});

test("repetir el backup de dos archivos ya enlazados no deja temporales (en Linux el rename no hacía nada)", async (t) => {
  const { dir, src, dest, mk } = preparar();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = crypto.randomBytes(5000);
  fs.writeFileSync(path.join(src, "a"), data);
  fs.writeFileSync(path.join(src, "b"), data);
  const index = new core.ContentIndex();
  for (let vuelta = 0; vuelta < 2; vuelta++) {
    const ctx = { index, pendingWrites: new Map(), masterKey: mk, madeDirs: new Set() };
    for (const n of ["a", "b"]) {
      await core.copyOneTask({ srcPath: path.join(src, n), destRoot: dest, relativeDest: "KopiaDesk_Backup/datos/" + n + ".kdc", dedup: true }, ctx);
    }
  }
  const datos = fs.readdirSync(path.join(dest, "KopiaDesk_Backup", "datos"));
  assert.deepEqual(datos.sort(), ["a.kdc", "b.kdc"], "sin .kopia-tmp");
});
