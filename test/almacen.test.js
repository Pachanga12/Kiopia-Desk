"use strict";

// Disco de backup cifrado (lib/almacen.js): la caja de claves, los nombres
// opacos y los metadatos cifrados, y un backup completo de punta a punta con
// las mismas piezas que usa main.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const core = require("../lib/core.js");
const almacen = require("../lib/almacen.js");

const RAPIDO = { iterations: 1000 };
const SCRIPT = path.join(__dirname, "..", "lib", "Recuperar-KiopiaDesk.ps1");

function disco(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kd-almacen-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dest = path.join(dir, "USB");
  fs.mkdirSync(dest);
  return { dir, dest };
}

function todosLosArchivos(root) {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...todosLosArchivos(p));
    else out.push(p);
  }
  return out;
}

test("activar el cifrado: crea la caja (y su copia), el script y el LEEME, y se abre con contraseña o clave", (t) => {
  const { dest } = disco(t);
  assert.equal(almacen.isEncrypted(dest), false);
  const { masterKey, recoveryKey } = almacen.enableEncryption(dest, "Contraseña 2026", { ...RAPIDO, scriptSource: SCRIPT });
  assert.equal(almacen.isEncrypted(dest), true);
  const root = path.join(dest, "KiopiaDesk_Backup");
  assert.ok(fs.existsSync(path.join(root, ".kiopia-data", "cifrado.json")));
  assert.ok(fs.existsSync(path.join(root, ".kiopia-data", "cifrado.copia.json")));
  assert.ok(fs.readFileSync(path.join(root, "Recuperar-KiopiaDesk.ps1")).equals(fs.readFileSync(SCRIPT)));
  assert.match(fs.readFileSync(path.join(root, "LEEME-CIFRADO.txt"), "utf8"), /Recuperar-KiopiaDesk\.ps1/);
  assert.ok(almacen.unlock(dest, "Contraseña 2026").equals(masterKey));
  assert.ok(almacen.unlock(dest, recoveryKey).equals(masterKey));
  assert.equal(almacen.unlock(dest, "otra"), null);
  assert.equal(almacen.unlock(dest, ""), null);
  assert.throws(() => almacen.enableEncryption(dest, "x", RAPIDO), (e) => e.code === "CRYPTO_ALREADY");
});

test("si cifrado.json se daña o se borra, se abre con la copia", (t) => {
  const { dest } = disco(t);
  const { masterKey } = almacen.enableEncryption(dest, "clave-larga", RAPIDO);
  const vault = path.join(dest, "KiopiaDesk_Backup", ".kiopia-data", "cifrado.json");
  fs.writeFileSync(vault, "{roto");
  assert.ok(almacen.unlock(dest, "clave-larga").equals(masterKey));
  fs.unlinkSync(vault);
  assert.equal(almacen.isEncrypted(dest), true, "sigue contando como cifrado");
  assert.ok(almacen.unlock(dest, "clave-larga").equals(masterKey));
});

test("cambiar la contraseña: la nueva abre, la vieja no, la clave de recuperación sigue sirviendo", (t) => {
  const { dest } = disco(t);
  const { masterKey, recoveryKey } = almacen.enableEncryption(dest, "vieja-clave", RAPIDO);
  almacen.changePassword(dest, masterKey, "nueva-clave", RAPIDO);
  assert.ok(almacen.unlock(dest, "nueva-clave").equals(masterKey));
  assert.equal(almacen.unlock(dest, "vieja-clave"), null);
  assert.ok(almacen.unlock(dest, recoveryKey).equals(masterKey));
});

test("no se activa en un disco con un backup sin cifrar (no se mezclan)", (t) => {
  const { dest } = disco(t);
  fs.mkdirSync(path.join(dest, "KiopiaDesk_Backup", "Fotos"), { recursive: true });
  assert.equal(almacen.hasPlainBackup(dest), true);
  assert.throws(() => almacen.enableEncryption(dest, "x", RAPIDO), (e) => e.code === "CRYPTO_PLAIN_BACKUP");
  const otro = disco(t).dest;
  fs.mkdirSync(path.join(otro, "KiopiaDesk_Backup", ".kiopia-data", "manifests"), { recursive: true });
  fs.writeFileSync(path.join(otro, "KiopiaDesk_Backup", ".kiopia-data", "manifests", "Fotos.json"), "{}");
  assert.equal(almacen.hasPlainBackup(otro), true);
  assert.equal(almacen.hasPlainBackup(disco(t).dest), false, "un disco vacío no tiene backup");
});

