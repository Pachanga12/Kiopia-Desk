"use strict";

// Restaurar por carpetas (renderer/restore-tree.js): árbol, selección con
// casillas y carpeta con el nombre de la respaldada.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFolderTree,
  sortedChildren,
  allFolderPaths,
  setFolderSelected,
  folderState,
  filesForSelection,
  restoreFolderName,
  withRestoreFolder,
} = require("../renderer/restore-tree.js");

const archivos = () => [
  { path: "portada.png", size: 10 },
  { path: "Vacaciones/playa.jpg", size: 100 },
  { path: "Vacaciones/2025/sol.jpg", size: 50 },
  { path: "Capturas/c1.png", size: 7 },
  { path: "Capturas/c2.png", size: 3 },
  { path: "familia/cumple.jpg", size: 40 },
];

test("el árbol tiene las carpetas con sus archivos y totales (incluidas las subcarpetas)", () => {
  const t = buildFolderTree("Imágenes", archivos());
  assert.equal(t.name, "Imágenes");
  assert.equal(t.fileCount, 6);
  assert.equal(t.bytes, 210);
  assert.deepEqual(t.files.map((f) => f.path), ["portada.png"]);
  const vac = t.children.get("Vacaciones");
  assert.equal(vac.fileCount, 2);
  assert.equal(vac.bytes, 150);
  assert.equal(vac.children.get("2025").path, "Vacaciones/2025");
  assert.deepEqual(sortedChildren(t).map((c) => c.name), ["Capturas", "familia", "Vacaciones"], "orden por nombre sin distinguir mayúsculas");
});

test("todo marcado restaura todos los archivos", () => {
  const t = buildFolderTree("Imágenes", archivos());
  const sel = allFolderPaths(t);
  assert.equal(filesForSelection(t, sel).length, 6);
  assert.equal(folderState(sel, t), "all");
});

test("desmarcar una carpeta quita también sus subcarpetas; la raíz queda a medias", () => {
  const t = buildFolderTree("Imágenes", archivos());
  const sel = allFolderPaths(t);
  setFolderSelected(sel, t.children.get("Vacaciones"), false);
  const rutas = filesForSelection(t, sel).map((f) => f.path).sort();
  assert.deepEqual(rutas, ["Capturas/c1.png", "Capturas/c2.png", "familia/cumple.jpg", "portada.png"]);
  assert.equal(folderState(sel, t), "some");
  assert.equal(folderState(sel, t.children.get("Vacaciones")), "none");
});

test("marcar sólo una subcarpeta restaura sólo lo suyo", () => {
  const t = buildFolderTree("Imágenes", archivos());
  const sel = new Set();
  setFolderSelected(sel, t.children.get("Vacaciones").children.get("2025"), true);
  assert.deepEqual(filesForSelection(t, sel).map((f) => f.path), ["Vacaciones/2025/sol.jpg"]);
  assert.equal(folderState(sel, t.children.get("Vacaciones")), "some");
});

test("se restaura dentro de una carpeta con el nombre de la respaldada (Capturas vuelve como Capturas)", () => {
  const files = [{ path: "c1.png", size: 1 }, { path: "2024/c2.png", size: 1 }];
  assert.deepEqual(withRestoreFolder("Capturas", files).map((f) => f.path), ["Capturas/c1.png", "Capturas/2024/c2.png"]);
  assert.equal(files[0].path, "c1.png", "no cambia la lista original");
});

test("el nombre de la carpeta restaurada no lleva caracteres que Windows no admite", () => {
  assert.equal(restoreFolderName("Fotos: 2024?"), "Fotos_ 2024_");
  assert.equal(restoreFolderName("Documentos. "), "Documentos");
  assert.equal(restoreFolderName(""), "carpeta");
  assert.equal(restoreFolderName("Imágenes"), "Imágenes");
});
