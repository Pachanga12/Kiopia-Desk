"use strict";

// Piezas de Windows que no necesitan administrador: la contraseña de las copias
// cifradas, expulsar el disco y el PowerShell que queda abierto para las
// consultas de discos.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
  ejectScriptPath,
  parseEjectOutput,
  ejectDrive,
  runPowerShellQuery,
  stopPowerShellWorker,
  listDrives,
} = require("../lib/core.js");

const soloWindows = { skip: process.platform !== "win32" && "requiere Windows (PowerShell)" };

// --- Contraseña de las copias cifradas ------------------------------------------

test("validateNewPassword: mínimo 8, máximo 256, sin caracteres de control", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.equal(validateNewPassword("1234567").ok, false);
  assert.equal(validateNewPassword("12345678").ok, true);
  assert.equal(validateNewPassword("Contraseña Ñandú €9").ok, true);
  assert.equal(validateNewPassword("x".repeat(256)).ok, true);
  assert.equal(validateNewPassword("x".repeat(257)).ok, false);
  assert.equal(validateNewPassword("con\ttabulador").ok, false);
  assert.equal(validateNewPassword("con\nsalto123").ok, false);
  assert.equal(validateNewPassword(undefined).ok, false);
  assert.equal(validateNewPassword(12345678).ok, false);
});

// --- Expulsar -------------------------------------------------------------------

test("ejectScriptPath apunta a app.asar.unpacked dentro del instalador", () => {
  const p = ejectScriptPath(path.join("C:\\", "Program Files", "Kopia Desk v3", "resources", "app.asar", "lib"));
  assert.equal(p, path.join("C:\\", "Program Files", "Kopia Desk v3", "resources", "app.asar.unpacked", "lib", "eject-drive.ps1"));
  const dev = path.join(__dirname, "..", "lib");
  assert.equal(ejectScriptPath(dev), path.join(dev, "eject-drive.ps1"));
});

test("parseEjectOutput: OK, vetos de Windows y errores", () => {
  assert.deepEqual(parseEjectOutput("KD-EJECT:OK"), { ok: true });
  const enUso = parseEjectOutput("KD-EJECT:VETO:6:USBSTOR\\Disk&Ven_X");
  assert.equal(enUso.ok, false);
  assert.equal(enUso.vetoType, 6);
  assert.match(enUso.error, /usando el disco/);
  assert.match(parseEjectOutput("KD-EJECT:VETO:4:Explorer.EXE").error, /Programa: Explorer\.EXE/);
  assert.match(parseEjectOutput("KD-EJECT:ERR:not-removable:x").error, /no considera este disco extraíble/);
  assert.equal(parseEjectOutput("KD-EJECT:ERR:missing:No se pudo abrir el disco Q:.").code, "missing");
  assert.equal(parseEjectOutput("basura").ok, false);
});

test("ejectDrive: una letra inválida no lanza nada", async () => {
  await assert.rejects(ejectDrive("C:\\Windows", "x.ps1"), /Letra de unidad no válida/);
  await assert.rejects(ejectDrive("", "x.ps1"), /Letra de unidad no válida/);
});

test("ejectDrive: una letra sin disco responde rápido que no existe (sin expulsar nada)", soloWindows, async () => {
  const libre = [..."ZYXWVUTSRQPONMLKJIHG"].find((l) => !fs.existsSync(l + ":\\"));
  const t0 = Date.now();
  const res = await ejectDrive(libre, ejectScriptPath(path.join(__dirname, "..", "lib")));
  assert.equal(res.ok, false);
  assert.equal(res.code, "missing");
  assert.ok(Date.now() - t0 < 15000, "como archivo tarda menos de un segundo, no ~30 s");
});

// --- PowerShell que queda abierto para las consultas (velocidad) -----------------

test("runPowerShellQuery: devuelve lo que escribe el script, con tildes, y varias a la vez no se mezclan", soloWindows, async (t) => {
  t.after(stopPowerShellWorker);
  assert.equal(await runPowerShellQuery("'Ñandú ágil'"), "Ñandú ágil");
  const res = await Promise.all([1, 2, 3, 4].map((n) => runPowerShellQuery("Start-Sleep -Milliseconds " + (40 - n * 10) + "; " + n)));
  assert.deepEqual(res, ["1", "2", "3", "4"]);
});

test("runPowerShellQuery: si el proceso abierto se cierra, la consulta sale igual (se lanza aparte)", soloWindows, async (t) => {
  t.after(stopPowerShellWorker);
  assert.equal(await runPowerShellQuery("'antes'"), "antes");
  stopPowerShellWorker();
  assert.equal(await runPowerShellQuery("'despues'"), "despues");
});

test("runPowerShellQuery: un script con error falla (no devuelve basura como resultado)", soloWindows, async (t) => {
  t.after(stopPowerShellWorker);
  await assert.rejects(runPowerShellQuery("throw 'fallo a propósito'"));
  assert.equal(await runPowerShellQuery("'sigue funcionando'"), "sigue funcionando");
});

test("runPowerShellQuery: una consulta colgada se corta por tiempo y la siguiente funciona", soloWindows, async (t) => {
  t.after(stopPowerShellWorker);
  const t0 = Date.now();
  await assert.rejects(runPowerShellQuery("Start-Sleep -Seconds 30; 'tarde'", 1500));
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(await runPowerShellQuery("'otra vez bien'"), "otra vez bien");
});

test("listDrives por el proceso abierto devuelve lo mismo que antes (incluye la unidad de Windows)", soloWindows, async (t) => {
  t.after(stopPowerShellWorker);
  const d = await listDrives();
  const sys = (process.env.SystemDrive || "C:").toUpperCase() + "\\";
  assert.ok(d.some((x) => x.root.toUpperCase() === sys && x.isSystemDrive), "falta " + sys);
  assert.ok(d.every((x) => /^[A-Z]:\\$/.test(x.root)));
});
