"use strict";

// Cifrado propio (lib/cifrado.js) y su contraparte sin la app
// (lib/Recuperar-KiopiaDesk.ps1): tienen que entenderse byte a byte.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const c = require("../lib/cifrado.js");

const soloWindows = { skip: process.platform !== "win32" && "requiere Windows (PowerShell)" };
const PS = path.join(__dirname, "..", "lib", "Recuperar-KiopiaDesk.ps1");
// Vueltas bajas en los tests de Node (rápidos); la prueba con PowerShell usa las reales.
const RAPIDO = { iterations: 1000 };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kd-cifrado-"));
}

test("la caja se abre con la contraseña y con la clave de recuperación, y no con otra cosa", () => {
  const { vault, masterKey, recoveryKey } = c.createVault("Contraseña Ñandú 2026!", RAPIDO);
  assert.match(recoveryKey, /^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(c.unlockVault(vault, "Contraseña Ñandú 2026!").equals(masterKey));
  assert.ok(c.unlockVault(vault, recoveryKey).equals(masterKey));
  assert.ok(c.unlockVault(vault, recoveryKey.toLowerCase().replace(/-/g, " ")).equals(masterKey), "la clave se acepta sin guiones y en minúsculas");
  assert.equal(c.unlockVault(vault, "contraseña ñandú 2026!"), null);
  assert.equal(c.unlockVault(vault, ""), null);
  const otra = c.createVault("x", RAPIDO).recoveryKey;
  assert.equal(c.unlockVault(vault, otra), null, "la clave de recuperación de otro disco no sirve");
  const json = JSON.stringify(vault);
  assert.ok(!json.includes(masterKey.toString("base64")) && !json.includes(recoveryKey), "la caja no guarda secretos en claro");
});

test("la clave de recuperación se escribe y se lee igual (sin letras que se confundan)", () => {
  for (let i = 0; i < 20; i++) {
    const b = crypto.randomBytes(20);
    const t = c.formatRecoveryKey(b);
    assert.ok(!/[IO01]/.test(t));
    assert.ok(c.parseRecoveryKey(t).equals(b));
  }
  assert.equal(c.parseRecoveryKey("ABCD-EFGH"), null);
  assert.equal(c.parseRecoveryKey("IIII-IIII-IIII-IIII-IIII-IIII-IIII-IIII"), null);
});

test("cambiar la contraseña no cambia la clave maestra ni la clave de recuperación", () => {
  const { vault, masterKey, recoveryKey } = c.createVault("vieja-contraseña", RAPIDO);
  const nueva = c.rewrapWithPassword(vault, masterKey, "nueva-contraseña", RAPIDO);
  assert.ok(c.unlockVault(nueva, "nueva-contraseña").equals(masterKey));
  assert.equal(c.unlockVault(nueva, "vieja-contraseña"), null);
  assert.ok(c.unlockVault(nueva, recoveryKey).equals(masterKey));
});

test("datos pequeños: ida y vuelta, y cualquier cambio se detecta", () => {
  const mk = crypto.randomBytes(32);
  const blob = c.encryptJson(mk, { "Fotos/playa.jpg": { size: 3, hash: "abc" } });
  assert.ok(!blob.toString("latin1").includes("playa"), "el nombre no aparece en claro");
  assert.deepEqual(c.decryptJson(mk, blob), { "Fotos/playa.jpg": { size: 3, hash: "abc" } });
  const alterado = Buffer.from(blob);
  alterado[30] ^= 1;
  assert.throws(() => c.decryptJson(mk, alterado), (e) => e.code === "CRYPTO_TAMPERED");
  assert.throws(() => c.decryptJson(crypto.randomBytes(32), blob), (e) => e.code === "CRYPTO_TAMPERED", "con otra clave no se abre");
  assert.throws(() => c.decryptBuffer(mk, Buffer.from("hola")), (e) => e.code === "CRYPTO_FORMAT");
});

test("archivos grandes: se cifran por bloques, el SHA-256 es el del original y se descifran idénticos", async () => {
  const dir = tmp();
  const mk = crypto.randomBytes(32);
  for (const size of [0, 1, 15, 16, 17, 4 * 1024 * 1024, 9 * 1024 * 1024 + 5]) {
    const src = path.join(dir, `o${size}`);
    const enc = path.join(dir, `e${size}`);
    const dec = path.join(dir, `d${size}`);
    const data = crypto.randomBytes(size);
    fs.writeFileSync(src, data);
    const r1 = await c.encryptFile(mk, src, enc);
    assert.equal(r1.hash, crypto.createHash("sha256").update(data).digest("hex"));
    assert.equal(r1.bytes, size);
    assert.ok(!fs.readFileSync(enc).includes(data.subarray(0, Math.min(64, size))) || size < 16);
    const r2 = await c.decryptFile(mk, enc, dec);
    assert.equal(r2.hash, r1.hash, "tamaño " + size);
    assert.ok(fs.readFileSync(dec).equals(data));
    const r3 = await c.decryptFile(mk, enc, null);
    assert.equal(r3.hash, r1.hash, "sólo verificar");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("un archivo cifrado alterado se rechaza y no deja nada escrito", async () => {
  const dir = tmp();
  const mk = crypto.randomBytes(32);
  fs.writeFileSync(path.join(dir, "o"), crypto.randomBytes(100000));
  await c.encryptFile(mk, path.join(dir, "o"), path.join(dir, "e"));
  const b = fs.readFileSync(path.join(dir, "e"));
  b[50000] ^= 0x10;
  fs.writeFileSync(path.join(dir, "e"), b);
  await assert.rejects(c.decryptFile(mk, path.join(dir, "e"), path.join(dir, "d")), (e) => e.code === "CRYPTO_TAMPERED");
  assert.equal(fs.existsSync(path.join(dir, "d")), false);
  await assert.rejects(c.decryptFile(mk, path.join(dir, "e"), null), (e) => e.code === "CRYPTO_TAMPERED", "también al sólo verificar (una lectura)");
  await c.encryptFile(mk, path.join(dir, "o"), path.join(dir, "o2"));
  await assert.rejects(c.decryptFile(crypto.randomBytes(32), path.join(dir, "o2"), null), (e) => e.code === "CRYPTO_TAMPERED", "con otra clave tampoco");
  await assert.rejects(c.encryptFile(mk, path.join(dir, "o"), path.join(dir, "e")), (e) => e.code === "EEXIST", "nunca se sobrescribe un archivo");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("nombres opacos: siempre iguales para la misma ruta, distintos entre rutas y tipos, sin revelar nada", () => {
  const mk = crypto.randomBytes(32);
  const a = c.opaqueName(mk, "archivo", "Fotos/Vacaciones/playa.jpg");
  assert.equal(a, c.opaqueName(mk, "archivo", "Fotos/Vacaciones/playa.jpg"));
  assert.notEqual(a, c.opaqueName(mk, "archivo", "Fotos/Vacaciones/Playa.jpg"));
  assert.notEqual(a, c.opaqueName(mk, "version", "Fotos/Vacaciones/playa.jpg"));
  assert.notEqual(a, c.opaqueName(crypto.randomBytes(32), "archivo", "Fotos/Vacaciones/playa.jpg"));
  assert.match(a, /^[0-9a-f]{2}\/[0-9a-f]{38}\.kdc$/);
});

test("PowerShell (sin la app) abre la caja y descifra lo que cifró Node, byte a byte", soloWindows, async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const password = "Contraseña Ñandú €9!";
  const { vault, masterKey, recoveryKey } = c.createVault(password); // vueltas reales
  fs.writeFileSync(path.join(dir, "cifrado.json"), JSON.stringify(vault));
  const data = crypto.randomBytes(9 * 1024 * 1024 + 123); // más de dos bloques de 4 MB
  fs.writeFileSync(path.join(dir, "original.bin"), data);
  const { hash } = await c.encryptFile(masterKey, path.join(dir, "original.bin"), path.join(dir, "grande.kdc"));
  fs.writeFileSync(path.join(dir, "manifiesto.kdc"), c.encryptJson(masterKey, { "Fotos/año 2025/niño.jpg": { size: 7 } }));
  const esperado = c.opaqueName(masterKey, "archivo", "Fotos/año 2025/niño.jpg");
  const q = (s) => "'" + s.replace(/'/g, "''") + "'";
  const ruta64 = Buffer.from("Fotos/año 2025/niño.jpg", "utf8").toString("base64");
  const script =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    `. ${q(PS)} -Accion Import; ` +
    `$v = Get-Content -Raw -LiteralPath ${q(path.join(dir, "cifrado.json"))} | ConvertFrom-Json; ` +
    `$pw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(password, "utf8").toString("base64")}')); ` +
    `$mk1 = Unlock-KdVault $v $pw; $mk2 = Unlock-KdVault $v '${recoveryKey}'; $mal = Unlock-KdVault $v 'otra'; ` +
    `$h = Unprotect-KdFile $mk1 ${q(path.join(dir, "grande.kdc"))} ${q(path.join(dir, "descifrado.bin"))}; ` +
    `$j = Unprotect-KdJson $mk2 ${q(path.join(dir, "manifiesto.kdc"))}; ` +
    `[pscustomobject]@{ mk1 = [Convert]::ToBase64String($mk1); mk2 = [Convert]::ToBase64String($mk2); mal = ($null -eq $mal); hash = $h; ` +
    `claves = @($j.PSObject.Properties.Name); nombre = (Get-KdOpaqueName $mk1 'archivo' ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${ruta64}')))) } | ConvertTo-Json -Compress`;
  const out = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf-8" }).trim());
  assert.equal(out.mk1, masterKey.toString("base64"), "con la contraseña (con tildes y €)");
  assert.equal(out.mk2, masterKey.toString("base64"), "con la clave de recuperación");
  assert.equal(out.mal, true, "otra contraseña no abre");
  assert.equal(out.hash, hash);
  assert.ok(fs.readFileSync(path.join(dir, "descifrado.bin")).equals(data), "descifrado idéntico");
  assert.deepEqual(out.claves, ["Fotos/año 2025/niño.jpg"]);
  assert.equal(out.nombre, esperado, "mismo nombre opaco que Node");
});

test("PowerShell rechaza un archivo alterado y no deja nada escrito", soloWindows, async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { vault, masterKey } = c.createVault("x", RAPIDO);
  fs.writeFileSync(path.join(dir, "cifrado.json"), JSON.stringify(vault));
  fs.writeFileSync(path.join(dir, "o"), crypto.randomBytes(50000));
  await c.encryptFile(masterKey, path.join(dir, "o"), path.join(dir, "e.kdc"));
  const b = fs.readFileSync(path.join(dir, "e.kdc"));
  b[1000] ^= 1;
  fs.writeFileSync(path.join(dir, "e.kdc"), b);
  const q = (s) => "'" + s.replace(/'/g, "''") + "'";
  const script = `. ${q(PS)} -Accion Import; $v = Get-Content -Raw -LiteralPath ${q(path.join(dir, "cifrado.json"))} | ConvertFrom-Json; $mk = Unlock-KdVault $v 'x'; try { Unprotect-KdFile $mk ${q(path.join(dir, "e.kdc"))} ${q(path.join(dir, "d"))}; 'ACEPTADO' } catch { 'RECHAZADO' }`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf-8" }).trim();
  assert.equal(out, "RECHAZADO");
  assert.equal(fs.existsSync(path.join(dir, "d")), false);
});