test("rutas: lo que pide la interfaz se traduce a un nombre opaco dentro de datos\\, y nunca a los metadatos", () => {
  const mk = crypto.randomBytes(32);
  const a = almacen.dataRelative(mk, "KiopiaDesk_Backup/Fotos/2025/playa.jpg");
  assert.equal(a.logical, "Fotos/2025/playa.jpg");
  assert.match(a.relative, /^KiopiaDesk_Backup\/datos\/[0-9a-f]{2}\/[0-9a-f]{38}\.kdc$/);
  assert.equal(almacen.dataRelative(mk, "KiopiaDesk_Backup\\Fotos\\2025\\playa.jpg").relative, a.relative, "da igual la barra");
  assert.equal(
    path.relative("X:\\", almacen.dataPath("X:\\", mk, "Fotos", "2025/playa.jpg")).split(path.sep).join("/"),
    a.relative,
    "la restauración encuentra el mismo archivo"
  );
  assert.throws(() => almacen.dataRelative(mk, "KiopiaDesk_Backup/.kiopia-data/x"));
  assert.match(almacen.dataRelative(mk, "KiopiaDesk_Backup/datos/x").relative, /^KiopiaDesk_Backup\/datos\/[0-9a-f]{2}\//, "una carpeta llamada «datos» también se respalda");
  assert.throws(() => almacen.dataRelative(mk, "Otra/x"));
  const v = almacen.versionRelative(mk, "KiopiaDesk_Backup/.kiopia-data/versions/2026-01-02T03-04-05-006Z/Fotos/a.jpg");
  assert.equal(v.stamp, "2026-01-02T03-04-05-006Z");
  assert.equal(v.logical, "Fotos/a.jpg");
  assert.match(v.relative, /^KiopiaDesk_Backup\/\.kiopia-data\/versions\/2026-01-02T03-04-05-006Z\/[0-9a-f]{2}\/[0-9a-f]{38}\.kdc$/);
  assert.throws(() => almacen.versionRelative(mk, "KiopiaDesk_Backup/.kiopia-data/versions/../../x/a"));
});

test("manifiestos cifrados: ida y vuelta, lista de carpetas, y el .prev rescata uno dañado", (t) => {
  const { dest } = disco(t);
  const { masterKey: mk } = almacen.enableEncryption(dest, "x", RAPIDO);
  assert.deepEqual(almacen.listSources(dest, mk), []);
  assert.deepEqual(almacen.loadManifest(dest, mk, "Fotos").source, "none");
  almacen.saveManifest(dest, mk, "Fotos", { "a.jpg": { size: 1, hash: "h1" } });
  almacen.saveManifest(dest, mk, "Fotos", { "a.jpg": { size: 1, hash: "h1" }, "b.jpg": { size: 2, hash: "h2" } });
  almacen.saveManifest(dest, mk, "Documentos: año/2025", { "c.txt": { size: 3, hash: "h3" } });
  assert.deepEqual(Object.keys(almacen.loadManifest(dest, mk, "Fotos").manifest), ["a.jpg", "b.jpg"]);
  assert.deepEqual(almacen.listSources(dest, mk), ["Documentos: año/2025", "Fotos"], "con su nombre real");
  const fp = almacen.manifestPath(dest, mk, "Fotos");
  fs.writeFileSync(fp, Buffer.from("KDC1" + "x".repeat(80)));
  const r = almacen.loadManifest(dest, mk, "Fotos");
  assert.equal(r.source, "fallback");
  assert.deepEqual(Object.keys(r.manifest), ["a.jpg"], "la versión anterior");
  assert.deepEqual(almacen.listSources(dest, crypto.randomBytes(32)), [], "con otra clave no se lee nada");
});

test("informes cifrados: el resumen del último backup los lee con la clave", (t) => {
  const { dest } = disco(t);
  const { masterKey: mk } = almacen.enableEncryption(dest, "x", RAPIDO);
  almacen.saveLog(dest, mk, { run: "r1", source: "Fotos", date: "2026-03-01T10:00:00.000Z", copied: 3, failed: [] });
  almacen.saveLog(dest, mk, { run: "r1", source: "Documentos", date: "2026-03-01T10:05:00.000Z", copied: 2, failed: ["x"] });
  const s = core.summarizeLastBackup(almacen.logsDir(dest), almacen.logReader(mk));
  assert.equal(s.copied, 5);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.sources.sort(), ["Documentos", "Fotos"]);
  assert.equal(core.summarizeLastBackup(almacen.logsDir(dest)), null, "sin la clave no se entiende");
});

