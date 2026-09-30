"use strict";

// Unidades de VeraCrypt como destino (desde v2.5).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { mapVolume, isVeraCryptVolumeId, isValidVolumeId, isProtectedSystemVolume } = require("../lib/core.js");

test("identidad de VeraCrypt: «veracrypt:» + 8 hexadecimales, y no vale como identidad de Get-Volume", () => {
  assert.equal(isVeraCryptVolumeId("veracrypt:02F71F43"), true);
  assert.equal(isVeraCryptVolumeId("veracrypt:02f71f43"), true);
  assert.equal(isVeraCryptVolumeId("veracrypt:"), false, "sin número de serie no hay identidad");
  assert.equal(isVeraCryptVolumeId("veracrypt:02F71F43; calc"), false);
  assert.equal(isVeraCryptVolumeId("\\\\?\\Volume{9f3686d6-b77f-11f1-bf94-806e6f6e6963}\\"), false);
  assert.equal(isValidVolumeId("veracrypt:02F71F43"), false);
});

test("una unidad de VeraCrypt de la lista de Windows se reconoce como tal, con su identidad", () => {
  const d = mapVolume({ DriveLetter: "R", FileSystemLabel: "", SizeRemaining: 298e6, Size: 314e6, UniqueId: "veracrypt:02F71F43", FS: "NTFS", Disk: null, SysDisk: null, SysLetter: "C", VeraCrypt: true });
  assert.equal(d.root, "R:\\");
  assert.equal(d.veracrypt, true);
  assert.equal(d.volumeId, "veracrypt:02F71F43");
  assert.equal(d.onSystemDisk, null, "no se sabe en qué disco físico está");
  assert.equal(isProtectedSystemVolume(d), true, "por eso nunca se le ofrece Expulsar");
  const normal = mapVolume({ DriveLetter: "E", UniqueId: "\\\\?\\Volume{9f3686d6-b77f-11f1-bf94-806e6f6e6963}\\", SysDisk: false, SysLetter: "C" });
  assert.equal(normal.veracrypt, false);
  const falsa = mapVolume({ DriveLetter: "Q", UniqueId: "veracrypt:zz", SysLetter: "C" });
  assert.equal(falsa.volumeId, null, "una identidad mal formada se descarta");
});

test("la lista de discos busca unidades de VeraCrypt sólo por su dispositivo (no subst ni red)", () => {
  const core = fs.readFileSync(path.join(__dirname, "..", "lib", "core.js"), "utf-8");
  assert.match(core, /-like '\\\\Device\\\\VeraCryptVolume\*'/);
  assert.match(core, /DriveType -eq 2 -or \$_\.DriveType -eq 3/);
});
