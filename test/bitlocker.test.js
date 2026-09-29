"use strict";

// Tests del lanzamiento del ayudante de BitLocker (lo que no requiere
// administrador): validación de argumentos, entrecomillado y lectura de
// resultados. El ayudante en sí se probó contra un disco virtual.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { execFileSync } = require("child_process");
const {
  bitlockerHelperPath,
  buildHelperLaunchScript,
  parseHelperLaunchOutput,
  readHelperStatus,
  isProcessAlive,
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
  protectPasswordForHelper,
  ejectScriptPath,
  parseEjectOutput,
  ejectDrive,
  runPowerShellQuery,
  stopPowerShellWorker,
  listDrives,
} = require("../lib/core.js");

const soloWindows = { skip: process.platform !== "win32" && "requiere Windows (DPAPI, PowerShell)" };
const HELPER = path.join(__dirname, "..", "lib", "bitlocker-helper.ps1");

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

// Mínimo de la contraseña: 8 (el de BitLocker), en un solo sitio.
test("bitlocker-helper.ps1: la contraseña exige mínimo 8 caracteres y la ventana usa ese valor", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "bitlocker-helper.ps1"), "utf-8");
  assert.match(source, /^\$KdMinPasswordLength = 8$/m);
  assert.match(source, /\$ok\.Enabled = \(\$p\.Length -ge \$KdMinPasswordLength\) -and \$match/);
  assert.match(source, /"Contraseña \(mínimo \$KdMinPasswordLength caracteres\)"/);
  assert.ok(!/\$ok\.Enabled = \(\$p\.Length -ge \d+\)/.test(source), "el botón no debe usar un número fijo");
});

// La línea de comandos con la que se lanza el ayudante (lo único que main.js
// arma con datos externos) tampoco debe poder llevar nada parecido a un
// secreto: sólo acción, letra, ruta de status y VolumeId (ver preload.js /
// buildHelperLaunchScript: encryptDrive() ni siquiera recibe una contraseña
// como argumento — la pide el propio ayudante en su ventana).
test("buildHelperLaunchScript: los argumentos lanzados nunca incluyen algo parecido a una contraseña", () => {
  const passwordFile = "C:\\Users\\Ana\\AppData\\Roaming\\kopia-desk\\bitlocker\\E-Encrypt.pw";
  for (const extra of [{}, { passwordFile }]) {
    const script = buildHelperLaunchScript({ ...base, fullDisk: true, ...extra });
    assert.ok(!/-Password\b|-SecurePassword|-RecoveryPassword/i.test(script));
  }
});

// --- Contraseña escrita en el panel de la app --------------------------------

test("validateNewPassword: mínimo 8 (el de BitLocker), máximo 256, sin caracteres de control", () => {
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

test("buildHelperLaunchScript: -PasswordFile sólo al cifrar y con una ruta segura", () => {
  const passwordFile = "C:\\Users\\Ana\\AppData\\Roaming\\kopia-desk\\bitlocker\\E-Encrypt.pw";
  const script = buildHelperLaunchScript({ ...base, passwordFile });
  assert.ok(script.includes(`'-PasswordFile', '"${passwordFile}"'`));
  assert.ok(!buildHelperLaunchScript(base).includes("-PasswordFile"));
  assert.throws(() => buildHelperLaunchScript({ ...base, action: "Lock", passwordFile }), /Sólo al cifrar/);
  assert.throws(() => buildHelperLaunchScript({ ...base, passwordFile: 'C:\\x" -Drive "C' }), /Ruta no válida/);
});

test("protectPasswordForHelper rechaza contraseñas inválidas sin lanzar PowerShell", async () => {
  await assert.rejects(protectPasswordForHelper("corta"), /al menos 8/);
});

// Ida y vuelta real con DPAPI: lo que descifra PowerShell (como hace el
// ayudante con ConvertTo-SecureString) es exactamente lo escrito, con tildes,
// eñes y símbolos, y el archivo protegido no contiene la contraseña.
test("protectPasswordForHelper: DPAPI devuelve exactamente la contraseña escrita", soloWindows, async () => {
  for (const password of ["abcd1234", "Contraseña Ñandú €9!", "x".repeat(256)]) {
    const blob = await protectPasswordForHelper(password);
    assert.match(blob, /^[0-9a-f]+$/i);
    assert.ok(!blob.includes(password));
    const back = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$s = ConvertTo-SecureString -String ([Console]::In.ReadLine()); " +
          "$p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); " +
          "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))",
      ],
      { input: blob + "\n", encoding: "utf-8" }
    ).trim();
    assert.equal(Buffer.from(back, "base64").toString("utf-8"), password);
  }
});