test("backup cifrado de punta a punta: nada legible en el disco, versiones y restauración completas", async (t) => {
  const { dir, dest } = disco(t);
  const { masterKey: mk } = almacen.enableEncryption(dest, "x", { ...RAPIDO, scriptSource: SCRIPT });
  const src = path.join(dir, "Mis Fotos Secretas");
  fs.mkdirSync(path.join(src, "Viaje a Cartagena"), { recursive: true });
  const archivos = {
    "Viaje a Cartagena/playa atardecer.jpg": crypto.randomBytes(300000),
    "Viaje a Cartagena/copia de playa.jpg": null, // igual que la anterior: se deduplica
    "notas privadas.txt": Buffer.from("PALABRA-SECRETA-EN-CLARO ".repeat(100)),
  };
  archivos["Viaje a Cartagena/copia de playa.jpg"] = archivos["Viaje a Cartagena/playa atardecer.jpg"];
  for (const [rel, data] of Object.entries(archivos)) fs.writeFileSync(path.join(src, ...rel.split("/")), data);

  // Lo mismo que hace backup:copy-files en main.js.
  const ctx = { index: new core.ContentIndex(almacen.loadIndexData(dest, mk)), pendingWrites: new Map(), madeDirs: new Set(), masterKey: mk };
  const manifest = {};
  async function respaldar() {
    for (const rel of Object.keys(archivos)) {
      const { relative } = almacen.dataRelative(mk, "KiopiaDesk_Backup/Mis Fotos Secretas/" + rel);
      const r = await core.copyOneTask({ srcPath: path.join(src, ...rel.split("/")), destRoot: dest, relativeDest: relative, dedup: true }, ctx);
      const st = fs.statSync(path.join(src, ...rel.split("/")));
      manifest[rel] = { path: rel, size: st.size, lastModified: st.mtimeMs, hash: r.hash };
    }
    almacen.saveIndexData(dest, mk, ctx.index);
    almacen.saveManifest(dest, mk, "Mis Fotos Secretas", manifest);
  }
  await respaldar();
  almacen.saveSources(dest, mk, { "Mis Fotos Secretas": src });
  almacen.saveLog(dest, mk, { source: "Mis Fotos Secretas", date: new Date().toISOString(), copied: 3 });

  // Cambia un archivo: se guarda la versión anterior (como backup:copy-versions) y se vuelve a copiar.
  const antes = manifest["notas privadas.txt"].hash;
  const logicalRel = "KiopiaDesk_Backup/Mis Fotos Secretas/notas privadas.txt";
  const v = almacen.versionRelative(mk, "KiopiaDesk_Backup/.kiopia-data/versions/2026-05-05T00-00-00-000Z/Mis Fotos Secretas/notas privadas.txt");
  await core.preserveEncryptedVersion(path.join(dest, ...almacen.dataRelative(mk, logicalRel).relative.split("/")), path.join(dest, ...v.relative.split("/")));
  almacen.recordVersions(dest, mk, v.stamp, [v]);
  fs.writeFileSync(path.join(src, "notas privadas.txt"), "texto nuevo");
  archivos["notas privadas.txt"] = Buffer.from("texto nuevo");
  await respaldar();

  // En el disco no aparece ningún nombre de archivo o carpeta, ni contenido en claro.
  const enDisco = todosLosArchivos(path.join(dest, "KiopiaDesk_Backup"));
  const permitidos = new Set(["Recuperar-KiopiaDesk.ps1", "Abrir-KiopiaDesk.cmd", "LEEME-CIFRADO.txt", "cifrado.json", "cifrado.copia.json", "fuentes.kdc", "indice.kdc"]);
  for (const p of enDisco) {
    const rel = path.relative(dest, p);
    for (const palabra of ["Fotos", "Secretas", "Cartagena", "playa", "notas", "privadas"]) {
      assert.ok(!rel.includes(palabra), "nombre en claro en el disco: " + rel);
    }
    const base = path.basename(p);
    if (permitidos.has(base)) continue;
    assert.match(base, /^([0-9a-f]{38,40}(\.prev)?\.kdc|[0-9a-f]{8}_[\dTZ-]+\.kdc)$/, "nombre opaco: " + rel);
    const contenido = fs.readFileSync(p).toString("latin1");
    for (const palabra of ["PALABRA-SECRETA", "Cartagena", "playa", "Secretas"]) {
      assert.ok(!contenido.includes(palabra), "contenido en claro en " + rel);
    }
  }
  const datos = enDisco.filter((p) => p.includes(path.sep + "datos" + path.sep));
  assert.equal(datos.length, 3);
  const [a, b] = ["Viaje a Cartagena/playa atardecer.jpg", "Viaje a Cartagena/copia de playa.jpg"].map((r) => almacen.dataPath(dest, mk, "Mis Fotos Secretas", r));
  assert.equal(fs.statSync(a).nlink, 2, "la copia idéntica es un enlace (deduplicada)");
  assert.notEqual(a, b);

  // Restaurar todo desde el manifiesto (como restore:full-list + restore:copy-files).
  assert.deepEqual(almacen.listSources(dest, mk), ["Mis Fotos Secretas"]);
  const destino = path.join(dir, "restaurado");
  const { manifest: m } = almacen.loadManifest(dest, mk, "Mis Fotos Secretas");
  for (const [rel, info] of Object.entries(m)) {
    const out = path.join(destino, ...rel.split("/"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await core.restoreEncryptedVerified(mk, almacen.dataPath(dest, mk, "Mis Fotos Secretas", rel), out, info.hash, info.lastModified);
    assert.ok(fs.readFileSync(out).equals(archivos[rel]), rel);
    assert.equal(Math.round(fs.statSync(out).mtimeMs / 1000), Math.round(info.lastModified / 1000), "con su fecha: " + rel);
  }

  // La versión anterior sigue ahí y el índice de versiones dice qué era.
  const idx = require("../lib/cifrado.js").decryptJson(mk, fs.readFileSync(path.join(dest, "KiopiaDesk_Backup", ".kiopia-data", "versions", v.stamp, "indice.kdc")));
  assert.deepEqual(Object.values(idx), ["Mis Fotos Secretas/notas privadas.txt"]);
  const vieja = path.join(dir, "vieja.txt");
  await core.restoreEncryptedVerified(mk, path.join(dest, ...v.relative.split("/")), vieja, antes);
  assert.match(fs.readFileSync(vieja, "utf8"), /^PALABRA-SECRETA/);
  assert.deepEqual(almacen.loadSources(dest, mk).data, { "Mis Fotos Secretas": src });
});

test("Abrir-KiopiaDesk.cmd y el script quedan de solo lectura y vuelven solos si se borran", (t) => {
  const { dest } = disco(t);
  almacen.enableEncryption(dest, "x", { ...RAPIDO, scriptSource: SCRIPT });
  const root = path.join(dest, "KiopiaDesk_Backup");
  const cmd = path.join(root, "Abrir-KiopiaDesk.cmd");
  assert.equal(fs.statSync(cmd).mode & 0o200, 0, "solo lectura");
  assert.equal(fs.statSync(path.join(root, "Recuperar-KiopiaDesk.ps1")).mode & 0o200, 0);
  assert.equal(almacen.writeRecoveryTools(dest, SCRIPT), 0, "si están bien no se reescribe nada");
  fs.chmodSync(cmd, 0o666);
  fs.unlinkSync(cmd);
  assert.equal(almacen.writeRecoveryTools(dest, SCRIPT), 1, "sólo se repone el que falta");
  assert.match(fs.readFileSync(cmd, "utf8"), /Recuperar-KiopiaDesk\.ps1/);
  assert.equal(fs.statSync(cmd).mode & 0o200, 0);
  // Uno viejo o cambiado se reemplaza aunque sea de solo lectura.
  fs.chmodSync(cmd, 0o666);
  fs.writeFileSync(cmd, "@echo viejo");
  fs.chmodSync(cmd, 0o444);
  assert.equal(almacen.writeRecoveryTools(dest, SCRIPT), 1);
  assert.doesNotMatch(fs.readFileSync(cmd, "utf8"), /viejo/);
});

test("Kiopia Desk portable: se copia de solo lectura, no se repite si está al día y se actualiza si cambia", async (t) => {
  const { dir, dest } = disco(t);
  const src = path.join(dir, "KiopiaDesk-Portable.exe");
  fs.writeFileSync(src, crypto.randomBytes(300000));
  const target = path.join(dest, "KiopiaDesk_Backup", almacen.PORTABLE_NAME);
  assert.deepEqual(await almacen.ensurePortableApp(dest, null), { copied: false, reason: "no-disponible" });
  assert.equal((await almacen.ensurePortableApp(dest, src)).copied, true);
  assert.ok(fs.readFileSync(target).equals(fs.readFileSync(src)));
  assert.equal(fs.statSync(target).mode & 0o200, 0, "solo lectura");
  assert.equal((await almacen.ensurePortableApp(dest, src)).reason, "al-dia");
  fs.writeFileSync(src, crypto.randomBytes(310000));
  assert.equal((await almacen.ensurePortableApp(dest, src)).copied, true, "versión nueva");
  assert.ok(fs.readFileSync(target).equals(fs.readFileSync(src)));
  assert.equal((await almacen.ensurePortableApp(dest, target)).reason, "es-esta", "la app corre desde el propio disco");
  assert.equal(fs.readdirSync(path.join(dest, "KiopiaDesk_Backup")).some((n) => n.endsWith(".kiopia-tmp")), false);
  assert.equal(almacen.hasPlainBackup(dest), false, "la portable sola no cuenta como backup");
});
