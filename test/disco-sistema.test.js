"use strict";

// Protección del disco del sistema y cambios de disco antes de cifrar o
// bloquear. Se prueba la decisión de la app (lib/core.js) y la del ayudante
// elevado (lib/bitlocker-helper.ps1, con datos de discos simulados) con los
// mismos escenarios: las dos capas tienen que coincidir.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { mapVolume, isProtectedSystemVolume, checkBitLockerTarget, isValidVolumeId, driveIdentityChanged } = require("../lib/core.js");

const VOL_USB = "\\\\?\\Volume{aaaaaaaa-0000-0000-0000-000000000001}\\";
const VOL_OTRO_USB = "\\\\?\\Volume{bbbbbbbb-0000-0000-0000-000000000002}\\";
const VOL_C = "\\\\?\\Volume{cccccccc-0000-0000-0000-000000000003}\\";
const VOL_RECUP = "\\\\?\\Volume{dddddddd-0000-0000-0000-000000000004}\\";

// Disco 1 = SSD del sistema (C: y su partición de recuperación), disco 0 = HDD
// de datos (D:), disco 2 = USB (E:). Igual que el equipo donde se desarrolló.
function volume(letter, disk, sysDisk, uniqueId, sysLetter = "C:") {
  return mapVolume({
    DriveLetter: letter,
    FileSystemLabel: "",
    SizeRemaining: 1,
    Size: 2,
    FS: "NTFS",
    Disk: disk,
    SysDisk: sysDisk,
    UniqueId: uniqueId,
    SysLetter: sysLetter,
  });
}

const equipo = [
  volume("C", 1, true, VOL_C),
  volume("D", 0, false, "\\\\?\\Volume{eeeeeeee-0000-0000-0000-000000000005}\\"),
  volume("E", 2, false, VOL_USB),
];

// --- Escenarios compartidos por las dos capas ---------------------------------
// [nombre, discos al momento de actuar, letra, volumen elegido, código esperado]
const escenarios = [
  ["USB elegido y sin cambios: se permite", equipo, "E", VOL_USB, "ok"],
  ["la unidad de Windows (C:) nunca", equipo, "C", VOL_C, "system-disk"],
  [
    "otra partición del disco del sistema con letra (p. ej. recuperación como R:)",
    [...equipo, volume("R", 1, true, VOL_RECUP)],
    "R",
    VOL_RECUP,
    "system-disk",
  ],
  [
    "se cambió el USB por otro que tomó la misma letra",
    [equipo[0], equipo[1], volume("E", 3, false, VOL_OTRO_USB)],
    "E",
    VOL_USB,
    "changed",
  ],
  [
    "a la letra elegida se le asignó una partición del disco del sistema",
    [equipo[0], equipo[1], volume("E", 1, true, VOL_RECUP)],
    "E",
    VOL_USB,
    "changed",
  ],
  ["el USB se desconectó", [equipo[0], equipo[1]], "E", VOL_USB, "missing"],
  [
    "no se sabe en qué disco físico está: ante la duda, no",
    [equipo[0], equipo[1], volume("E", null, null, VOL_USB)],
    "E",
    VOL_USB,
    "system-disk",
  ],
  [
    "Windows instalado en otra letra (W:): se protege W:, no C:",
    [volume("W", 1, true, VOL_C, "W:"), volume("E", 2, false, VOL_USB, "W:")],
    "W",
    VOL_C,
    "system-disk",
  ],
  ["sin identidad elegida (p. ej. llamada sin volumeId)", equipo, "E", undefined, "changed"],
];

// --- Capa de la app -----------------------------------------------------------

test("mapVolume conserva disco, disco del sistema e identidad; descarta identidades mal formadas", () => {
  const v = volume("E", 2, false, VOL_USB);
  assert.equal(v.diskNumber, 2);
  assert.equal(v.onSystemDisk, false);
  assert.equal(v.volumeId, VOL_USB);
  assert.equal(volume("E", 2, false, "E:\\").volumeId, null);
  assert.equal(volume("E", null, null, VOL_USB).onSystemDisk, null);
});

test("isProtectedSystemVolume: protege el sistema y lo desconocido; deja pasar otros discos", () => {
  assert.equal(isProtectedSystemVolume(equipo[0]), true);
  assert.equal(isProtectedSystemVolume(equipo[1]), false);
  assert.equal(isProtectedSystemVolume(equipo[2]), false);
  assert.equal(isProtectedSystemVolume(volume("E", null, null, VOL_USB)), true);
  assert.equal(isProtectedSystemVolume(undefined), true);
});