// Read-KdPasswordFile corre en el ayudante ELEVADO: sólo lee y borra el .pw que
// está junto al archivo de estado; nunca toca otro archivo.
function readPasswordFileInHelper(statusFile, passwordFile) {
  const q = (s) => "'" + s.replace(/'/g, "''") + "'";
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `. ${q(HELPER)} -Action Import; $StatusFile = ${q(statusFile)}; ` +
        `$s = Read-KdPasswordFile ${q(passwordFile)}; if ($null -eq $s) { 'NULL' } else { 'LEN:' + $s.Length }`,
    ],
    { encoding: "utf-8" }
  ).trim();
}

test("ayudante: Read-KdPasswordFile lee el .pw de su carpeta y lo borra", soloWindows, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kopia-pw-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statusFile = path.join(dir, "E-Encrypt.json");
  const pw = path.join(dir, "E-Encrypt.pw");
  fs.writeFileSync(pw, await protectPasswordForHelper("Contraseña Ñandú €9!"));
  assert.equal(readPasswordFileInHelper(statusFile, pw), "LEN:20");
  assert.equal(fs.existsSync(pw), false, "el .pw se borra al leerlo");
});

test("ayudante: Read-KdPasswordFile no lee ni borra archivos fuera de su carpeta o sin extensión .pw", soloWindows, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kopia-pw-"));
  const otra = fs.mkdtempSync(path.join(os.tmpdir(), "kopia-otra-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otra, { recursive: true, force: true });
  });
  const statusFile = path.join(dir, "E-Encrypt.json");
  const blob = await protectPasswordForHelper("abcd1234");
  const fuera = path.join(otra, "E-Encrypt.pw");
  const sinExt = path.join(dir, "importante.txt");
  fs.writeFileSync(fuera, blob);
  fs.writeFileSync(sinExt, blob);
  assert.equal(readPasswordFileInHelper(statusFile, fuera), "NULL");
  assert.equal(readPasswordFileInHelper(statusFile, sinExt), "NULL");
  assert.ok(fs.existsSync(fuera) && fs.existsSync(sinExt), "no se borra nada fuera de lo esperado");
});

test("ayudante: un .pw dañado da NULL (se pide en la ventana) y se borra igual", soloWindows, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kopia-pw-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pw = path.join(dir, "E-Encrypt.pw");
  fs.writeFileSync(pw, "no-es-dpapi");
  assert.equal(readPasswordFileInHelper(path.join(dir, "E-Encrypt.json"), pw), "NULL");
  assert.equal(fs.existsSync(pw), false);
});

test("ayudante: al cifrar, lo primero es leer (y borrar) la contraseña de la app", () => {
  const source = fs.readFileSync(HELPER, "utf-8");
  const body = /function Invoke-KdEncrypt \{([\s\S]*?)\n\}/.exec(source)[1];
  assert.ok(body.indexOf("Read-KdPasswordFile") < body.indexOf("Invoke-KdEncryptSteps"));
  assert.match(body, /finally \{\s*if \(\$null -ne \$secure\) \{ \$secure\.Dispose\(\) \}/);
});

// --- Expulsar -------------------------------------------------------------------

test("ejectScriptPath apunta a app.asar.unpacked dentro del instalador", () => {
  const p = ejectScriptPath(path.join("C:\\", "Program Files", "Kopia Desk v2", "resources", "app.asar", "lib"));
  assert.equal(p, path.join("C:\\", "Program Files", "Kopia Desk v2", "resources", "app.asar.unpacked", "lib", "eject-drive.ps1"));
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

test("readHelperStatus lee el JSON (con o sin BOM) y devuelve null si aún no existe", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kopia-bl-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fp = path.join(dir, "E-Encrypt.json");
  assert.equal(readHelperStatus(fp), null);
  fs.writeFileSync(fp, "\uFEFF" + JSON.stringify({ phase: "encrypting", percent: 42.5 }));
  assert.deepEqual(readHelperStatus(fp), { phase: "encrypting", percent: 42.5 });
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
