"use strict";

// Compara el manifiesto recién escaneado contra el anterior para decidir qué
// copiar. Vive en su propio archivo (en vez de dentro de app.js) para poder
// probarlo con `node --test` sin un DOM real: se carga como script plano en
// index.html (antes que app.js, mismo scope global) y también como módulo
// CommonJS en los tests (ver el module.exports al final).
//
//   - Sin `old`: nuevo.
//   - Tamaño distinto: cambiado (no hace falta hashear para saberlo).
//   - Tamaño igual, fecha distinta (o `deep`): se hashea contra el hash
//     guardado. Si no hay hash guardado (manifiesto de una versión anterior
//     sin SHA-256), se fuerza "cambiado" una vez para registrarlo.
//   - Tamaño igual Y fecha igual: se asume sin cambios. Limitación conocida
//     (problema 3 del README): un archivo tocado sin que cambien ni el
//     tamaño ni la fecha de modificación no se detecta salvo con `deep`
//     (que hashea también estos casos). No hay forma de detectarlo sin leer
//     el contenido de TODOS los archivos en cada escaneo.
//   - Estaba en el anterior pero no en el actual: falta (borrado o movido).
//
// `hashFile(fullPath)` y `onProgress(checked, total, filePath)` se inyectan
// en vez de usar window.kopiaAPI/DOM directamente: en la app real, app.js
// pasa window.kopiaAPI.hashFile y showProgress; en los tests, un stub.
//
// `concurrency`: cuántos hashes se calculan a la vez. En un SSD, 4 a la vez
// fue 2,2 veces más rápido que de a uno (medido); en un disco mecánico se usa 1
// (leer varios a la vez obliga al cabezal a saltar). El resultado sale siempre
// en el mismo orden que con 1, aunque los hashes terminen en otro orden.
async function compareManifests(current, previous, deep, hashFile, onProgress, concurrency = 1) {
  const newFiles = [];
  const changedFiles = [];
  const missingFiles = [];
  const touchedFiles = [];
  const entries = Object.entries(current);

  // 1) Qué archivos hay que hashear (mismo tamaño y fecha distinta, o `deep`).
  const needsHash = (old, file) =>
    old && old.hash && old.size === file.size && (old.lastModified !== file.lastModified || deep);
  const toHash = entries.filter(([filePath, file]) => needsHash(previous[filePath], file)).map(([, file]) => file);

  // 2) Calcularlos, varios a la vez. Un error cuenta como "cambiado".
  const hashes = new Map();
  let done = 0;
  const hashOne = async (file) => {
    try {
      hashes.set(file, await hashFile(file.fullPath));
    } catch {
      hashes.set(file, null);
    }
    done++;
    if (onProgress && done % 20 === 0) onProgress(done, toHash.length, file.path);
  };
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const inFlight = new Set();
  for (const file of toHash) {
    const p = hashOne(file);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    if (inFlight.size >= limit) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);

  // 3) Clasificar en el orden original.
  for (const [filePath, file] of entries) {
    const old = previous[filePath];

    if (!old) {
      newFiles.push(file);
      continue;
    }

    let changed = old.size !== file.size;
    const dateChanged = old.lastModified !== file.lastModified;
    if (!changed && (dateChanged || (deep && old.hash))) {
      if (!old.hash) {
        changed = true;
      } else {
        const hash = hashes.get(file);
        if (hash == null) {
          changed = true;
        } else {
          file.hash = hash;
          changed = hash !== old.hash;
          if (!changed && dateChanged) touchedFiles.push(file);
        }
      }
    } else if (!changed) {
      file.hash = old.hash || null;
    }

    if (changed) changedFiles.push({ ...file, previous: old });
  }

  for (const [filePath, file] of Object.entries(previous)) {
    if (!current[filePath]) missingFiles.push(file);
  }

  return { newFiles, changedFiles, missingFiles, touchedFiles };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { compareManifests };
}
