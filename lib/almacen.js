"use strict";

// Disco de backup CIFRADO (v3): dónde y cómo se guarda cada cosa.
//
//   KiopiaDesk_Backup\
//     Abrir-KiopiaDesk.cmd, Recuperar-KiopiaDesk.ps1, LEEME-CIFRADO.txt
//                                                  (para abrirlo sin la app)
//     datos\xx\<38 hex>.kdc                          (un archivo por archivo respaldado)
//     .kiopia-data\
//       cifrado.json, cifrado.copia.json             (la caja con la clave maestra)
//       manifests\<40 hex>.kdc (+ .prev.kdc)         ({ fuente, carpeta, archivos })
//       fuentes.kdc, indice.kdc                      (carpetas de origen, deduplicación)
//       logs\<aleatorio>_<fecha>.kdc                 (informes)
//       versions\<fecha>\xx\<38 hex>.kdc + indice.kdc (versiones anteriores)
//
// En el disco no queda ningún nombre de archivo ni de carpeta en claro: sólo
// nombres opacos (HMAC de la ruta con una clave derivada de la maestra) y la
// fecha de cada backup. Todo lo que aquí se escribe lo puede leer
// Recuperar-KiopiaDesk.ps1 con la contraseña o la clave de recuperación.

const path = require("path");
const fs = (() => {
  try {
    return require("original-fs");
  } catch {
    return require("fs");
  }
})();
const cifrado = require("./cifrado");
const { BACKUP_ROOT, safeName, atomicWriteFileSync, tmpPathFor } = require("./core");

const METADATA_DIR = ".kiopia-data";
const DATA_DIR = "datos";
const VAULT_FILE = "cifrado.json";
const VAULT_COPY = "cifrado.copia.json";
const SCRIPT_NAME = "Recuperar-KiopiaDesk.ps1";
const LAUNCHER_NAME = "Abrir-KiopiaDesk.cmd";
const PORTABLE_NAME = "Kiopia Desk (portable).exe";
const README_NAME = "LEEME-CIFRADO.txt";
const MAX_SMALL_FILE = 64 * 1024 * 1024; // manifiestos e índices: más grande = sospechoso

const README_TEXT = [
  "ESTE BACKUP DE KIOPIA DESK ESTÁ CIFRADO",
  "======================================",
  "",
  "Los archivos de la carpeta \"datos\" están cifrados (AES-256) y sus nombres",
  "no se pueden leer. Sin la contraseña o la clave de recuperación no hay forma",
  "de abrirlos: ni Kiopia Desk ni nadie puede recuperarlos.",
  "",
  "Para ver o sacar tus archivos:",
  "",
  "  - Con Kiopia Desk: elige este disco y escribe la contraseña. Si el PC no",
  "    la tiene, abre «Kiopia Desk (portable).exe» de esta carpeta: funciona sin",
  "    instalarla.",
  "",
  "  - Sin Kiopia Desk, en cualquier Windows 10 u 11 (también Home), sin",
  "    instalar nada ni permisos de administrador: doble clic en",
  "    Abrir-KiopiaDesk.cmd. Pide la contraseña (o la clave de recuperación) y",
  "    muestra tus carpetas: «Ver» abre un archivo y «Sacar...» guarda lo que",
  "    elijas, ya descifrado, donde digas. Al cerrar la ventana todo queda",
  "    cifrado otra vez.",
  "",
  "  - Desde la consola (todo de una vez):",
  "    powershell -ExecutionPolicy Bypass -File Recuperar-KiopiaDesk.ps1 -Accion Recuperar -Destino D:\\Recuperado",
  "",
  "No borres ni muevas nada dentro de esta carpeta, en especial",
  ".kiopia-data\\cifrado.json: sin ese archivo no se puede descifrar nada.",
  "",
].join("\r\n");

// Doble clic en el disco: abre la ventana de Recuperar-KiopiaDesk.ps1 sin
// consola. -ExecutionPolicy Bypass sólo para este proceso (no cambia nada del
// equipo): sin él, Windows no deja ejecutar scripts por defecto.
const LAUNCHER_TEXT = [
  "@echo off",
  "rem Abre las copias cifradas de Kiopia Desk sin Kiopia Desk (ver LEEME-CIFRADO.txt).",
  'start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0Recuperar-KiopiaDesk.ps1" -Accion Abrir',
  "",
].join("\r\n");

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// --- Rutas ------------------------------------------------------------------------

