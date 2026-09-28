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
      return new RegExp("^" + escaped + "$", "i");
    });
}

function isExcluded(name, compiledPatterns) {
  return compiledPatterns.some((re) => re.test(name));
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

function createScanReport() {
  return { excluded: 0, skipped: [] };
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
      if (isExcluded(entry.name, compiledExcludes)) {
        if (report) report.excluded++;
        return;
      }
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = basePath ? basePath + "/" + entry.name : entry.name;

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

function hashFileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
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
async function copyOnceVerified(srcPath, target, tmp) {
  const before = await fs.promises.stat(srcPath);
  try {
    await fs.promises.unlink(tmp).catch(() => {});
    await fs.promises.copyFile(srcPath, tmp);
    // CopyFileW copia también los atributos: un origen de sólo lectura dejaría
    // un temporal que después no se puede renombrar encima ni borrar.
    await fs.promises.chmod(tmp, 0o666);
    const fh = await fs.promises.open(tmp, "r+");
    try {
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

    await fs.promises.utimes(tmp, before.atimeMs / 1000, before.mtimeMs / 1000);
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
  const tmp = tmpPathFor(target);
  for (let attempt = 0; ; attempt++) {
    try {
      return await copyOnceVerified(srcPath, target, tmp);
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
  const result = await copyFileVerified(backupFullPath, dest);
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
async function copyOneTask(task, ctx = {}) {
  const target = safeBackupPath(task.destRoot, task.relativeDest);
  const relative = path.relative(task.destRoot, target);
  const index = ctx.index || null;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

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

async function listDrives() {
  try {
    const { stdout: raw } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", LIST_DRIVES_SCRIPT], {
      encoding: "utf-8",
      timeout: 15000,
    });
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
    const { stdout: raw } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      timeout: 10000,
    });
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
// llevan secretos: la contraseña y la clave de recuperación las maneja el
// propio ayudante en sus ventanas. Desbloquear no exige administrador: usa el
// cuadro de contraseña nativo de Windows (bdeunlock.exe), el mismo del Explorador.

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
function buildHelperLaunchScript({ action, letter, statusFile, scriptPath, fullDisk, volumeId }) {
  if (!BITLOCKER_HELPER_ACTIONS.includes(action)) throw new Error("Acción de BitLocker no válida.");
  if (!/^[A-Z]$/i.test(String(letter || ""))) throw new Error("Letra de unidad no válida.");
  // El ayudante vuelve a comprobar que la letra es este volumen justo antes
  // de actuar: sin identidad válida no se lanza.
  if (!isValidVolumeId(volumeId)) throw new Error("Identidad de volumen no válida.");
  for (const p of [statusFile, scriptPath]) {
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
    const { stdout: raw } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      timeout: 8000,
    });
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
  isExcluded,
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
  detectDriveType,
  pickConcurrency,
  hideFolder,
  startJournal,
  appendJournalDone,
  finishJournal,
  peekJournals,
  checkJournals,
};
