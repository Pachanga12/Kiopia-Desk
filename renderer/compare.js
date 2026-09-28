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
async function compareManifests(current, previous, deep, hashFile, onProgress) {
  const newFiles = [];
  const changedFiles = [];
  const missingFiles = [];
  const touchedFiles = [];
  const entries = Object.entries(current);
  let checked = 0;

  for (const [filePath, file] of entries) {
    checked++;
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
        try {
          if (onProgress && checked % 20 === 0) onProgress(checked, entries.length, filePath);
          file.hash = await hashFile(file.fullPath);
          changed = file.hash !== old.hash;
          if (!changed && dateChanged) touchedFiles.push(file);
        } catch {
          changed = true;
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