test("isValidVolumeId sólo acepta el formato \\\\?\\Volume{GUID}\\", () => {
  assert.ok(isValidVolumeId(VOL_USB));
  assert.ok(!isValidVolumeId("C:\\"));
  assert.ok(!isValidVolumeId(VOL_USB + "x"));
  assert.ok(!isValidVolumeId(null));
});

for (const [nombre, discos, letra, elegido, esperado] of escenarios) {
  test("app: " + nombre, () => {
    const r = checkBitLockerTarget(discos, letra, elegido);
    assert.equal(r.ok ? "ok" : r.code, esperado, r.error);
  });
}

// --- driveIdentityChanged: misma protección que BitLocker, para backups normales ---
// Hallazgo de la auditoría: backup:copy-files sólo comprobaba que la LETRA
// siguiera montada (assertDestRoot), nunca que fuera el MISMO disco físico.
// Si el usuario cambiaba el USB a mitad de un backup grande por otro que
// Windows le asigna la misma letra, el resto de los archivos se iban al disco
// nuevo sin ningún aviso. driveIdentityChanged() es la pieza que lo detecta.

test("driveIdentityChanged: sin volumeId esperado, no hay nada que comparar (compatibilidad)", () => {
  assert.equal(driveIdentityChanged(equipo, "E", undefined), false);
  assert.equal(driveIdentityChanged(equipo, "E", ""), false);
});

test("driveIdentityChanged: mismo volumen, no cambió", () => {
  assert.equal(driveIdentityChanged(equipo, "E", VOL_USB), false);
});

test("driveIdentityChanged: se cambió el USB por otro con la misma letra", () => {
  const discosNuevos = [equipo[0], equipo[1], volume("E", 3, false, VOL_OTRO_USB)];
  assert.equal(driveIdentityChanged(discosNuevos, "E", VOL_USB), true);
});

test("driveIdentityChanged: el disco se desconectó (ya no está la letra) -> desconocido, no 'cambió'", () => {
  // A propósito no es `true`: no se puede distinguir de un hipo al leer la
  // lista de discos, y aquí se prefiere no bloquear un backup por las dudas.
  assert.equal(driveIdentityChanged([equipo[0], equipo[1]], "E", VOL_USB), null);
});

test("driveIdentityChanged: no distingue mayúsculas de la letra", () => {
  assert.equal(driveIdentityChanged(equipo, "e", VOL_USB), false);
});

// --- Capa del ayudante elevado (misma tabla, con datos simulados) --------------

const HELPER = path.join(__dirname, "..", "lib", "bitlocker-helper.ps1");

function helperDecisions() {
  // Convierte los escenarios a los datos que Test-KdTargetAllowed recibe de
  // Windows y los evalúa todos en una sola llamada a PowerShell.
  const casos = escenarios.map(([, discos, letra, elegido]) => {
    const vol = discos.find((d) => d.root[0] === letra);
    const sistema = discos.find((d) => d.isSystemDrive) || discos[0];
    return {
      Letter: letra,
      SystemLetter: sistema.root[0],
      DiskNumber: vol ? vol.diskNumber : null,
      SystemDisks: discos.filter((d) => d.onSystemDisk === true).map((d) => d.diskNumber),
      CurrentVolumeId: vol ? vol.volumeId : null,
      ExpectedVolumeId: elegido || "",
    };
  });
  const script =
    `. '${HELPER.replace(/'/g, "''")}' -Action Import; ` +
    "$casos = [Console]::In.ReadToEnd() | ConvertFrom-Json; " +
    "@($casos | ForEach-Object { $r = Test-KdTargetAllowed -Letter $_.Letter -SystemLetter $_.SystemLetter -DiskNumber $_.DiskNumber " +
    "-SystemDisks @($_.SystemDisks) -CurrentVolumeId $_.CurrentVolumeId -ExpectedVolumeId $_.ExpectedVolumeId; " +
    "if ($r.ok) { 'ok' } else { $r.code } }) -join ','";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    input: JSON.stringify(casos),
    encoding: "utf-8",
  });
  return out.trim().split(",");
}

