"use strict";

// Lógica de escaneo, hashing, exclusiones y disco, separada de main.js para
// poder testearla con `node --test` sin levantar Electron.

// Dentro de Electron, el módulo "fs" trata los archivos .asar como carpetas
// virtuales: respaldar un .asar (p. ej. el de otra app Electron en la carpeta
// de origen) fallaba con "no existe". "original-fs" es el fs de Node sin ese
// parche; fuera de Electron (tests con node --test) no existe y se usa "fs".
const fs = (() => {
  try {
    return require("original-fs");
  } catch {
    return require("fs");
  }
})();
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// Sufijo de los temporales: toda escritura va primero a "<destino>.kopia-tmp"
// y después se renombra sobre el definitivo. Si algo se corta a mitad, lo
// único a medias es el temporal; la versión buena anterior sigue intacta.
const TMP_SUFFIX = ".kopia-tmp";

// FAT32 no admite archivos de 4 GiB o más (máximo 4 GiB - 1 byte).
const FAT32_MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024 - 1;

const DEFAULT_EXCLUDES = [
  "Thumbs.db",
  "desktop.ini",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".git",
  "node_modules",
  "*.tmp",
  "~$*",
];

// Carpeta donde main.js guarda todo lo del backup dentro del disco destino.
// Vive acá (no sólo en main.js) para que safeBackupPath pueda usarla.
const BACKUP_ROOT = "KopiaDesk_Backup";

// --- Rutas seguras --------------------------------------------------------

function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "carpeta";
}

function safePath(root, relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("Ruta no válida.");
  }
  if (relativePath.includes("\0")) {
    throw new Error("Ruta contiene caracteres nulos.");
  }
  const resolved = path.resolve(root, relativePath);
  let normalizedRoot = path.resolve(root);
  if (!normalizedRoot.endsWith(path.sep)) normalizedRoot += path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(root)) {
    throw new Error("Ruta fuera del disco destino.");
  }
  return resolved;
}

// safePath() por sí sola sólo protege que la ruta no se salga del DISCO
// destino: cuando "root" es la raíz del disco (p. ej. "D:\"), prácticamente
// cualquier ruta del disco la cumple, así que no evita escribir fuera de la
// carpeta de backup. safeBackupPath() agrega esa segunda validación: la ruta
// resuelta tiene que quedar dentro de "<root>/KopiaDesk_Backup/".
function safeBackupPath(root, relativePath) {
  const resolved = safePath(root, relativePath);
  const backupRoot = path.resolve(root, BACKUP_ROOT);
  let normalizedBackupRoot = backupRoot;
  if (!normalizedBackupRoot.endsWith(path.sep)) normalizedBackupRoot += path.sep;
  if (!resolved.startsWith(normalizedBackupRoot) && resolved !== backupRoot) {
    throw new Error("Ruta fuera de la carpeta de backup.");
  }
  return resolved;
}

// ¿`child` está dentro de `parent` (o es el mismo)? Sin distinguir mayúsculas,
// como el sistema de archivos de Windows. Se usa para validar en el proceso
// principal las rutas que llegan desde el renderer.
function isInside(parent, child) {
  if (typeof parent !== "string" || typeof child !== "string" || !parent || !child) return false;
  if (parent.includes("\0") || child.includes("\0")) return false;
  const p = path.resolve(parent).toLowerCase();
  const c = path.resolve(child).toLowerCase();
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// --- Escrituras atómicas ----------------------------------------------------

function tmpPathFor(target) {
  return target + TMP_SUFFIX;
}

function isRetryableRenameError(err) {
  // En Windows, un antivirus o el indexador pueden tener el destino abierto
  // un instante y el rename falla con EPERM/EBUSY/EACCES: se reintenta.
  return err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
}

async function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      if (i >= attempts - 1 || !isRetryableRenameError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
    }
  }
}

function renameSyncWithRetry(from, to, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= attempts - 1 || !isRetryableRenameError(err)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1));
    }
  }
}

// Escribe a "<archivo>.kopia-tmp", hace fsync y renombra sobre el definitivo.
// Un corte a mitad deja el archivo anterior completo en vez de un JSON truncado.
function atomicWriteFileSync(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = tmpPathFor(fp);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data, typeof data === "string" ? "utf-8" : undefined);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameSyncWithRetry(tmp, fp);
}

function readJsonObject(fp) {
  const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("formato inválido");
  }
  return data;
}

// Lee un JSON objeto. Si el principal está dañado, intenta con `fallbackFp`
// (p. ej. el .prev.json del manifiesto). `source` indica de dónde salió:
// "main", "fallback", "none" (no existe) o "corrupt" (ninguno se pudo leer).
function readJsonWithFallback(fp, fallbackFp) {
  if (!fs.existsSync(fp)) return { data: {}, source: "none" };
  try {
    return { data: readJsonObject(fp), source: "main" };
  } catch (err) {
    if (fallbackFp && fs.existsSync(fallbackFp)) {
      try {
        return { data: readJsonObject(fallbackFp), source: "fallback", error: err.message };
      } catch {
        // el respaldo también está dañado
      }
    }
    return { data: {}, source: "corrupt", error: err.message };
  }
}

// --- Filtros de exclusión --------------------------------------------------

function compileExcludePatterns(patterns) {
  return patterns
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => {
      const escaped = p
        .trim()
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      const re = new RegExp("^" + escaped + "$", "i");
      re.rule = p.trim(); // el patrón tal cual, para decir por qué se excluyó algo
      return re;
    });
}

function isExcluded(name, compiledPatterns) {
  return compiledPatterns.some((re) => re.test(name));
}

// Regla que excluye este nombre (el patrón escrito), o null.
function excludeRuleFor(name, compiledPatterns) {
  const re = compiledPatterns.find((r) => r.test(name));
  return re ? re.rule || re.source : null;
}

// Carpetas o archivos concretos que el usuario excluyó (rutas completas),
// pasados a rutas relativas a la carpeta que se escanea, en minúsculas (en
// Windows no se distinguen) y con "/" como en las claves del escaneo. Las que
// no están dentro de esa carpeta se ignoran.
function excludedRelativePaths(rootDir, excludedPaths) {
  const out = new Set();
  const root = path.resolve(rootDir);
  for (const p of Array.isArray(excludedPaths) ? excludedPaths : []) {
    if (typeof p !== "string" || !p.trim()) continue;
    const rel = path.relative(root, path.resolve(p));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    out.add(rel.split(path.sep).join("/").toLowerCase());
  }
  return out;
}

// Patrones por nombre + rutas concretas, listo para scanDirectoryRecursive.
function compileExcludes(rootDir, patterns, excludedPaths) {
  const compiled = compileExcludePatterns(patterns);
  compiled.paths = excludedRelativePaths(rootDir, excludedPaths);
  return compiled;
}

// --- Escaneo recursivo -------------------------------------------------------

// E/S asíncrona (fs.promises) en vez de fs.readdirSync/statSync, para no
// bloquear el hilo del proceso principal de Electron (y con él, la ventana
// entera) mientras se escanean carpetas con muchos archivos o subcarpetas.
//
// `report` (opcional) acumula lo que quedó fuera para informarlo al usuario:
// { excluded: número, skipped: [{ path, reason }] }. `reason` es "enlace"
// (junction/enlace simbólico, no se sigue para evitar bucles), "sin-permiso"
// o "ilegible".
const MAX_SKIPPED_REPORTED = 5000;
// Regla de lo que el usuario eligió con "Excluir carpeta/archivo".
const EXCLUDED_BY_USER = "elegido en Excluir";

function createScanReport() {
  return { excluded: 0, skipped: [], excludedItems: [] };
}

function reportSkipped(report, relativePath, reason) {
  if (report && report.skipped.length < MAX_SKIPPED_REPORTED) {
    report.skipped.push({ path: relativePath || ".", reason });
  }
}

async function scanDirectoryRecursive(dirPath, basePath, compiledExcludes, report = null) {
  const files = {};
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    // EPERM es lo que Windows suele devolver ante carpetas protegidas (EACCES
    // casi no aparece); ENOENT cubre carpetas borradas a mitad del escaneo.
    if (err.code === "EACCES" || err.code === "EPERM") {
      reportSkipped(report, basePath, "sin-permiso");
      return files;
    }
    if (err.code === "ENOENT") return files;
    throw err;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const relativePath = basePath ? basePath + "/" + entry.name : entry.name;
      const rule =
        excludeRuleFor(entry.name, compiledExcludes) ||
        (compiledExcludes.paths && compiledExcludes.paths.has(relativePath.toLowerCase()) ? EXCLUDED_BY_USER : null);
      if (rule) {
        if (report) {
          report.excluded++;
          // Qué quedó fuera y por qué regla, para mostrarlo en los resultados.
          if (report.excludedItems && report.excludedItems.length < MAX_SKIPPED_REPORTED) {
            report.excludedItems.push({ path: relativePath, rule, folder: entry.isDirectory() });
          }
        }
        return;
      }
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isSymbolicLink()) {
        reportSkipped(report, relativePath, "enlace");
      } else if (entry.isDirectory()) {
        const nested = await scanDirectoryRecursive(fullPath, relativePath, compiledExcludes, report);
        Object.assign(files, nested);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          files[relativePath] = {
            name: entry.name,
            path: relativePath,
            fullPath,
            size: stat.size,
            lastModified: stat.mtimeMs,
            hash: null,
          };
        } catch {
          reportSkipped(report, relativePath, "ilegible");
        }
      }
    })
  );

  return files;
}