function backupRoot(destKey) {
  return path.join(destKey, BACKUP_ROOT);
}

function metadataDir(destKey) {
  return path.join(destKey, BACKUP_ROOT, METADATA_DIR);
}

function vaultPath(destKey) {
  return path.join(metadataDir(destKey), VAULT_FILE);
}

function isEncrypted(destKey) {
  return fs.existsSync(vaultPath(destKey)) || fs.existsSync(path.join(metadataDir(destKey), VAULT_COPY));
}

const toSlash = (p) => String(p).replace(/\\/g, "/");

// Ruta lógica de un archivo respaldado: "<carpeta segura>/<ruta dentro>", la
// misma que tendría en un backup sin cifrar, con "/" como separador.
function logicalPath(sourceName, relativePath) {
  return safeName(sourceName) + "/" + toSlash(relativePath);
}

// "KiopiaDesk_Backup/Fotos/a.jpg" (lo que pide la interfaz) ->
// "KiopiaDesk_Backup/datos/xx/<hex>.kdc" (lo que se escribe en el disco).
function dataRelative(masterKey, relativeDest) {
  const rel = toSlash(relativeDest);
  const prefix = BACKUP_ROOT + "/";
  if (!rel.startsWith(prefix) || rel.length === prefix.length) throw new Error("Destino fuera del backup: " + relativeDest);
  const logical = rel.slice(prefix.length);
  // (Una carpeta de origen llamada "datos" no choca con datos\: su ruta lógica
  // sólo sirve para calcular el nombre opaco.)
  if (logical.startsWith(METADATA_DIR + "/")) {
    throw new Error("Destino dentro de los metadatos del backup: " + relativeDest);
  }
  return { logical, relative: prefix + DATA_DIR + "/" + cifrado.opaqueName(masterKey, "archivo", logical) };
}

function dataPath(destKey, masterKey, sourceName, relativePath) {
  const name = cifrado.opaqueName(masterKey, "archivo", logicalPath(sourceName, relativePath));
  return path.join(backupRoot(destKey), DATA_DIR, ...name.split("/"));
}

// "KiopiaDesk_Backup/.kiopia-data/versions/<fecha>/Fotos/a.jpg" ->
// { stamp, logical: "Fotos/a.jpg", relative: ".../versions/<fecha>/xx/<hex>.kdc" }
const STAMP_RE = /^\w[\w.-]{0,63}$/;
function versionRelative(masterKey, relativeDest) {
  const rel = toSlash(relativeDest);
  const prefix = BACKUP_ROOT + "/" + METADATA_DIR + "/versions/";
  if (!rel.startsWith(prefix)) throw new Error("Destino fuera de las versiones: " + relativeDest);
  const rest = rel.slice(prefix.length);
  const cut = rest.indexOf("/");
  const stamp = cut > 0 ? rest.slice(0, cut) : "";
  const logical = cut > 0 ? rest.slice(cut + 1) : "";
  if (!STAMP_RE.test(stamp) || !logical) throw new Error("Versión no válida: " + relativeDest);
  return { stamp, logical, relative: prefix + stamp + "/" + cifrado.opaqueName(masterKey, "version", logical) };
}

function versionsIndexPath(destKey, stamp) {
  return path.join(metadataDir(destKey), "versions", stamp, "indice.kdc");
}

function manifestDir(destKey) {
  return path.join(metadataDir(destKey), "manifests");
}

function manifestPath(destKey, masterKey, sourceName) {
  const name = cifrado.opaqueName(masterKey, "manifiesto", safeName(sourceName)).replace("/", "");
  return path.join(manifestDir(destKey), name);
}

const prevPath = (fp) => fp.replace(/\.kdc$/, ".prev.kdc");

function sourcesPath(destKey) {
  return path.join(metadataDir(destKey), "fuentes.kdc");
}

