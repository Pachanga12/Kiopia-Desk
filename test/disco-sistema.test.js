"use strict";

// Protección del disco del sistema y cambios de disco antes de expulsar
// (checkDriveTarget) y durante un backup (driveIdentityChanged).

const test = require("node:test");
const assert = require("node:assert/strict");

const { mapVolume, isProtectedSystemVolume, checkDriveTarget, isValidVolumeId, driveIdentityChanged } = require("../lib/core.js");

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
    const r = checkDriveTarget(discos, letra, elegido);
    assert.equal(r.ok ? "ok" : r.code, esperado, r.error);
  });
}

// --- driveIdentityChanged: misma protección, para backups normales ---
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