// --- Hashing -------------------------------------------------------------

// Bloques de 1 MB en vez de los 64 KB por defecto: con archivos grandes, releer
// para verificar va bastante más rápido (menos viajes al hilo de E/S).
const HASH_READ_CHUNK = 1024 * 1024;

function hashFileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: HASH_READ_CHUNK });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// Hash "rápido": sólo lee los primeros y últimos 64 KB en vez del archivo
// completo. E/S asíncrona para no bloquear el proceso principal de Electron
// cuando hay muchos archivos cambiados en un mismo escaneo.
async function quickHashFile(fullPath, size) {
  const CHUNK = 65536;
  const fh = await fs.promises.open(fullPath, "r");
  try {
    const hash = crypto.createHash("sha256");
    hash.update(String(size));
    if (size > 0) {
      const headBuf = Buffer.alloc(Math.min(CHUNK, size));
      const { bytesRead: headBytes } = await fh.read(headBuf, 0, headBuf.length, 0);
      hash.update(headBuf.subarray(0, headBytes));

      if (size > CHUNK) {
        const tailSize = Math.min(CHUNK, size);
        const tailBuf = Buffer.alloc(tailSize);
        const { bytesRead: tailBytes } = await fh.read(tailBuf, 0, tailSize, size - tailSize);
        hash.update(tailBuf.subarray(0, tailBytes));
      }
    }
    return hash.digest("hex");
  } finally {
    await fh.close();
  }
}

// --- Copia segura (temporal + verificación + rename) ------------------------

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Errores que suelen durar milisegundos (antivirus, indexador de búsqueda u
// OneDrive con el archivo abierto; una lectura puntual defectuosa) y que vale
// la pena reintentar. Los demás (sin permiso, no existe, disco lleno...) no se
// arreglan esperando y fallan al primer intento.
const TRANSIENT_COPY_ERRORS = new Set(["EBUSY", "EAGAIN", "ETXTBSY", "VERIFY_FAILED"]);
const COPY_RETRIES = 3;
const COPY_RETRY_DELAY_MS = 80;

// Una copia completa: temporal, fsync, SHA-256 del origen y del temporal,
// comprobación de que el origen no cambió, fechas y rename. Si algo falla,
// sólo se borra el temporal: el destino anterior no se toca nunca.
// Margen para dar por conservada la fecha que copió Windows: exFAT guarda la
// fecha con 10 ms de precisión y FAT32 con 2 s.
const MTIME_TOLERANCE_MS = 2000;

// Copia en una sola lectura del origen: lee en bloques de 8 MB, calcula el
// SHA-256 de lo leído y escribe el bloque mientras lee el siguiente. Así el
// origen no se vuelve a leer entero para calcular su hash (al restaurar, el
// origen es la USB: medido, releerla costaba ~35 % del tiempo). Deja el
// temporal con la fecha del origen y forzado a disco. Devuelve el hash del
// origen tal como se leyó.
const COPY_CHUNK = 8 * 1024 * 1024;

// Un temporal que sobró de un intento anterior NUNCA se reescribe en el sitio:
// puede ser un hardlink (lo crea linkAtomic y puede quedar tras un corte) y
// escribir dentro cambiaría también el otro archivo del backup al que apunta.
// Se crea en modo exclusivo ("sólo si no existe"): lo normal no cuesta nada de
// más, y si existe se borra (rompiendo el enlace) antes de volver a crearlo.
// Si no se puede borrar, se falla en vez de escribir encima.
async function removeLeftoverTmp(tmp) {
  await fs.promises.chmod(tmp, 0o666).catch(() => {}); // por si quedó de sólo lectura
  await fs.promises.unlink(tmp);
}

async function openTmpForWrite(tmp) {
  try {
    return await fs.promises.open(tmp, "wx");
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    await removeLeftoverTmp(tmp);
    return fs.promises.open(tmp, "wx");
  }
}

async function writeAll(fh, buf, position) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, position + off);
    off += bytesWritten;
  }
}

async function copyToTmpHashing(srcPath, tmp, before) {
  const hash = crypto.createHash("sha256");
  const src = await fs.promises.open(srcPath, "r");
  try {
    const out = await openTmpForWrite(tmp);
    try {
      const size = Math.max(1, Math.min(COPY_CHUNK, before.size));
      const bufs = [Buffer.allocUnsafe(size), Buffer.allocUnsafe(size)];
      let pending = Promise.resolve();
      let pos = 0;
      for (let i = 0; ; i ^= 1) {
        // Se lee en un buffer mientras el otro todavía se está escribiendo.
        const { bytesRead } = await src.read(bufs[i], 0, size, pos);
        await pending;
        if (bytesRead === 0) break;
        const chunk = bufs[i].subarray(0, bytesRead);
        hash.update(chunk);
        pending = writeAll(out, chunk, pos);
        pos += bytesRead;
      }
      await pending;
      await out.utimes(before.atime, before.mtime);
      await out.sync();
    } finally {
      await out.close();
    }
  } finally {
    await src.close();
  }
  return hash.digest("hex");
}

// Dos formas de copiar, según de dónde se lee:
//   - "native" (backup): CopyFileW de Windows. Respeta que otro programa tenga
//     el archivo abierto en exclusiva (Outlook con su .pst, una base de datos):
//     falla con EBUSY y se reintenta, en vez de copiar un archivo a medio
//     escribir. La lectura propia de Node, en cambio, sí puede leerlo (medido),
//     así que para los archivos del usuario no se usa.
//   - "single" (restaurar): una sola lectura del origen. El origen son los
//     archivos del propio backup, que nadie tiene abiertos, y es donde releer
//     la USB para el hash costaba ~35 % del tiempo.
async function copyOnceVerified(srcPath, target, tmp, mode = "native") {
  return mode === "single" ? copyOnceSinglePass(srcPath, target, tmp) : copyOnceNative(srcPath, target, tmp);
}