function indexPath(destKey) {
  return path.join(metadataDir(destKey), "indice.kdc");
}

function logsDir(destKey) {
  return path.join(metadataDir(destKey), "logs");
}

// --- Archivos pequeños cifrados (JSON) -----------------------------------------------

function readEncryptedObject(masterKey, fp) {
  if (fs.statSync(fp).size > MAX_SMALL_FILE) throw new Error("demasiado grande (posible corrupción)");
  const data = cifrado.decryptJson(masterKey, fs.readFileSync(fp));
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("formato inválido");
  return data;
}

// Igual que readJsonWithFallback de core.js: "main", "fallback", "none" o "corrupt".
function readEncryptedWithFallback(masterKey, fp, fallbackFp) {
  if (!fs.existsSync(fp)) return { data: {}, source: "none" };
  try {
    return { data: readEncryptedObject(masterKey, fp), source: "main" };
  } catch (err) {
    if (fallbackFp && fs.existsSync(fallbackFp)) {
      try {
        return { data: readEncryptedObject(masterKey, fallbackFp), source: "fallback", error: err.message };
      } catch {
        // el respaldo también está dañado
      }
    }
    return { data: {}, source: "corrupt", error: err.message };
  }
}

function writeEncrypted(masterKey, fp, value) {
  atomicWriteFileSync(fp, cifrado.encryptJson(masterKey, value));
}

// --- Caja de claves -------------------------------------------------------------------

// Hay backup SIN cifrar en este disco: manifiestos .json o carpetas de origen.
// Activar el cifrado ahí mezclaría archivos en claro con cifrados.
function hasPlainBackup(destKey) {
  const root = backupRoot(destKey);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return false;
  }
  if (names.some((n) => ![METADATA_DIR, DATA_DIR, SCRIPT_NAME, LAUNCHER_NAME, README_NAME, PORTABLE_NAME].includes(n))) return true;
  try {
    return fs.readdirSync(manifestDir(destKey)).some((n) => n.endsWith(".json"));
  } catch {
    return false;
  }
}

function readVault(destKey) {
  let lastErr;
  for (const fp of [vaultPath(destKey), path.join(metadataDir(destKey), VAULT_COPY)]) {
    try {
      const vault = JSON.parse(fs.readFileSync(fp, "utf-8"));
      if (vault && vault.formato === cifrado.VAULT_FORMAT) return vault;
      lastErr = new Error("formato inválido");
    } catch (err) {
      lastErr = err;
    }
  }
  throw codedError("CRYPTO_NO_VAULT", "No se pudo leer la clave del backup cifrado (cifrado.json): " + (lastErr && lastErr.message));
}

function writeVault(destKey, vault) {
  const text = JSON.stringify(vault, null, 2);
  atomicWriteFileSync(vaultPath(destKey), text);
  atomicWriteFileSync(path.join(metadataDir(destKey), VAULT_COPY), text);
}

// Escribe `fp` de solo lectura (Windows avisa antes de borrarlo) y sólo si
// falta o cambió: la app lo llama cada vez que se elige el disco, así que un
// archivo borrado sin querer vuelve solo, y un disco viejo recibe la versión
// nueva, sin reescribir la USB cada vez. Devuelve true si lo escribió.
function writeProtectedFile(fp, data) {
  const want = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  let current = null;
  try {
    current = fs.readFileSync(fp);
  } catch {
    // no está
  }
  if (current && current.equals(want)) {
    try {
      if (fs.statSync(fp).mode & 0o200) fs.chmodSync(fp, 0o444);
    } catch {
      // disco de sólo lectura, etc.
    }
    return false;
  }
  // Un archivo de solo lectura no se puede reemplazar: se le quita antes.
  if (current) fs.chmodSync(fp, 0o666);
  atomicWriteFileSync(fp, want);
  fs.chmodSync(fp, 0o444);
  return true;
}