test("ayudante: mismas decisiones que la app en todos los escenarios", { skip: process.platform !== "win32" }, () => {
  const decisiones = helperDecisions();
  escenarios.forEach(([nombre, , , , esperado], i) => {
    // El ayudante distingue "no se sabe en qué disco está" con su propio código;
    // lo importante es que tampoco lo permite.
    const obtenido = decisiones[i] === "system-check-failed" ? "system-disk" : decisiones[i];
    assert.equal(obtenido, esperado, "ayudante: " + nombre);
  });
});

// --- Auditoría: invocar el .ps1 REAL directamente, sin pasar por main.js -------
// Todo lo de arriba prueba Test-KdTargetAllowed llamada a mano con datos
// simulados (-Action Import). Esto va un paso más allá: ejecuta el archivo
// .ps1 tal cual lo haría un atacante que se salta main.js/buildHelperLaunchScript
// por completo, con -Action Encrypt de verdad y la letra/VolumeId reales de
// ESTA máquina. Nunca llega a tocar BitLocker (Assert-KdTarget corta antes),
// así que es seguro correrlo contra el disco C: real.

function runHelperDirect(args) {
  const HELPER = path.join(__dirname, "..", "lib", "bitlocker-helper.ps1");
  const statusFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kopia-bl-direct-")), "status.json");
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-File", HELPER, "-StatusFile", statusFile, ...args],
      { encoding: "utf-8", timeout: 15000 }
    );
    return { exitCode: 0, status: JSON.parse(fs.readFileSync(statusFile, "utf-8")) };
  } catch (err) {
    let status = null;
    try {
      status = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
    } catch {
      // el proceso pudo morir antes de escribir el status (p. ej. rechazado
      // por PowerShell al validar parámetros, ni siquiera llegó a correr)
    }
    return { exitCode: err.status, status, stderr: String(err.stderr || "") };
  } finally {
    fs.rmSync(path.dirname(statusFile), { recursive: true, force: true });
  }
}

test(
  "ayudante real: -Drive con intento de inyección se rechaza en el binding de PowerShell, antes de correr una sola línea del script",
  { skip: process.platform !== "win32" },
  () => {
    const r = runHelperDirect([
      "-Action",
      "Encrypt",
      "-Drive",
      "C; calc",
      "-VolumeId",
      "\\\\?\\Volume{12345678-9abc-def0-1234-56789abcdef0}\\",
    ]);
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.status, null, "no debe llegar a escribir ningun status: se rechaza antes de ejecutar el script");
    // El mensaje de PowerShell trae acentos que el pipe de execFileSync a
    // veces entrega con otra codepage; se busca la parte ASCII inequívoca.
    assert.match(r.stderr, /ParameterArgumentValidationError/);
  }
);

test(
  "ayudante real: -Action Encrypt sobre C: con su VolumeId REAL se rechaza (system-disk), sin abrir ningún diálogo",
  { skip: process.platform !== "win32" },
  () => {
    const realVolumeId = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-Volume -DriveLetter C).UniqueId"],
      { encoding: "utf-8" }
    ).trim();
    assert.ok(isValidVolumeId(realVolumeId), "precondición: necesitamos el VolumeId real de C: para esta prueba");

    const r = runHelperDirect(["-Action", "Encrypt", "-Drive", "C", "-VolumeId", realVolumeId]);
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.status.code, "system-disk");
    assert.match(r.status.error, /unidad de Windows/);
  }
);

test(
  "ayudante real: -Action Lock sobre C: con su VolumeId REAL también se rechaza (system-disk)",
  { skip: process.platform !== "win32" },
  () => {
    const realVolumeId = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-Volume -DriveLetter C).UniqueId"],
      { encoding: "utf-8" }
    ).trim();
    const r = runHelperDirect(["-Action", "Lock", "-Drive", "C", "-VolumeId", realVolumeId]);
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.status.code, "system-disk");
  }
);

test(
  "ayudante real: una letra que no existe (Q:) falla como 'missing', sin abrir ningún diálogo",
  { skip: process.platform !== "win32" },
  () => {
    const r = runHelperDirect([
      "-Action",
      "Encrypt",
      "-Drive",
      "Q",
      "-VolumeId",
      "\\\\?\\Volume{12345678-9abc-def0-1234-56789abcdef0}\\",
    ]);
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.status.code, "missing");
  }
);