async function copyOnceSinglePass(srcPath, target, tmp) {
  const before = await fs.promises.stat(srcPath);
  try {
    const srcHash = await copyToTmpHashing(srcPath, tmp, before);
    // Verificación: se relee lo escrito y se compara con lo que se leyó del origen.
    const writtenHash = await hashFileAsync(tmp);
    const after = await fs.promises.stat(srcPath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw codedError("SOURCE_CHANGED", "El archivo cambió mientras se copiaba; se reintentará en el próximo backup.");
    }
    if (writtenHash !== srcHash) {
      throw codedError("VERIFY_FAILED", "La copia no coincide con el original (¿disco defectuoso o desconectado?).");
    }
    await renameWithRetry(tmp, target);
    return { hash: srcHash, size: before.size, mtimeMs: before.mtimeMs };
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function copyOnceNative(srcPath, target, tmp) {
  const before = await fs.promises.stat(srcPath);
  try {
    // Temporal en modo exclusivo: ver removeLeftoverTmp (un temporal sobrante
    // puede ser un hardlink y nunca se reescribe en el sitio).
    try {
      await fs.promises.copyFile(srcPath, tmp, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await removeLeftoverTmp(tmp);
      await fs.promises.copyFile(srcPath, tmp, fs.constants.COPYFILE_EXCL);
    }
    // CopyFileW copia también los atributos: un origen de sólo lectura dejaría
    // un temporal que no se puede abrir para escribir, renombrar encima ni
    // borrar. Sólo en ese caso hace falta quitarlo.
    if (!(before.mode & 0o200)) await fs.promises.chmod(tmp, 0o666);
    const fh = await fs.promises.open(tmp, "r+");
    try {
      // CopyFileW ya conserva la fecha de modificación; sólo se corrige (sobre
      // el archivo abierto, sin buscarlo otra vez por la ruta) si no quedó igual.
      const written = await fh.stat();
      if (Math.abs(written.mtimeMs - before.mtimeMs) > MTIME_TOLERANCE_MS) {
        await fh.utimes(before.atime, before.mtime);
      }
      await fh.sync();
    } finally {
      await fh.close();
    }

    const [srcHash, writtenHash] = await Promise.all([hashFileAsync(srcPath), hashFileAsync(tmp)]);
    const after = await fs.promises.stat(srcPath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw codedError("SOURCE_CHANGED", "El archivo cambió mientras se copiaba; se reintentará en el próximo backup.");
    }
    if (writtenHash !== srcHash) {
      throw codedError("VERIFY_FAILED", "La copia no coincide con el original (¿disco defectuoso o desconectado?).");
    }

    await renameWithRetry(tmp, target);
    return { hash: srcHash, size: before.size, mtimeMs: before.mtimeMs };
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

// Copia `srcPath` a `target` de forma atómica y verificada:
//   1. copia a "<target>.kopia-tmp" con la copia nativa del sistema (CopyFileW,
//      mucho más rápida en USB que un stream con bloques de 64 KB) y hace fsync;
//   2. calcula en paralelo el SHA-256 del origen y el del temporal escrito;
//   3. comprueba que el origen no cambió durante todo eso (tamaño/fecha);
//   4. conserva la fecha de modificación y renombra sobre el destino.
// Ante un bloqueo pasajero reintenta toda la copia (hasta `retries` veces, con
// espera creciente), siempre sobre el temporal: mientras tanto, y si al final
// falla, el archivo que ya estaba en el destino sigue intacto.
// El rename reemplaza la entrada de directorio: si `target` era un hardlink
// compartido, los otros enlaces conservan su contenido (no se escribe dentro
// del archivo existente).
async function copyFileVerified(srcPath, target, options = {}) {
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : COPY_RETRIES;
  const delayMs = Number.isInteger(options.delayMs) && options.delayMs >= 0 ? options.delayMs : COPY_RETRY_DELAY_MS;
  const mode = options.mode === "single" ? "single" : "native";
  const tmp = tmpPathFor(target);
  for (let attempt = 0; ; attempt++) {
    try {
      return await copyOnceVerified(srcPath, target, tmp, mode);
    } catch (err) {
      if (attempt >= retries || !TRANSIENT_COPY_ERRORS.has(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
    }
  }
}

// Restaura un archivo del backup verificando ADEMÁS que coincida con el hash
// que quedó registrado en el manifiesto cuando se respaldó. copyFileVerified
// por sí sola sólo garantiza que la copia coincide con el archivo QUE HAY
// ahora en el backup: si ese archivo se corrompió en el disco después de
// guardarse (bit rot, sector dañado), copyFileVerified no lo nota (copia una
// versión ya mala, pero de forma "consistente"). Sin este chequeo, una
// restauración de un archivo corrupto "tenía éxito" en silencio. Si no
// coincide, no se deja en destino: mejor un error visible que una
// restauración incorrecta sin avisar.
async function restoreFileVerified(backupFullPath, dest, expectedHash) {
  // Una sola lectura del origen (la USB): ver copyOnceVerified.
  const result = await copyFileVerified(backupFullPath, dest, { mode: "single" });
  if (expectedHash && result.hash !== expectedHash) {
    await fs.promises.unlink(dest).catch(() => {});
    throw codedError(
      "BACKUP_CORRUPTED",
      "El archivo del backup no coincide con el hash del manifiesto (posible corrupción del disco de backup)."
    );
  }
  return result;
}

// Crea `target` como hardlink de `existingAbsolute`, también vía temporal +
// rename para no dejar el destino borrado si el enlace falla a mitad.
async function linkAtomic(existingAbsolute, target) {
  const tmp = tmpPathFor(target);
  await fs.promises.unlink(tmp).catch(() => {});
  try {
    await fs.promises.link(existingAbsolute, tmp);
  } catch {
    return false; // p. ej. FAT/exFAT o límite de 1023 enlaces: se copia normal
  }
  try {
    await renameWithRetry(tmp, target);
    return true;
  } catch {
    await fs.promises.unlink(tmp).catch(() => {});
    return false;
  }
}

// Guarda la versión ANTERIOR de un archivo cambiado, comprimida: mismo patrón
// que copyFileVerified (temporal en la misma carpeta + rename), pero con gzip
// en vez de una copia byte a byte. Vive acá (y no en main.js) para que
// main.js pueda planificarla en el journal igual que copyOneTask.
async function writeVersionAtomic(srcPath, destPath) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = tmpPathFor(destPath);
  try {
    await pipeline(fs.createReadStream(srcPath), zlib.createGzip(), fs.createWriteStream(tmp));
    await fs.promises.rename(tmp, destPath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

// --- Índice de contenido para deduplicación ---------------------------------

// hash -> { path, size } (ruta relativa al disco destino). Mantiene también el
// índice inverso ruta -> hashes, para poder olvidar todo hash que apuntaba a
// una ruta cuando esa ruta se sobrescribe (si no, un hash viejo seguiría
// apuntando a un archivo que ya tiene otro contenido).
class ContentIndex {
  constructor(obj = {}) {
    this.byHash = new Map();
    this.hashesByPath = new Map();
    for (const [hash, value] of Object.entries(obj || {})) {
      // Formato legado: hash -> "ruta" (sin tamaño).
      const entry = typeof value === "string" ? { path: value } : value;
      if (entry && typeof entry.path === "string") this._put(hash, entry);
    }
  }

  static pathKey(relativePath) {
    return path.normalize(relativePath).toLowerCase();
  }

  _put(hash, entry) {
    this.byHash.set(hash, entry);
    const key = ContentIndex.pathKey(entry.path);
    if (!this.hashesByPath.has(key)) this.hashesByPath.set(key, new Set());
    this.hashesByPath.get(key).add(hash);
  }

  get size() {
    return this.byHash.size;
  }

  get(hash) {
    return this.byHash.get(hash) || null;
  }

  delete(hash) {
    const entry = this.byHash.get(hash);
    if (!entry) return;
    this.byHash.delete(hash);
    const key = ContentIndex.pathKey(entry.path);
    const set = this.hashesByPath.get(key);
    if (set) {
      set.delete(hash);
      if (!set.size) this.hashesByPath.delete(key);
    }
  }

  // Llamar SIEMPRE que se escribe (copia o enlace) sobre una ruta del backup.
  forgetPath(relativePath) {
    const set = this.hashesByPath.get(ContentIndex.pathKey(relativePath));
    if (!set) return;
    for (const hash of [...set]) this.delete(hash);
  }

  // Registra que `entry.path` contiene ahora el contenido `hash`.
  record(hash, entry) {
    this.forgetPath(entry.path);
    if (!this.byHash.has(hash)) this._put(hash, entry);
  }

  toJSON() {
    return Object.fromEntries(this.byHash);
  }
}

// Antes de enlazar se confirma que el archivo indexado sigue teniendo ese
// contenido: tamaño primero (barato) y SHA-256 completo después. Si el backup
// se tocó a mano o el índice quedó viejo, se copia en vez de enlazar mal.
async function indexEntryMatches(destRoot, entry, expectedHash) {
  let absolute;
  try {
    absolute = safeBackupPath(destRoot, entry.path);
  } catch {
    return false;
  }
  let stat;
  try {
    stat = await fs.promises.stat(absolute);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (typeof entry.size === "number" && stat.size !== entry.size) return false;
  try {
    return (await hashFileAsync(absolute)) === expectedHash;
  } catch {
    return false;
  }
}

// Copia una tarea de backup. `ctx`:
//   index:        ContentIndex (o null) — se mantiene al día en toda escritura.
//   pendingWrites: Map hash -> Promise<ruta|null> para dedup dentro del lote.
//   maxFileSize:  límite del sistema de archivos destino (FAT32), opcional.
// `task.dedup` decide si se intenta enlazar en vez de copiar.
// Devuelve { dedup, hash }.
// Ejecuta `worker` sobre `items` con `concurrency` a la vez. Con `adaptive`,
// antes prueba: `probeSize` elementos de 1 en 1 y otros tantos de 2 en 2, y
// sigue con lo que haya ido más rápido. Hace falta medirlo porque depende de la
// USB: con 2.000 archivos pequeños, una (exFAT) fue un 16 % más rápida con 2 a
// la vez y otra (NTFS) un 34 % más lenta. `worker` no debe rechazar (cada tarea
// maneja sus errores). Devuelve la concurrencia usada y la medición.
// Con `shouldStop` (botón Detener) deja de empezar tareas nuevas; las que ya
// estaban en marcha terminan igual (una copia a medias no se corta) y se
// devuelve stopped: true.
const ADAPTIVE_PROBE_SIZE = 100;
// Para cambiar a 2 a la vez tiene que ser claramente mejor (no por ruido).
const ADAPTIVE_MIN_GAIN = 0.9;

async function runTasks(
  items,
  worker,
  { concurrency = 1, adaptive = false, probeSize = ADAPTIVE_PROBE_SIZE, now = Date.now, shouldStop = null } = {}
) {
  let stopped = false;
  const runSlice = async (slice, n) => {
    const inFlight = new Set();
    for (const item of slice) {
      if (shouldStop && shouldStop()) {
        stopped = true;
        break;
      }
      const p = Promise.resolve().then(() => worker(item));
      inFlight.add(p);
      p.finally(() => inFlight.delete(p));
      if (inFlight.size >= n) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
  };
  if (!adaptive || items.length < probeSize * 3) {
    await runSlice(items, concurrency);
    return { concurrency, probe: null, stopped };
  }
  const t0 = now();
  await runSlice(items.slice(0, probeSize), 1);
  const t1 = now();
  if (!stopped) await runSlice(items.slice(probeSize, probeSize * 2), 2);
  const t2 = now();
  const probe = { msDe1en1: t1 - t0, msDe2en2: t2 - t1 };
  const chosen = t2 - t1 < (t1 - t0) * ADAPTIVE_MIN_GAIN ? 2 : 1;
  if (!stopped) await runSlice(items.slice(probeSize * 2), chosen);
  return { concurrency: chosen, probe, stopped };
}

// Restaurar muchos archivos pequeños va mucho más rápido con varios a la vez
// (medido: 4 a la vez superó a Windows en las dos USB de prueba; de 1 en 1
// iba a menos de la mitad). Con archivos grandes, de a uno: la USB lee mejor
// en secuencia.
function pickRestoreConcurrency(avgFileSize) {
  return avgFileSize > 0 && avgFileSize < 2 * 1024 * 1024 ? 4 : 1;
}

// Crea la carpeta una sola vez por lote: con muchos archivos en las mismas
// carpetas, repetir mkdir por archivo son miles de operaciones en la USB.
async function ensureDir(dir, madeDirs) {
  const key = dir.toLowerCase();
  if (madeDirs && madeDirs.has(key)) return;
  await fs.promises.mkdir(dir, { recursive: true });
  if (madeDirs) madeDirs.add(key);
}

async function copyOneTask(task, ctx = {}) {
  const target = safeBackupPath(task.destRoot, task.relativeDest);
  const relative = path.relative(task.destRoot, target);
  const index = ctx.index || null;
  await ensureDir(path.dirname(target), ctx.madeDirs);

  if (ctx.maxFileSize) {
    const stat = await fs.promises.stat(task.srcPath);
    if (stat.size > ctx.maxFileSize) {
      throw codedError("FILE_TOO_LARGE", "Archivo de 4 GB o más: no entra en un disco FAT32.");
    }
  }

  let contentHash = null;
  let resolvePending = null;
  if (task.dedup && index) {
    contentHash = await hashFileAsync(task.srcPath);

    const existing = index.get(contentHash);
    if (existing) {
      if (await indexEntryMatches(task.destRoot, existing, contentHash)) {
        if (ContentIndex.pathKey(existing.path) === ContentIndex.pathKey(relative)) {
          // El backup ya tiene exactamente este contenido en esta ruta.
          return { dedup: true, hash: contentHash };
        }
        if (await linkAtomic(path.join(task.destRoot, existing.path), target)) {
          index.forgetPath(relative);
          return { dedup: true, hash: contentHash };
        }
      } else {
        index.delete(contentHash); // entrada obsoleta: ya no hay ese contenido ahí
      }
    }

    // Sección crítica síncrona (sin await entre get/set): si dos tareas de este
    // mismo lote comparten contenido, sólo la primera copia de verdad; la(s)
    // siguiente(s) esperan su resultado y enlazan, en vez de copiar ambas a la vez.
    const pending = ctx.pendingWrites && ctx.pendingWrites.get(contentHash);
    if (pending) {
      const firstRelative = await pending;
      if (firstRelative && (await linkAtomic(path.join(task.destRoot, firstRelative), target))) {
        index.forgetPath(relative);
        return { dedup: true, hash: contentHash };
      }
    } else if (ctx.pendingWrites) {
      let resolveFirst;
      ctx.pendingWrites.set(contentHash, new Promise((resolve) => (resolveFirst = resolve)));
      resolvePending = resolveFirst;
    }
  }

  let result;
  try {
    result = await copyFileVerified(task.srcPath, target);
  } catch (err) {
    // Si la copia "titular" falla, se libera a quienes esperaban enlazarse a
    // ella (null = "no hay nada que enlazar"), para que copien por su cuenta
    // en vez de quedarse esperando una promesa que nunca se resolvería.
    if (resolvePending) resolvePending(null);
    throw err;
  }

  if (index) index.record(result.hash, { path: relative, size: result.size });
  // Si el archivo cambió entre el hash previo y la copia, el contenido ya no es
  // el que esperan los demás: que copien por su cuenta.
  if (resolvePending) resolvePending(result.hash === contentHash ? relative : null);
  return { dedup: false, hash: result.hash };
}

// --- Discos y concurrencia adaptativa --------------------------------------

// Además de cada volumen, averigua en qué disco FÍSICO está y si ese disco es
// el del sistema (donde arranca Windows: IsBoot/IsSystem, o el que contiene la
// unidad de Windows). Todas las particiones de ese disco (C:, arranque EFI,
// recuperación...) quedan protegidas: cifrar o bloquear cualquiera de ellas
// puede dejar el equipo sin arrancar.
const LIST_DRIVES_SCRIPT =
  "$sysLetter = ([string](Get-CimInstance Win32_OperatingSystem).SystemDrive).TrimEnd(':'); " +
  "$sysDisks = @(Get-Disk | Where-Object { $_.IsBoot -or $_.IsSystem } | ForEach-Object { [int]$_.Number }); " +
  "$diskOf = @{}; Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object { $diskOf[[string]$_.DriveLetter] = [int]$_.DiskNumber }; " +
  "if ($diskOf.ContainsKey($sysLetter)) { $sysDisks += $diskOf[$sysLetter] }; " +
  "Get-Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter, FileSystemLabel, SizeRemaining, Size, UniqueId, " +
  "@{ n = 'FS'; e = { if ($_.FileSystem) { [string]$_.FileSystem } else { [string]$_.FileSystemType } } }, " +
  "@{ n = 'Disk'; e = { $diskOf[[string]$_.DriveLetter] } }, " +
  "@{ n = 'SysDisk'; e = { $d = $diskOf[[string]$_.DriveLetter]; if ($null -eq $d) { $null } else { $sysDisks -contains $d } } }, " +
  "@{ n = 'SysLetter'; e = { $sysLetter } } | ConvertTo-Json -Compress";

function mapVolume(v, fallbackSystemLetter) {
  const systemLetter = String(v.SysLetter || fallbackSystemLetter || "C").replace(/:$/, "").toUpperCase();
  return {
    root: v.DriveLetter + ":\\",
    label: v.FileSystemLabel || "",
    free: v.SizeRemaining || 0,
    total: v.Size || 0,
    fileSystem: v.FS || "",
    isSystemDrive: String(v.DriveLetter).toUpperCase() === systemLetter,
    diskNumber: Number.isInteger(v.Disk) ? v.Disk : null,
    // true: disco del sistema; false: otro disco; null: no se pudo saber.
    onSystemDisk: typeof v.SysDisk === "boolean" ? v.SysDisk : null,
    // Identidad del volumen (no cambia al cambiar la letra; distinta para cada
    // disco): se usa para comprobar que la letra sigue siendo el mismo disco.
    volumeId: isValidVolumeId(v.UniqueId) ? v.UniqueId : null,
  };
}

// Formato de Get-Volume UniqueId: \\?\Volume{GUID}\
const VOLUME_ID_RE = /^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\$/i;

function isValidVolumeId(id) {
  return typeof id === "string" && VOLUME_ID_RE.test(id);
}

// Misma idea que checkBitLockerTarget, pero para backups normales (no hace
// falta la protección de disco de sistema, sólo saber si es el mismo disco):
// ¿la letra sigue apuntando al mismo volumen elegido? `drives` es una lista
// recién leída. Devuelve:
//   - false: sin `expectedVolumeId` no hay nada que comparar (compatibilidad
//     con llamadas viejas), o el volumen sigue siendo el mismo.
//   - true: es OTRO volumen (se cambió el disco).
//   - null: no se pudo confirmar (p. ej. un hipo leyendo la lista de discos).
//     A propósito NO cuenta como "cambió": abortar un backup bueno por no
//     poder confirmar algo sería peor que el riesgo que se quiere evitar.
function driveIdentityChanged(drives, letter, expectedVolumeId) {
  if (!expectedVolumeId) return false;
  const L = String(letter || "").toUpperCase();
  const drive = (drives || []).find((d) => d.root && d.root[0].toUpperCase() === L);
  if (!drive || !drive.volumeId) return null;
  return drive.volumeId.toLowerCase() !== expectedVolumeId.toLowerCase();
}

// Antes de cifrar o bloquear: la letra tiene que seguir apuntando al MISMO
// volumen que el usuario eligió, y ese volumen no puede ser del disco del
// sistema. `drives` es una lista recién leída (no la de la pantalla). Devuelve
// { ok: true, drive } o { ok: false, code, error }.
function checkBitLockerTarget(drives, letter, expectedVolumeId) {
  const L = String(letter || "").toUpperCase();
  const drive = (drives || []).find((d) => d.root && d.root[0].toUpperCase() === L);
  if (!drive) {
    return { ok: false, code: "missing", error: `El disco ${L}: ya no está conectado.` };
  }
  if (!isValidVolumeId(expectedVolumeId) || !drive.volumeId || drive.volumeId.toLowerCase() !== expectedVolumeId.toLowerCase()) {
    return {
      ok: false,
      code: "changed",
      error: `El disco ${L}: cambió desde que lo elegiste (se desconectó o se conectó otro con la misma letra). Vuelve a elegirlo.`,
    };
  }
  if (isProtectedSystemVolume(drive)) {
    return {
      ok: false,
      code: "system-disk",
      error:
        drive.onSystemDisk === null && !drive.isSystemDrive
          ? `No se pudo confirmar que ${L}: no esté en el disco del sistema; por seguridad no se cifra ni se bloquea.`
          : `${L}: está en el disco del sistema (donde está instalado Windows). Kopia Desk no cifra ni bloquea ese disco.`,
    };
  }
  return { ok: true, drive };
}

// ¿Está prohibido cifrar o bloquear este volumen? Sí si es la unidad de
// Windows, si está en el disco del sistema, o si no se pudo confirmar en qué
// disco está (ante la duda, no se toca).
function isProtectedSystemVolume(drive) {
  if (!drive) return true;
  return drive.isSystemDrive === true || drive.onSystemDisk !== false;
}

// --- PowerShell que queda abierto para las consultas ------------------------------
// Cada consulta de discos lanzaba un PowerShell nuevo, y la primera consulta de
// almacenamiento de cada PowerShell carga módulos de Windows (medido: ~1,45 s;
// en uno ya abierto, ~0,25 s). Este proceso queda abierto mientras la app lo
// está y ejecuta, de a una, las consultas FIJAS de este archivo (listar discos,
// tipo de disco, estado de cifrado), cuyos únicos datos variables son letras de
// unidad ya validadas. Si falla o tarda demasiado, se cierra y la consulta se
// hace como antes, lanzando un PowerShell para ella sola.
//
// Protocolo: por la entrada, "<id> <script en base64 UTF-8>"; por la salida, lo
// que devuelve el script y una línea "KD-FIN-<id>" (o "KD-ERR:<mensaje>").
const PS_WORKER_LOOP =
  "$ErrorActionPreference='Continue'; " +
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; " +
  "while ($true) { " +
  "$l = [Console]::In.ReadLine(); if ($null -eq $l) { break }; " +
  "$p = $l.Split(' ', 2); " +
  "try { $c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1])); " +
  "$r = & ([ScriptBlock]::Create($c)) | Out-String -Width 100000; [Console]::Out.Write($r) } " +
  "catch { [Console]::Out.Write('KD-ERR:' + ($_.Exception.Message -replace '[\\r\\n]+', ' ')) }; " +
  "[Console]::Out.WriteLine(); [Console]::Out.WriteLine('KD-FIN-' + $p[0]); [Console]::Out.Flush() }";

const psWorker = { child: null, buffer: "", nextId: 1, queue: Promise.resolve(), current: null };

function startPowerShellWorker() {
  if (psWorker.child || process.platform !== "win32") return;
  let child;
  try {
    child = require("child_process").spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_WORKER_LOOP], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return;
  }
  psWorker.child = child;
  psWorker.buffer = "";
  // No retiene el proceso de Node (tests, cierre de la app): mientras hay una
  // consulta en curso, su temporizador ya lo mantiene vivo.
  child.unref();
  for (const s of [child.stdin, child.stdout]) if (s && typeof s.unref === "function") s.unref();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    psWorker.buffer += data;
    const cur = psWorker.current;
    if (!cur) return;
    const marker = "KD-FIN-" + cur.id;
    const at = psWorker.buffer.indexOf(marker);
    if (at === -1) return;
    const out = psWorker.buffer.slice(0, at).trim();
    psWorker.buffer = psWorker.buffer.slice(at + marker.length).replace(/^\r?\n/, "");
    psWorker.current = null;
    if (out.startsWith("KD-ERR:")) cur.reject(new Error(out.slice(7)));
    else cur.resolve(out);
  });
  const onGone = () => {
    if (psWorker.child !== child) return;
    psWorker.child = null;
    if (psWorker.current) {
      psWorker.current.reject(workerError("El proceso de consultas de PowerShell se cerró."));
      psWorker.current = null;
    }
  };
  child.on("exit", onGone);
  child.on("error", onGone);
  child.stdin.on("error", () => {});
}

function stopPowerShellWorker() {
  const child = psWorker.child;
  psWorker.child = null;
  if (child) {
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // ya estaba cerrado
    }
  }
}

// Fallo del proceso abierto (no arrancó, se cerró o se colgó), a diferencia de
// un error del propio script: sólo en este caso vale la pena lanzarlo aparte.
function workerError(message) {
  const e = new Error(message);
  e.kdWorker = true;
  return e;
}

function runInWorker(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    startPowerShellWorker();
    const child = psWorker.child;
    if (!child) {
      reject(workerError("Sin proceso de consultas."));
      return;
    }
    const id = psWorker.nextId++;
    const timer = setTimeout(() => {
      // Colgado: se cierra y la próxima consulta arranca uno nuevo.
      if (psWorker.current && psWorker.current.id === id) psWorker.current = null;
      if (psWorker.child === child) stopPowerShellWorker();
      reject(workerError("La consulta de PowerShell tardó demasiado."));
    }, timeoutMs);
    psWorker.current = {
      id,
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    };
    child.stdin.write(id + " " + Buffer.from(script, "utf-8").toString("base64") + "\n");
  });
}

// Ejecuta una consulta fija de PowerShell y devuelve lo que escribe. Usa el
// proceso abierto (de a una consulta: se encolan) y, si falla, la lanza aparte.
function runPowerShellQuery(script, timeoutMs = 15000) {
  const job = psWorker.queue.then(
    () => runInWorker(script, timeoutMs),
    () => runInWorker(script, timeoutMs)
  );
  psWorker.queue = job.catch(() => {});
  return job.catch(async (err) => {
    // Un error del script (KD-ERR) fallaría igual en otro proceso: no se repite.
    if (!err || !err.kdWorker) throw err;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    return String(stdout).trim();
  });
}

// Arranca el proceso y carga ya los módulos de almacenamiento, para que la
// primera lista de discos no pague esa espera.
function warmUpPowerShell() {
  return runPowerShellQuery("Get-Disk | Out-Null; 'ok'", 20000).catch(() => {});
}

async function listDrives() {
  try {
    const raw = await runPowerShellQuery(LIST_DRIVES_SCRIPT, 15000);
    const volumes = JSON.parse(raw);
    const list = Array.isArray(volumes) ? volumes : [volumes];
    const fallback = (process.env.SystemDrive || "C:").replace(/:$/, "");
    return list.filter((v) => v.DriveLetter).map((v) => mapVolume(v, fallback));
  } catch {
    return [];
  }
}

// Límites y capacidades del sistema de archivos destino.
function fileSystemInfo(fileSystem) {
  const fs_ = String(fileSystem || "").toUpperCase();
  const isFat32 = fs_ === "FAT32" || fs_ === "FAT";
  const isExFat = fs_ === "EXFAT";
  return {
    name: fileSystem || "desconocido",
    maxFileSize: isFat32 ? FAT32_MAX_FILE_SIZE : null,
    supportsHardlinks: !(isFat32 || isExFat),
    journaled: !(isFat32 || isExFat),
  };
}

// --- Estado de cifrado BitLocker (sin elevación) ------------------------------

// Valores de la propiedad de shell System.Volume.BitLockerProtection, que se
// puede leer sin permisos de administrador (Get-BitLockerVolume sí los pide).
// Mapeo documentado por la comunidad, no por Microsoft: verificarlo en cada
// versión de Windows soportada antes del release.
const BITLOCKER_SHELL_STATES = {
  0: "unsupported", // el volumen no admite BitLocker
  1: "on", // cifrado y desbloqueado
  2: "off", // sin cifrar
  3: "encrypting",
  4: "decrypting",
  5: "suspended", // cifrado pero con la protección suspendida
  6: "locked", // cifrado y bloqueado
  8: "waiting", // cifrado iniciado sin protector activo ("esperando activación")
};

function parseBitLockerProtection(value) {
  if (value === null || value === undefined || value === "") return "unknown";
  const n = Number(value);
  if (!Number.isInteger(n)) return "unknown";
  return BITLOCKER_SHELL_STATES[n] || "unknown";
}

// EditionID "Core*" = Windows Home (Core, CoreN, CoreSingleLanguage,
// CoreCountrySpecific). Home puede desbloquear BitLocker To Go pero no cifrar.
function isHomeEdition(editionId) {
  return /^Core/i.test(String(editionId || ""));
}

async function getEncryptionStatus(driveRoot) {
  const letterMatch = /^([A-Za-z]):?[\\/]?$/.exec(String(driveRoot || ""));
  if (!letterMatch || !/^[A-Z]$/i.test(letterMatch[1])) {
    return { state: "unknown", editionId: null, canEncrypt: false };
  }
  const letter = letterMatch[1].toUpperCase();
  let protection = null;
  let editionId = null;
  try {
    const script =
      "$ErrorActionPreference='SilentlyContinue'; " +
      `$ns = (New-Object -ComObject Shell.Application).NameSpace('${letter}:'); ` +
      "$p = $null; if ($ns) { $p = $ns.Self.ExtendedProperty('System.Volume.BitLockerProtection') }; " +
      "$e = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').EditionID; " +
      "[PSCustomObject]@{ Protection = $p; Edition = [string]$e } | ConvertTo-Json -Compress";
    const raw = await runPowerShellQuery(script, 10000);
    const info = JSON.parse(raw);
    protection = info.Protection;
    editionId = info.Edition || null;
  } catch {
    // estado desconocido: la UI lo muestra como tal, nunca como "cifrado"
  }
  const state = parseBitLockerProtection(protection);
  return {
    state,
    editionId,
    canEncrypt: !isHomeEdition(editionId) && state !== "unsupported",
  };
}

// --- Cifrar / bloquear / desbloquear (fases 2 y 3) ---------------------------
// Cifrar y bloquear exigen administrador: se hacen en lib/bitlocker-helper.ps1,
// lanzado elevado (aparece el aviso de UAC de Windows). Los argumentos no
// llevan secretos: la contraseña elegida en la app llega protegida con DPAPI en
// un archivo (ver protectPasswordForHelper) y la clave de recuperación la
// genera y la muestra el propio ayudante. Desbloquear no exige administrador:
// usa el cuadro de contraseña nativo de Windows (bdeunlock.exe), el mismo del
// Explorador y el que aparece en cualquier otro equipo.

const BITLOCKER_HELPER_ACTIONS = ["Encrypt", "Lock"];

// Dentro del instalador, lib/ vive en app.asar, que powershell.exe no puede
// leer: electron-builder lo deja en app.asar.unpacked (ver "asarUnpack").
function bitlockerHelperPath(libDir) {
  return path.join(libDir, "bitlocker-helper.ps1").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// Script de PowerShell (no elevado) que lanza el ayudante elevado. Devuelve
// "KD-OK:<pid>" si Windows lo lanzó, o "KD-ERR:<código Win32>:<mensaje>"
// (1223 = el usuario rechazó el aviso de UAC).
function buildHelperLaunchScript({ action, letter, statusFile, scriptPath, fullDisk, volumeId, passwordFile }) {
  if (!BITLOCKER_HELPER_ACTIONS.includes(action)) throw new Error("Acción de BitLocker no válida.");
  if (!/^[A-Z]$/i.test(String(letter || ""))) throw new Error("Letra de unidad no válida.");
  // El ayudante vuelve a comprobar que la letra es este volumen justo antes
  // de actuar: sin identidad válida no se lanza.
  if (!isValidVolumeId(volumeId)) throw new Error("Identidad de volumen no válida.");
  const paths = [statusFile, scriptPath];
  if (passwordFile != null) {
    if (action !== "Encrypt") throw new Error("Sólo al cifrar se entrega una contraseña al ayudante.");
    paths.push(passwordFile);
  }
  for (const p of paths) {
    // Las comillas dobles no pueden aparecer en rutas de Windows; si aparecen,
    // alguien intenta romper el entrecomillado de la línea de comandos elevada.
    if (typeof p !== "string" || !p || /["\0\r\n]/.test(p)) throw new Error("Ruta no válida para el ayudante.");
  }
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    `"${scriptPath}"`,
    "-Action",
    action,
    "-Drive",
    letter.toUpperCase(),
    "-StatusFile",
    `"${statusFile}"`,
    "-VolumeId",
    volumeId,
  ];
  if (fullDisk && action === "Encrypt") args.push("-FullDisk");
  if (passwordFile != null) args.push("-PasswordFile", `"${passwordFile}"`);
  return (
    "$ErrorActionPreference='Stop'; " +
    "try { $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList @(" +
    args.map(psQuote).join(", ") +
    "); 'KD-OK:' + $p.Id } " +
    "catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; " +
    "'KD-ERR:' + $e.NativeErrorCode + ':' + $_.Exception.Message }"
  );
}

function parseHelperLaunchOutput(stdout) {
  const out = String(stdout || "").trim();
  const ok = /KD-OK(?::(\d+))?$/.exec(out);
  if (ok) return ok[1] ? { started: true, pid: Number(ok[1]) } : { started: true };
  const m = /KD-ERR:(\d*):([\s\S]*)$/.exec(out);
  if (m && m[1] === "1223") {
    return { started: false, code: "uac-cancelled", error: "Se canceló el permiso de administrador de Windows." };
  }
  return { started: false, code: "launch-failed", error: m ? m[2].trim() : out || "No se pudo iniciar el ayudante." };
}

async function launchBitLockerHelper(options) {
  const script = buildHelperLaunchScript(options);
  fs.mkdirSync(path.dirname(options.statusFile), { recursive: true });
  fs.rmSync(options.statusFile, { force: true });
  // Espera a que el usuario responda el aviso de UAC (Start-Process vuelve
  // cuando el proceso elevado arrancó o cuando se rechazó).
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf-8",
    timeout: 5 * 60 * 1000,
  });
  return parseHelperLaunchOutput(stdout);
}

function readHelperStatus(statusFile) {
  try {
    const data = JSON.parse(fs.readFileSync(statusFile, "utf-8").replace(/^\uFEFF/, ""));
    return typeof data === "object" && data !== null ? data : null;
  } catch {
    return null; // todavía no escribió nada
  }
}

// ¿Sigue vivo el proceso del ayudante? Con un proceso elevado, process.kill(pid, 0)
// suele fallar con EPERM (existe pero no hay permiso): eso también cuenta como vivo.
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null; // desconocido
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Abre el cuadro "Escribe la contraseña para desbloquear esta unidad" de
// Windows. No necesita administrador y la contraseña nunca pasa por la app.
async function unlockWithWindowsPrompt(driveRoot) {
  const m = /^([A-Za-z]):?[\\/]?$/.exec(String(driveRoot || ""));
  if (!m) throw new Error("Letra de unidad no válida.");
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "bdeunlock.exe");
  try {
    await execFileAsync(exe, [m[1].toUpperCase() + ":"], { timeout: 10 * 60 * 1000 });
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("Este Windows no incluye el desbloqueo de BitLocker (bdeunlock.exe).");
    // bdeunlock sale con código distinto de 0 si se cierra el cuadro: el
    // estado real se vuelve a consultar después, así que no es un error.
  }
}

// --- Contraseña elegida en la app para cifrar --------------------------------
// La contraseña se escribe en el panel de la app. Para llevarla al ayudante
// elevado sin ponerla en la línea de comandos ni dejarla en texto plano en el
// disco, se protege con DPAPI (ConvertFrom-SecureString, ligada al usuario de
// Windows) y se deja en un archivo junto al de estado. El ayudante lo lee, lo
// borra en el acto y obtiene un SecureString. Si el permiso de administrador lo
// da otra cuenta, DPAPI no la puede abrir y el ayudante la vuelve a pedir en su
// propia ventana.

const MIN_PASSWORD_LENGTH = 8; // el mínimo de BitLocker para discos de datos
const MAX_PASSWORD_LENGTH = 256;

function validateNewPassword(password) {
  if (typeof password !== "string") return { ok: false, error: "Contraseña no válida." };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `La contraseña no puede tener más de ${MAX_PASSWORD_LENGTH} caracteres.` };
  }
  // Tabuladores, saltos de línea y otros caracteres de control no se pueden
  // escribir en el cuadro de desbloqueo de Windows.
  if (/[\u0000-\u001f\u007f]/.test(password)) {
    return { ok: false, error: "La contraseña tiene caracteres que no se pueden escribir al desbloquear." };
  }
  return { ok: true };
}

// Llega por la entrada estándar en base64 (UTF-8), así ni la consola ni su
// página de códigos alteran tildes o eñes: la contraseña que se guarda es
// exactamente la que se escribió.
const PROTECT_PASSWORD_SCRIPT =
  "$ErrorActionPreference='Stop'; " +
  "$b = [Convert]::FromBase64String([Console]::In.ReadLine()); " +
  "$c = [Text.Encoding]::UTF8.GetChars($b); [Array]::Clear($b, 0, $b.Length); " +
  "$s = New-Object System.Security.SecureString; foreach ($ch in $c) { $s.AppendChar($ch) }; " +
  "[Array]::Clear($c, 0, $c.Length); " +
  "ConvertFrom-SecureString -SecureString $s";

function protectPasswordForHelper(password) {
  const check = validateNewPassword(password);
  if (!check.ok) return Promise.reject(new Error(check.error));
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PROTECT_PASSWORD_SCRIPT],
      { encoding: "utf-8", timeout: 30000, windowsHide: true },
      (err, stdout) => {
        const blob = String(stdout || "").trim();
        if (err || !/^[0-9a-f]+$/i.test(blob)) {
          reject(new Error("Windows no pudo proteger la contraseña para entregarla al ayudante de BitLocker."));
          return;
        }
        resolve(blob);
      }
    );
    child.stdin.on("error", () => {}); // si PowerShell falla antes de leer, lo informa el callback
    child.stdin.end(Buffer.from(password, "utf-8").toString("base64") + "\n");
  });
}