// Script de recuperación, su lanzador y el LEEME en la raíz del backup, de
// solo lectura. Devuelve cuántos tuvo que (re)escribir.
function writeRecoveryTools(destKey, scriptSource) {
  const root = backupRoot(destKey);
  let written = 0;
  if (scriptSource && fs.existsSync(scriptSource)) {
    if (writeProtectedFile(path.join(root, SCRIPT_NAME), fs.readFileSync(scriptSource))) written++;
  }
  if (writeProtectedFile(path.join(root, LAUNCHER_NAME), LAUNCHER_TEXT)) written++;
  if (writeProtectedFile(path.join(root, README_NAME), "\ufeff" + README_TEXT)) written++;
  return written;
}

// --- Kiopia Desk portable en el disco --------------------------------------------------
// Copia la versión portable de la app (un .exe que se abre sin instalar) a la
// raíz del backup, de solo lectura, si falta o es de otra versión (tamaño o
// fecha distintos). No la copia si no hay espacio de sobra. Devuelve
// { copied, reason?, size? }: reason = "no-disponible" | "es-esta" | "al-dia" |
// "sin-espacio" | "en-uso".
const PORTABLE_RESERVE = 64 * 1024 * 1024;

async function ensurePortableApp(destKey, source) {
  if (!source || !fs.existsSync(source)) return { copied: false, reason: "no-disponible" };
  const root = backupRoot(destKey);
  const target = path.join(root, PORTABLE_NAME);
  // La app ya se está ejecutando desde ese mismo archivo del disco.
  if (path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) return { copied: false, reason: "es-esta" };
  const src = fs.statSync(source);
  let dst = null;
  try {
    dst = fs.statSync(target);
  } catch {
    // no está
  }
  // FAT32 guarda la fecha con 2 s de resolución.
  if (dst && dst.size === src.size && Math.abs(dst.mtimeMs - src.mtimeMs) < 2000) {
    try {
      if (dst.mode & 0o200) fs.chmodSync(target, 0o444);
    } catch {
      // disco de sólo lectura
    }
    return { copied: false, reason: "al-dia" };
  }
  const st = await fs.promises.statfs(destKey);
  const free = Number(st.bavail) * Number(st.bsize);
  if (free < src.size - (dst ? dst.size : 0) + PORTABLE_RESERVE) return { copied: false, reason: "sin-espacio", size: src.size };

  fs.mkdirSync(root, { recursive: true });
  const tmp = tmpPathFor(target);
  try {
    fs.chmodSync(tmp, 0o666);
    fs.unlinkSync(tmp);
  } catch {
    // no quedaba ninguno
  }
  try {
    await fs.promises.copyFile(source, tmp);
    await fs.promises.utimes(tmp, src.atime, src.mtime);
    if (dst) fs.chmodSync(target, 0o666);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nada que limpiar
    }
    if (dst) {
      try {
        fs.chmodSync(target, 0o444);
      } catch {
        // sigue como estaba
      }
    }
    // Alguien la tiene abierta desde el disco: se deja la que hay.
    if (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES") return { copied: false, reason: "en-uso" };
    throw err;
  }
  fs.chmodSync(target, 0o444);
  return { copied: true, size: src.size };
}

function enableEncryption(destKey, password, { iterations, scriptSource } = {}) {
  if (isEncrypted(destKey)) throw codedError("CRYPTO_ALREADY", "Este disco ya tiene un backup cifrado.");
  if (hasPlainBackup(destKey)) {
    throw codedError("CRYPTO_PLAIN_BACKUP", "Este disco ya tiene un backup sin cifrar. Usá otro disco (o uno vacío) para el backup cifrado.");
  }
  const { vault, masterKey, recoveryKey } = cifrado.createVault(password, iterations ? { iterations } : undefined);
  fs.mkdirSync(path.join(backupRoot(destKey), DATA_DIR), { recursive: true });
  writeVault(destKey, vault);
  writeRecoveryTools(destKey, scriptSource);
  return { masterKey, recoveryKey };
}

// Clave maestra con la contraseña o la clave de recuperación; null si no vale.
function unlock(destKey, secret) {
  if (typeof secret !== "string" || !secret) return null;
  return cifrado.unlockVault(readVault(destKey), secret);
}

