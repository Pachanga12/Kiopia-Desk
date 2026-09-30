"use strict";

// Árbol de carpetas para "Restaurar": a partir de la lista de archivos de una
// carpeta del backup, arma sus subcarpetas para elegir cuáles restaurar, y
// calcula qué archivos entran y a dónde van. Vive en su propio archivo (como
// compare.js) para poder probarlo con `node --test` sin un DOM: se carga como
// script plano en index.html antes de app.js y como módulo en los tests.
//
// La selección es un Set de rutas de carpeta ("" = la carpeta raíz, "Fotos",
// "Fotos/Vacaciones"...). Cada carpeta marcada aporta SUS archivos directos;
// marcar o desmarcar una carpeta lo hace también con todo lo que tiene dentro.

function newFolderNode(name, folderPath) {
  return { name, path: folderPath, files: [], children: new Map(), fileCount: 0, bytes: 0 };
}

// files: [{ path: "Fotos/Vacaciones/a.jpg", size, ... }] (rutas con "/").
function buildFolderTree(rootName, files) {
  const root = newFolderNode(rootName, "");
  for (const file of files || []) {
    const parts = String(file.path || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.children.has(part)) {
        node.children.set(part, newFolderNode(part, node.path ? node.path + "/" + part : part));
      }
      node = node.children.get(part);
    }
    node.files.push(file);
  }
  (function totals(node) {
    node.fileCount = node.files.length;
    node.bytes = node.files.reduce((t, f) => t + (Number(f.size) || 0), 0);
    for (const child of node.children.values()) {
      totals(child);
      node.fileCount += child.fileCount;
      node.bytes += child.bytes;
    }
  })(root);
  return root;
}

// Subcarpetas ordenadas por nombre (como el Explorador, sin distinguir mayúsculas).
function sortedChildren(node) {
  return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base", numeric: true }));
}

// La carpeta y todas las que tiene dentro.
function folderAndDescendants(node) {
  const out = [node.path];
  for (const child of node.children.values()) out.push(...folderAndDescendants(child));
  return out;
}

function allFolderPaths(tree) {
  return new Set(folderAndDescendants(tree));
}

// Marca o desmarca una carpeta junto con todo lo que tiene dentro.
function setFolderSelected(selected, node, on) {
  for (const p of folderAndDescendants(node)) {
    if (on) selected.add(p);
    else selected.delete(p);
  }
}

// "all" (ella y todo lo de dentro), "none" o "some" (para la casilla a medias).
// Sólo cuentan las carpetas que tienen algún archivo.
function folderState(selected, node) {
  let on = 0;
  let off = 0;
  (function walk(n) {
    if (n.files.length) {
      if (selected.has(n.path)) on++;
      else off++;
    }
    for (const child of n.children.values()) walk(child);
  })(node);
  if (!on) return "none";
  return off ? "some" : "all";
}

// Archivos que se restauran con esta selección.
function filesForSelection(tree, selected) {
  const out = [];
  (function walk(n) {
    if (selected.has(n.path)) out.push(...n.files);
    for (const child of n.children.values()) walk(child);
  })(tree);
  return out;
}

// Nombre de la carpeta que se crea al restaurar: el de la carpeta respaldada,
// sin caracteres que Windows no admite (ni puntos o espacios al final).
function restoreFolderName(sourceName) {
  const clean = String(sourceName || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 120);
  return clean || "carpeta";
}

// Se restaura DENTRO de una carpeta con el nombre de la respaldada: "Capturas"
// vuelve como <destino>\Capturas\..., con sus subcarpetas.
function withRestoreFolder(sourceName, files) {
  const folder = restoreFolderName(sourceName);
  return files.map((f) => ({ ...f, path: folder + "/" + f.path }));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildFolderTree,
    sortedChildren,
    allFolderPaths,
    setFolderSelected,
    folderState,
    filesForSelection,
    restoreFolderName,
    withRestoreFolder,
  };
}
