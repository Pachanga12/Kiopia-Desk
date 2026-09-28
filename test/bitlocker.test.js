"use strict";

// Tests del lanzamiento del ayudante de BitLocker (lo que no requiere
// administrador): validación de argumentos, entrecomillado y lectura de
// resultados. El ayudante en sí se probó contra un disco virtual.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  bitlockerHelperPath,
  buildHelperLaunchScript,
  parseHelperLaunchOutput,
  readHelperStatus,
  isProcessAlive,
} = require("../lib/core.js");

test("isProcessAlive: el propio proceso vive, un PID inexistente no, un PID inválido es desconocido", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2 ** 30), false);
  assert.equal(isProcessAlive(undefined), null);
});

const base = {
  action: "Encrypt",
  letter: "e",
  statusFile: "C:\\Users\\Ana\\AppData\\Roaming\\kopia-desk\\bitlocker\\E-Encrypt.json",
  scriptPath: "C:\\Program Files\\Kopia Desk\\resources\\app.asar.unpacked\\lib\\bitlocker-helper.ps1",
  volumeId: "\\\\?\\Volume{12345678-9abc-def0-1234-56789abcdef0}\\",
};

test("buildHelperLaunchScript exige una identidad de volumen válida y la pasa al ayudante", () => {
  assert.ok(buildHelperLaunchScript(base).includes("'-VolumeId', '\\\\?\\Volume{12345678-9abc-def0-1234-56789abcdef0}\\'"));
  assert.throws(() => buildHelperLaunchScript({ ...base, volumeId: undefined }), /volumen/);
  assert.throws(() => buildHelperLaunchScript({ ...base, volumeId: "E:\\" }), /volumen/);
  assert.throws(
    () => buildHelperLaunchScript({ ...base, volumeId: "\\\\?\\Volume{12345678-9abc-def0-1234-56789abcdef0}\\' -Drive 'C" }),
    /volumen/
  );
});

test("bitlockerHelperPath usa app.asar.unpacked dentro del instalador", () => {
  const p = bitlockerHelperPath("C:\\Program Files\\Kopia Desk\\resources\\app.asar\\lib");
  // path.join pone el separador del sistema: se compara igual en Windows y en Linux (CI).
  assert.equal(p, path.join("C:\\Program Files\\Kopia Desk\\resources\\app.asar.unpacked\\lib", "bitlocker-helper.ps1"));
  assert.equal(bitlockerHelperPath("C:\\dev\\kopia\\lib"), path.join("C:\\dev\\kopia\\lib", "bitlocker-helper.ps1"));
});

test("buildHelperLaunchScript eleva con RunAs, entrecomilla rutas y normaliza la letra", () => {
  const script = buildHelperLaunchScript({ ...base, fullDisk: true });
  assert.match(script, /-Verb RunAs/);
  assert.ok(script.includes(`'"${base.scriptPath}"'`), "la ruta con espacios va entre comillas dobles");
  assert.ok(script.includes("'-Drive', 'E'"));
  assert.ok(script.includes("'-FullDisk'"));
});

test("buildHelperLaunchScript no pasa -FullDisk al bloquear", () => {
  assert.ok(!buildHelperLaunchScript({ ...base, action: "Lock", fullDisk: true }).includes("FullDisk"));
});

test("buildHelperLaunchScript escapa comillas simples de PowerShell (p. ej. usuario O'Brien)", () => {
  const script = buildHelperLaunchScript({ ...base, statusFile: "C:\\Users\\O'Brien\\s.json" });
  assert.ok(script.includes("O''Brien"));
  assert.ok(!/O'Brien/.test(script.replace(/O''Brien/g, "")));
});

test("buildHelperLaunchScript rechaza acciones, letras y rutas inválidas", () => {
  assert.throws(() => buildHelperLaunchScript({ ...base, action: "Decrypt" }), /Acción/);
  assert.throws(() => buildHelperLaunchScript({ ...base, letter: "E; calc" }), /Letra/);
  assert.throws(() => buildHelperLaunchScript({ ...base, letter: "EF" }), /Letra/);
  assert.throws(() => buildHelperLaunchScript({ ...base, statusFile: 'C:\\x" -Action Lock "' }), /Ruta/);
  assert.throws(() => buildHelperLaunchScript({ ...base, scriptPath: "" }), /Ruta/);
});

test("parseHelperLaunchOutput distingue éxito, UAC rechazado y otros errores", () => {
  assert.deepEqual(parseHelperLaunchOutput("KD-OK:4242\r\n"), { started: true, pid: 4242 });
  assert.deepEqual(parseHelperLaunchOutput("KD-OK"), { started: true });
  assert.equal(parseHelperLaunchOutput("KD-ERR:1223:La operación fue cancelada por el usuario.").code, "uac-cancelled");
  const other = parseHelperLaunchOutput("KD-ERR:2:No se encuentra el archivo.");
  assert.equal(other.code, "launch-failed");
  assert.match(other.error, /No se encuentra/);
});

// --- Auditoría: la contraseña/clave de recuperación nunca deben poder llegar
// al StatusFile (que la app lee y podría terminar en logs/depuración) --------
test("bitlocker-helper.ps1: ningún Write-KdStatus interpola la contraseña, la clave de recuperación o el SecureString", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "bitlocker-helper.ps1"), "utf-8");
  const calls = source.match(/Write-KdStatus\s+@\{[^}]*\}/g) || [];
  assert.ok(calls.length >= 8, "se esperaban varias llamadas a Write-KdStatus para revisar");
  const forbidden = /\$password\b|\$Key\b|\$secure\b|\$SecurePassword\b|\$RecoveryPassword\b/i;
  for (const call of calls) {
    assert.ok(!forbidden.test(call), "Write-KdStatus no debe referenciar secretos: " + call);
  }
});

// La línea de comandos con la que se lanza el ayudante (lo único que main.js
// arma con datos externos) tampoco debe poder llevar nada parecido a un
// secreto: sólo acción, letra, ruta de status y VolumeId (ver preload.js /
// buildHelperLaunchScript: encryptDrive() ni siquiera recibe una contraseña
// como argumento — la pide el propio ayudante en su ventana).
test("buildHelperLaunchScript: los argumentos lanzados nunca incluyen algo parecido a una contraseña", () => {
  const script = buildHelperLaunchScript({ ...base, fullDisk: true });
  assert.ok(!/-Password|-SecurePassword|-RecoveryPassword/i.test(script));
});

test("readHelperStatus lee el JSON (con o sin BOM) y devuelve null si aún no existe", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kopia-bl-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fp = path.join(dir, "E-Encrypt.json");
  assert.equal(readHelperStatus(fp), null);
  fs.writeFileSync(fp, "\uFEFF" + JSON.stringify({ phase: "encrypting", percent: 42.5 }));
  assert.deepEqual(readHelperStatus(fp), { phase: "encrypting", percent: 42.5 });
});