// --- Expulsar el disco (quitar hardware de forma segura) ---------------------
// Lo mismo que "Quitar hardware de forma segura" de Windows, sin administrador.
// Sólo se expulsa un dispositivo que Windows marca como extraíble; si un
// programa usa el disco, Windows lo impide y se informa el motivo.
//
// El código vive en lib/eject-drive.ps1 y se lanza como archivo: pasado como
// -EncodedCommand, PowerShell se pone a "preparar módulos" y tarda ~30 s.
// Igual que el ayudante de BitLocker, dentro del instalador está en
// app.asar.unpacked (powershell.exe no puede leer app.asar).
function ejectScriptPath(libDir) {
  return path.join(libDir, "eject-drive.ps1").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

// Motivos por los que Windows puede negarse (PNP_VETO_TYPE).
function describeEjectVeto(vetoType, vetoName) {
  switch (vetoType) {
    case 3: // PendingClose
    case 4: // WindowsApp
    case 5: // WindowsService
    case 6: // OutstandingOpen
      return (
        "Hay un programa o una ventana usando el disco. Cierra los archivos y carpetas abiertos del disco " +
        "(también en el Explorador) y vuelve a intentarlo." +
        (vetoType === 4 && vetoName ? ` Programa: ${vetoName}.` : "")
      );
    case 13: // InsufficientRights
      return "Windows no permite expulsar este disco sin permisos de administrador.";
    case 11: // NonDisableable
      return "Windows no permite expulsar este disco (lo está usando el sistema).";
    default:
      return `Windows no permitió expulsar el disco (motivo ${vetoType}).`;
  }
}

function parseEjectOutput(stdout) {
  const out = String(stdout || "").trim();
  const m = /KD-EJECT:([\s\S]*)$/.exec(out);
  if (!m) return { ok: false, code: "error", error: out || "No se pudo expulsar el disco." };
  const res = m[1].trim();
  if (res === "OK") return { ok: true };
  const veto = /^VETO:(\d+):([\s\S]*)$/.exec(res);
  if (veto) {
    const vetoType = Number(veto[1]);
    return { ok: false, code: "veto", vetoType, error: describeEjectVeto(vetoType, veto[2].trim()) };
  }
  const err = /^ERR:([a-z-]+):([\s\S]*)$/.exec(res);
  if (err) {
    const error =
      err[1] === "not-removable"
        ? "Windows no considera este disco extraíble, así que no se puede expulsar desde la app. " +
          "Si es un disco externo, usa \"Quitar hardware de forma segura\" en la barra de tareas."
        : err[2].trim();
    return { ok: false, code: err[1], error };
  }
  return { ok: false, code: "error", error: res };
}

async function ejectDrive(driveRoot, scriptPath) {
  const m = /^([A-Za-z]):?[\\/]?$/.exec(String(driveRoot || ""));
  if (!m) throw new Error("Letra de unidad no válida.");
  let stdout = "";
  try {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Drive", m[1].toUpperCase()];
    ({ stdout } = await execFileAsync("powershell.exe", args, { encoding: "utf-8", timeout: 60000, windowsHide: true }));
  } catch (err) {
    stdout = err.stdout || "";
    if (!/KD-EJECT:/.test(stdout)) return { ok: false, code: "error", error: "No se pudo expulsar el disco: " + err.message };
  }
  return parseEjectOutput(stdout);
}

async function openBitLockerPanel() {
  await execFileAsync("control.exe", ["/name", "Microsoft.BitLockerDriveEncryption"], { timeout: 10000 }).catch(
    (err) => {
      // control.exe a veces sale con código != 0 aunque abrió el panel
      if (err.code === "ENOENT") throw err;
    }
  );
}

async function detectDriveType(driveRoot) {
  const letterMatch = /^([A-Za-z])/.exec(String(driveRoot || ""));
  if (!letterMatch) return { mediaType: "Unknown", busType: "Unknown" };
  const letter = letterMatch[1];

  try {
    const script =
      "$ErrorActionPreference='Stop'; " +
      `$part = Get-Partition -DriveLetter '${letter}'; ` +
      "$disk = Get-Disk -Number $part.DiskNumber; " +
      "$phys = Get-PhysicalDisk -DeviceNumber $disk.Number; " +
      "[PSCustomObject]@{ MediaType = [string]$phys.MediaType; BusType = [string]$phys.BusType } | ConvertTo-Json -Compress";
    const raw = await runPowerShellQuery(script, 8000);
    const info = JSON.parse(raw);
    return { mediaType: info.MediaType || "Unknown", busType: info.BusType || "Unknown" };
  } catch {
    return { mediaType: "Unknown", busType: "Unknown" };
  }
}

function pickConcurrency(driveInfo, avgFileSize) {
  const manySmallFiles = avgFileSize > 0 && avgFileSize < 2 * 1024 * 1024;
  const isSpinning = driveInfo.mediaType === "HDD";
  const isSSD = driveInfo.mediaType === "SSD" || driveInfo.busType === "NVMe";

  if (isSpinning) return manySmallFiles ? 2 : 1;
  if (isSSD) return manySmallFiles ? 8 : 4;
  // Pendrive USB (sin tipo de medio conocido): escrituras en paralelo lo hacen
  // más lento, no más rápido (medido: 1,31 MB/s con 1 contra 1,14 MB/s con 2).
  if (driveInfo.busType === "USB") return 1;
  return manySmallFiles ? 4 : 2;
}

// --- Journal de operaciones -------------------------------------------------

// Formato append-only (JSONL): la primera línea es la cabecera con todos los
// destinos planificados; después, cada archivo copiado agrega una línea con su
// ruta. Persistir "done" archivo por archivo (en vez de reescribir el journal
// cada tanto) evita que una interrupción marque como pendientes —y borre—
// archivos que en realidad ya se copiaron completos.

function startJournal(journalDirPath, tasks) {
  if (!tasks.length) return null;
  fs.mkdirSync(journalDirPath, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fp = path.join(journalDirPath, "backup_" + stamp + ".jsonl");
  // version 2: las copias van a "<destino>.kopia-tmp" + rename, así que lo que
  // queda a medias tras un corte es el temporal, nunca el archivo del backup.
  const header = {
    version: 2,
    startedAt: new Date().toISOString(),
    planned: tasks.map((t) => t.relativeDest),
  };
  fs.writeFileSync(fp, JSON.stringify(header) + "\n");
  return fp;
}

// Diario por lotes: en vez de abrir, escribir y cerrar el diario en la USB por
// cada archivo (medido: ~6 ms por archivo, el 20 % del tiempo con muchos
// archivos pequeños), se juntan las líneas y se escriben cada `maxLines` o cada
// `maxMs`. Es igual de seguro: tras un corte, checkJournals() sólo borra el
// TEMPORAL de lo que no figura como hecho, y un archivo que ya terminó no tiene
// temporal (se renombró), así que no se borra nada suyo aunque falte su línea.
function createJournalWriter(journalPath, { maxLines = 50, maxMs = 2000 } = {}) {
  let lines = [];
  let last = Date.now();
  const flush = () => {
    if (!lines.length) return;
    const chunk = lines.join("");
    lines = [];
    last = Date.now();
    try {
      fs.appendFileSync(journalPath, chunk);
    } catch {
      // no crítico: sólo afecta cuántos temporales revisa la limpieza tras un corte
    }
  };
  return {
    add(relativeDest) {
      if (!journalPath) return;
      lines.push(JSON.stringify(relativeDest) + "\n");
      if (lines.length >= maxLines || Date.now() - last >= maxMs) flush();
    },
    flush,
  };
}

function appendJournalDone(journalPath, relativeDest) {
  try {
    fs.appendFileSync(journalPath, JSON.stringify(relativeDest) + "\n");
  } catch {
    // no crítico: sólo afecta la limpieza si el backup se interrumpe
  }
}

function finishJournal(journalPath) {
  try {
    fs.unlinkSync(journalPath);
  } catch {
    // ya no existe
  }
}

function readJournalPending(fp) {
  const raw = fs.readFileSync(fp, "utf-8");
  if (fp.endsWith(".jsonl")) {
    const lines = raw.split("\n").filter((l) => l.trim());
    const header = JSON.parse(lines[0]);
    const done = new Set();
    for (const line of lines.slice(1)) {
      try {
        done.add(JSON.parse(line));
      } catch {
        // línea cortada por la interrupción: ese archivo queda como pendiente
      }
    }
    return {
      version: header.version || 1,
      startedAt: header.startedAt || null,
      pending: (header.planned || []).filter((p) => !done.has(p)),
    };
  }
  // Formato legado (.json): { startedAt, entries: [{ relativeDest, status }] }
  const data = JSON.parse(raw);
  return {
    version: 1,
    startedAt: data.startedAt || null,
    pending: (data.entries || []).filter((e) => e.status !== "done").map((e) => e.relativeDest),
  };
}

// Archivos a medias que dejó un backup interrumpido. En journals v2 son sólo
// los temporales ".kopia-tmp": el destino, si existe, es la versión anterior
// completa o la nueva completa (el rename es atómico), y NO se toca. En
// journals v1 (copia directa sobre el destino) el propio destino puede estar
// truncado y se mantiene el comportamiento anterior de borrarlo.
function leftoversFor(version, pending, destRoot) {
  const leftovers = [];
  for (const relativeDest of pending) {
    try {
      const target = safePath(destRoot, relativeDest);
      const candidate = version >= 2 ? tmpPathFor(target) : target;
      if (fs.existsSync(candidate)) leftovers.push(candidate);
    } catch {
      // ruta inválida: se ignora
    }
  }
  return leftovers;
}

// Revisa los journals SIN borrar nada: informa si quedó un backup interrumpido
// y cuántos archivos parciales hay, para que la UI pueda pedir confirmación al
// usuario antes de que checkJournals() haga la limpieza real. Con `destRoot`
// cuenta sólo lo que de verdad hay para limpiar; sin él, lo pendiente.
function peekJournals(journalDirPath, destRoot) {
  if (!fs.existsSync(journalDirPath)) return { found: 0, pendingFiles: 0, lastInterruptedAt: null };

  const files = fs.readdirSync(journalDirPath).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
  let pendingFiles = 0;
  let lastInterruptedAt = null;

  for (const f of files) {
    try {
      const { version, startedAt, pending } = readJournalPending(path.join(journalDirPath, f));
      if (startedAt) lastInterruptedAt = startedAt;
      pendingFiles += destRoot ? leftoversFor(version, pending, destRoot).length : pending.length;
    } catch {
      // journal corrupto: cuenta como interrumpido igual, checkJournals lo descartará
    }
  }

  return { found: files.length, pendingFiles, lastInterruptedAt };
}

function checkJournals(journalDirPath, destRoot) {
  if (!fs.existsSync(journalDirPath)) return { found: 0, filesCleaned: 0, lastInterruptedAt: null };

  const files = fs.readdirSync(journalDirPath).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
  let filesCleaned = 0;
  let lastInterruptedAt = null;

  for (const f of files) {
    const fp = path.join(journalDirPath, f);
    try {
      const { version, startedAt, pending } = readJournalPending(fp);
      if (startedAt) lastInterruptedAt = startedAt;
      for (const leftover of leftoversFor(version, pending, destRoot)) {
        try {
          fs.unlinkSync(leftover);
          filesCleaned++;
        } catch {
          // ya no existe: se ignora
        }
      }
    } catch {
      // journal corrupto, se descarta igual
    }
    try {
      fs.unlinkSync(fp);
    } catch {
      // ya no existe
    }
  }

  return { found: files.length, filesCleaned, lastInterruptedAt };
}

async function hideFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return false;
  try {
    await execFileAsync("attrib", ["+h", "+s", folderPath], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// --- Último backup en un disco ------------------------------------------------

// Cada backup deja un informe por carpeta de origen en .kopia-data/logs,
// llamado "<carpeta>_<fecha ISO con guiones>.json". Las corridas nuevas llevan
// además "run" (la misma marca para todas las carpetas de esa corrida). Se
// junta la corrida más reciente; un informe viejo sin "run" cuenta solo.
const LOG_STAMP_RE = /_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;
const MAX_LOGS_READ = 200;
const MAX_LOG_SIZE = 5 * 1024 * 1024;

function summarizeLastBackup(logsDir) {
  let names;
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return null;
  }
  const newest = names
    .map((n) => ({ n, m: LOG_STAMP_RE.exec(n) }))
    .filter((x) => x.m)
    .sort((a, b) => (a.m[1] < b.m[1] ? 1 : a.m[1] > b.m[1] ? -1 : 0))
    .slice(0, MAX_LOGS_READ);
  let run;
  const reports = [];
  for (const { n } of newest) {
    let report;
    try {
      const fp = path.join(logsDir, n);
      if (fs.statSync(fp).size > MAX_LOG_SIZE) continue;
      report = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      continue; // informe dañado: se salta
    }
    if (!report || typeof report !== "object") continue;
    if (!reports.length) {
      run = report.run || null;
      reports.push(report);
      if (!run) break;
    } else if (report.run === run) {
      reports.push(report);
    } else {
      break;
    }
  }
  if (!reports.length) return null;
  const dates = reports.map((r) => Date.parse(r.date)).filter((d) => !Number.isNaN(d));
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    date: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    sources: reports.map((r) => String(r.source || "")).filter(Boolean).reverse(),
    copied: reports.reduce((t, r) => t + (Number(r.copied) || 0), 0),
    failed: reports.reduce((t, r) => t + count(r.failed), 0),
  };
}

module.exports = {
  BACKUP_ROOT,
  DEFAULT_EXCLUDES,
  TMP_SUFFIX,
  FAT32_MAX_FILE_SIZE,
  safeName,
  safePath,
  safeBackupPath,
  isInside,
  tmpPathFor,
  atomicWriteFileSync,
  readJsonWithFallback,
  compileExcludePatterns,
  compileExcludes,
  excludedRelativePaths,
  summarizeLastBackup,
  isExcluded,
  excludeRuleFor,
  EXCLUDED_BY_USER,
  createScanReport,
  scanDirectoryRecursive,
  hashFileAsync,
  quickHashFile,
  copyFileVerified,
  restoreFileVerified,
  linkAtomic,
  writeVersionAtomic,
  ContentIndex,
  indexEntryMatches,
  copyOneTask,
  listDrives,
  runPowerShellQuery,
  startPowerShellWorker,
  stopPowerShellWorker,
  warmUpPowerShell,
  mapVolume,
  isProtectedSystemVolume,
  isValidVolumeId,
  checkBitLockerTarget,
  driveIdentityChanged,
  fileSystemInfo,
  parseBitLockerProtection,
  isHomeEdition,
  getEncryptionStatus,
  openBitLockerPanel,
  bitlockerHelperPath,
  buildHelperLaunchScript,
  parseHelperLaunchOutput,
  launchBitLockerHelper,
  readHelperStatus,
  isProcessAlive,
  unlockWithWindowsPrompt,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  validateNewPassword,
  protectPasswordForHelper,
  ejectScriptPath,
  parseEjectOutput,
  ejectDrive,
  detectDriveType,
  pickConcurrency,
  hideFolder,
  startJournal,
  appendJournalDone,
  createJournalWriter,
  runTasks,
  pickRestoreConcurrency,
  ensureDir,
  finishJournal,
  peekJournals,
  checkJournals,
};