function changePassword(destKey, masterKey, newPassword, { iterations } = {}) {
  if (typeof newPassword !== "string" || !newPassword) throw new Error("Falta la contraseña nueva.");
  const vault = cifrado.rewrapWithPassword(readVault(destKey), masterKey, newPassword, iterations ? { iterations } : undefined);
  writeVault(destKey, vault);
}

// --- Manifiestos ----------------------------------------------------------------------

function loadManifest(destKey, masterKey, sourceName) {
  const fp = manifestPath(destKey, masterKey, sourceName);
  const result = readEncryptedWithFallback(masterKey, fp, prevPath(fp));
  const archivos = result.data.archivos;
  const manifest = archivos && typeof archivos === "object" && !Array.isArray(archivos) ? archivos : {};
  return { manifest, source: result.source };
}

function saveManifest(destKey, masterKey, sourceName, manifest) {
  const fp = manifestPath(destKey, masterKey, sourceName);
  // Sólo se rota a .prev un manifiesto que se pueda leer (igual que sin cifrar).
  if (fs.existsSync(fp)) {
    try {
      readEncryptedObject(masterKey, fp);
      atomicWriteFileSync(prevPath(fp), fs.readFileSync(fp));
    } catch {
      // dañado: no pisa el último .prev bueno
    }
  }
  writeEncrypted(masterKey, fp, { fuente: String(sourceName), carpeta: safeName(sourceName), archivos: manifest });
}

// Nombres de las carpetas respaldadas (lo que en un backup sin cifrar son los
// nombres de los manifiestos .json).
function listSources(destKey, masterKey) {
  let names;
  try {
    names = fs.readdirSync(manifestDir(destKey));
  } catch {
    return [];
  }
  const result = [];
  for (const n of names) {
    if (!n.endsWith(".kdc") || n.endsWith(".prev.kdc")) continue;
    const fp = path.join(manifestDir(destKey), n);
    const r = readEncryptedWithFallback(masterKey, fp, prevPath(fp));
    if (typeof r.data.fuente === "string" && r.data.fuente) result.push(r.data.fuente);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

// --- Otros metadatos ------------------------------------------------------------------

function loadSources(destKey, masterKey) {
  return readEncryptedWithFallback(masterKey, sourcesPath(destKey), null);
}

function saveSources(destKey, masterKey, map) {
  writeEncrypted(masterKey, sourcesPath(destKey), map);
}

function loadIndexData(destKey, masterKey) {
  return readEncryptedWithFallback(masterKey, indexPath(destKey), null).data;
}

function saveIndexData(destKey, masterKey, index) {
  writeEncrypted(masterKey, indexPath(destKey), index);
}

function saveLog(destKey, masterKey, report) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = require("crypto").randomBytes(4).toString("hex");
  const fp = path.join(logsDir(destKey), `${rand}_${stamp}.kdc`);
  writeEncrypted(masterKey, fp, report);
  return fp;
}

function logReader(masterKey) {
  return (fp) => readEncryptedObject(masterKey, fp);
}

// Recuerda qué ruta lógica corresponde a cada versión guardada (para que
// Recuperar-KiopiaDesk.ps1 pueda devolverle su nombre).
function recordVersions(destKey, masterKey, stamp, entries) {
  if (!entries.length) return;
  const fp = versionsIndexPath(destKey, stamp);
  const current = readEncryptedWithFallback(masterKey, fp, null).data;
  for (const e of entries) current[e.relative.split("/").slice(-2).join("/")] = e.logical;
  writeEncrypted(masterKey, fp, current);
}

module.exports = {
  METADATA_DIR,
  DATA_DIR,
  VAULT_FILE,
  SCRIPT_NAME,
  LAUNCHER_NAME,
  PORTABLE_NAME,
  ensurePortableApp,
  README_NAME,
  isEncrypted,
  hasPlainBackup,
  enableEncryption,
  unlock,
  changePassword,
  readVault,
  writeRecoveryTools,
  logicalPath,
  dataRelative,
  dataPath,
  versionRelative,
  manifestDir,
  manifestPath,
  loadManifest,
  saveManifest,
  listSources,
  loadSources,
  saveSources,
  loadIndexData,
  saveIndexData,
  saveLog,
  logReader,
  logsDir,
  recordVersions,
};
