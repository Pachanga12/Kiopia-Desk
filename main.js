"use strict";

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, screen } = require("electron");
const path = require("path");
// "original-fs": el fs sin el parche de Electron que trata los .asar como
// carpetas (ver lib/core.js). Las rutas del backup pueden contener .asar.
const fs = require("original-fs");
const {
  BACKUP_ROOT,
  DEFAULT_EXCLUDES,
  safeName,
  safePath,
  isInside,
  atomicWriteFileSync,
  readJsonWithFallback,
  compileExcludePatterns,
  createScanReport,
  scanDirectoryRecursive,
  hashFileAsync,
  quickHashFile,
  copyFileVerified,
  restoreFileVerified,
  writeVersionAtomic,
  ContentIndex,
  copyOneTask,
  listDrives,
  fileSystemInfo,
  getEncryptionStatus,
  openBitLockerPanel,
  bitlockerHelperPath,
  launchBitLockerHelper,
  checkBitLockerTarget,
  driveIdentityChanged,
  isProtectedSystemVolume,
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
} = require("./lib/core.js");

const METADATA_DIR = ".kopia-data";
const BACKUP_CONCURRENCY = 3;
// content-index.json también se guarda cada tantos archivos copiados, no sólo
// al final del lote: si el proceso se corta a mitad de un backup grande, los
// archivos ya copiados y journalados quedan completos igual, pero sin este
// guardado periódico el índice en disco no se enteraba de ellos y se perdía
// la oportunidad de deduplicarlos la próxima vez (no se pierde nada, sólo se
// vuelve a copiar en vez de enlazar). Cada cuántos archivos es un balance
// entre acotar esa ventana y no hacer un fsync de más por archivo.
const INDEX_SAVE_INTERVAL = 25;

const QUICK_FOLDERS = [
  { key: "pictures", name: "Imágenes" },
  { key: "documents", name: "Documentos" },
  { key: "downloads", name: "Descargas" },
  { key: "music", name: "Música" },
  { key: "videos", name: "Videos" },
  { key: "desktop", name: "Escritorio" },
];

let mainWindow = null;

function createWindow() {
  // 1220×740 como máximo, pero sin pasarse nunca del área útil del monitor
  // (sin la barra de tareas): en un portátil de 1366×768 el alto útil es
  // ~720 px y una ventana fija de 740 quedaría tapada por la barra de tareas.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1220, area.width - 40);
  const height = Math.min(740, area.height - 24);
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(960, width),
    minHeight: Math.min(600, height),
    center: true,
    title: "Kopia Desk v2",
    icon: path.join(__dirname, "assets", "Kopia_Desk_icon.png"),
    // Fondo mientras carga la interfaz: el del tema de Windows (colores --bg de
    // styles.css), para que no haya un destello blanco en modo oscuro ni
    // oscuro en modo claro.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#090e1a" : "#f8fafc",
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // La interfaz es local: no se abren ventanas nuevas ni se navega a otro sitio.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("maximize", () => mainWindow.webContents.send("window:state", { maximized: true }));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window:state", { maximized: false }));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Instancia única: dos Kopia Desk abiertas a la vez escribirían sobre los
// mismos manifiestos, índice y configuración y podrían pisarse. Si ya hay una,
// esta se cierra y se trae al frente la ventana existente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(createWindow);
}
app.on("window-all-closed", () => app.quit());

// --- Ventana sin marco: controles propios (minimizar/maximizar/cerrar) -----

ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle("window:close", () => mainWindow?.close());
ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false);

// --- Validación de rutas que llegan del renderer ----------------------------
// El renderer no debería poder pedir leer o escribir rutas arbitrarias. El
// proceso principal sólo acepta:
//   - discos destino devueltos por listDrives;
//   - carpetas de origen elegidas por diálogo, accesos rápidos o guardadas en
//     la configuración (que sólo se guarda con orígenes ya permitidos);
//   - carpetas de restauración elegidas por diálogo;
//   - rutas del backup dentro de <disco>\KopiaDesk_Backup.

const allowed = {
  destRoots: new Set(), // "E:\\" en mayúsculas
  sources: new Set(), // rutas absolutas en minúsculas
  comparePaths: new Set(), // rutas de sources.json del disco (sólo para listar en Comparar)
  restoreTargets: new Set(),
};

function driveKey(root) {
  const m = /^([A-Za-z]):[\\/]?$/.exec(String(root || ""));
  return m ? m[1].toUpperCase() + ":\\" : null;
}

function pathKey(p) {
  return path.resolve(p).toLowerCase();
}

let lastDrives = [];

async function refreshDrives() {
  lastDrives = await listDrives();
  for (const d of lastDrives) {
    const key = driveKey(d.root);
    if (key) allowed.destRoots.add(key);
  }
  return lastDrives;
}

async function assertDestRoot(destRoot) {
  const key = driveKey(destRoot);
  if (!key) throw new Error("Disco destino no válido.");
  if (!allowed.destRoots.has(key)) await refreshDrives();
  if (!allowed.destRoots.has(key)) throw new Error("Disco destino no reconocido: " + destRoot);
  return key;
}

// Auditoría: assertDestRoot sólo confirma que la LETRA sigue montada, nunca
// que sea el MISMO disco físico. Sin esto, cambiar el USB a mitad de un
// backup grande por otro con la misma letra hacía que el resto de los
// archivos se copiaran al disco nuevo sin ningún aviso. Se llama una vez por
// lote (no por archivo: refreshDrives() lanza PowerShell de verdad, no tiene
// sentido pagar ese costo por cada archivo). `expectedVolumeId` es opcional
// a propósito: llamadas viejas/sin ese dato simplemente no quedan cubiertas,
// en vez de romper.
async function assertDestVolumeUnchanged(destKey, expectedVolumeId) {
  if (!expectedVolumeId) return;
  const drives = await refreshDrives();
  if (driveIdentityChanged(drives, destKey[0], expectedVolumeId)) {
    throw new Error(
      `El disco ${destKey} cambió desde que lo elegiste (se desconectó o se conectó otro con la misma letra). ` +
        "No se copió nada más en este lote para no mezclar dos discos distintos en el mismo backup. Volvé a elegirlo."
    );
  }
}

function allowSource(p) {
  if (typeof p === "string" && p) allowed.sources.add(pathKey(p));
}

function insideAny(set, p) {
  if (typeof p !== "string" || !p) return false;
  for (const root of set) if (isInside(root, p)) return true;
  return false;
}

function assertSourcePath(p) {
  if (!insideAny(allowed.sources, p)) throw new Error("Ruta de origen no autorizada: " + p);
}

function backupRootOf(destKey) {
  return path.join(destKey, BACKUP_ROOT);
}

function assertInsideBackup(p) {
  for (const key of allowed.destRoots) {
    if (isInside(backupRootOf(key), p)) return;
  }
  throw new Error("Ruta fuera del backup: " + p);
}

// Ruta relativa al disco destino que debe quedar bajo KopiaDesk_Backup (y,
// opcionalmente, bajo una subcarpeta concreta como .kopia-data/versions).
function assertBackupRelative(destKey, relativeDest, subdir) {
  const target = safePath(destKey, relativeDest);
  const base = subdir ? path.join(backupRootOf(destKey), subdir) : backupRootOf(destKey);
  if (!isInside(base, target) || target.toLowerCase() === base.toLowerCase()) {
    throw new Error("Destino fuera del backup: " + relativeDest);
  }
  if (!subdir && isInside(path.join(backupRootOf(destKey), METADATA_DIR), target)) {
    throw new Error("Destino dentro de los metadatos del backup: " + relativeDest);
  }
  return target;
}

ipcMain.handle("drives:list", async () => {
  const drives = await refreshDrives();
  return drives.map((d) => ({ ...d, fsInfo: fileSystemInfo(d.fileSystem) }));
});

ipcMain.handle("dialog:select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Seleccionar carpeta de origen",
  });
  if (result.canceled || !result.filePaths.length) return null;
  allowSource(result.filePaths[0]);
  return result.filePaths[0];
});

ipcMain.handle("dialog:select-restore-target", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Seleccionar carpeta destino para restaurar",
  });
  if (result.canceled || !result.filePaths.length) return null;
  allowed.restoreTargets.add(pathKey(result.filePaths[0]));
  return result.filePaths[0];
});

// Carpetas típicas del usuario (Imágenes, Documentos, Descargas, Música, Videos,
// Escritorio) para agregarlas con un clic en vez de navegar con el diálogo.
// Sólo se devuelven las que realmente existen en este equipo.
ipcMain.handle("folders:quick-list", () => {
  const result = [];
  for (const candidate of QUICK_FOLDERS) {
    try {
      const folderPath = app.getPath(candidate.key);
      if (folderPath && fs.existsSync(folderPath)) {
        allowSource(folderPath);
        result.push({ name: candidate.name, path: folderPath });
      }
    } catch {
      // no disponible en este sistema/perfil de usuario
    }
  }
  return result;
});

// --- Filtros de exclusión ---------------------------------------------

ipcMain.handle("config:default-excludes", () => DEFAULT_EXCLUDES);

ipcMain.handle("fs:scan-directory", async (event, dirPath, excludePatterns) => {
  assertSourcePath(dirPath);
  if (!fs.existsSync(dirPath)) throw new Error("La carpeta no existe: " + dirPath);
  const patterns = Array.isArray(excludePatterns) && excludePatterns.length ? excludePatterns : DEFAULT_EXCLUDES;
  const report = createScanReport();
  const files = await scanDirectoryRecursive(dirPath, "", compileExcludePatterns(patterns), report);
  return { files, excluded: report.excluded, skipped: report.skipped };
});

// --- Hashing -------------------------------------------------------------

ipcMain.handle("fs:hash-file", async (_event, filePath) => {
  assertSourcePath(filePath);
  return hashFileAsync(filePath);
});

ipcMain.handle("fs:quick-hash", (_event, filePath, size) => {
  assertSourcePath(filePath);
  return quickHashFile(filePath, size);
});

function metadataDir(destRoot) {
  return path.join(destRoot, BACKUP_ROOT, METADATA_DIR);
}

function manifestDir(destRoot) {
  return path.join(metadataDir(destRoot), "manifests");
}

function manifestFilePath(destRoot, sourceName) {
  return path.join(manifestDir(destRoot), safeName(sourceName) + ".json");
}

function prevManifestPath(fp) {
  return fp.replace(/\.json$/, ".prev.json");
}

// Devuelve { manifest, warning }. Si el manifiesto está dañado se usa el
// .prev.json (y se avisa); si tampoco se puede, se avisa en vez de tratar todo
// en silencio como nuevo.
function loadManifestWithFallback(destRoot, sourceName) {
  const fp = manifestFilePath(destRoot, sourceName);
  const result = readJsonWithFallback(fp, prevManifestPath(fp));
  let warning = null;
  if (result.source === "fallback") {
    warning =
      "El registro de '" + sourceName + "' estaba dañado; se usó la copia anterior (.prev.json). " +
      "Los cambios del último backup pueden volver a aparecer como pendientes.";
  } else if (result.source === "corrupt") {
    warning =
      "El registro de '" + sourceName + "' está dañado y no hay copia anterior utilizable. " +
      "Todo aparecerá como nuevo y se perdió el registro de eliminados.";
  }
  return { manifest: result.data, warning };
}

ipcMain.handle("manifest:load", async (_event, destRoot, sourceName) => {
  const key = await assertDestRoot(destRoot);
  return loadManifestWithFallback(key, sourceName);
});

ipcMain.handle("manifest:save", async (_event, destRoot, sourceName, manifest) => {
  const key = await assertDestRoot(destRoot);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("Manifiesto con formato inválido.");
  }
  const fp = manifestFilePath(key, sourceName);

  // Sólo se rota a .prev.json un manifiesto que se pueda leer: así un
  // principal dañado nunca pisa el último respaldo bueno.
  const current = readJsonWithFallback(fp, null);
  if (current.source === "main") {
    atomicWriteFileSync(prevManifestPath(fp), fs.readFileSync(fp));
  }

  atomicWriteFileSync(fp, JSON.stringify(manifest, null, 2));
  await hideFolder(metadataDir(key));
  return { ok: true };
});

// --- Origen recordado por carpeta (para restaurar sin volver a preguntar) ---

function sourcesMapPath(destRoot) {
  return path.join(metadataDir(destRoot), "sources.json");
}

ipcMain.handle("sources:remember", async (_event, destRoot, sourceName, sourcePath) => {
  const key = await assertDestRoot(destRoot);
  if (!insideAny(allowed.sources, sourcePath) && !insideAny(allowed.comparePaths, sourcePath)) {
    throw new Error("Ruta de origen no autorizada: " + sourcePath);
  }
  const fp = sourcesMapPath(key);
  const map = readJsonWithFallback(fp, null).data;
  map[sourceName] = sourcePath;
  atomicWriteFileSync(fp, JSON.stringify(map, null, 2));
  return { ok: true };
});

ipcMain.handle("sources:known-paths", async (_event, destRoot) => {
  const key = await assertDestRoot(destRoot);
  const loaded = readJsonWithFallback(sourcesMapPath(key), null);
  const map = loaded.data;
  // Vienen del disco de backup, no de una elección del usuario: se permiten
  // sólo para listar nombres/tamaños en Comparar, no para leer contenido.
  for (const p of Object.values(map)) {
    if (typeof p === "string" && p) allowed.comparePaths.add(pathKey(p));
  }
  // Auditoría: un sources.json dañado antes se volvía {} en silencio (se
  // perdía el recordatorio de carpeta local por backup, sin avisar). No es
  // un nombre de carpeta real (los nombres de carpeta no empiezan con "__").
  if (loaded.source === "corrupt") map.__corrupt = true;
  return map;
});

// --- Deduplicación por contenido (hardlinks) -------------------------------

function contentIndexPath(destRoot) {
  return path.join(metadataDir(destRoot), "content-index.json");
}

function loadContentIndex(destRoot) {
  return new ContentIndex(readJsonWithFallback(contentIndexPath(destRoot), null).data);
}

function saveContentIndex(destRoot, index) {
  atomicWriteFileSync(contentIndexPath(destRoot), JSON.stringify(index, null, 2));
}

// --- Journal de operaciones (detecta/limpia backups interrumpidos) ---------
// La lógica vive en lib/core.js (append-only, testeable); acá sólo se resuelve
// la carpeta donde se guarda dentro del disco destino.

function journalDir(destRoot) {
  return path.join(metadataDir(destRoot), "journal");
}

// Peek: sólo informa si hay un backup interrumpido, sin tocar archivos. La
// limpieza real (journal:check) se dispara cuando el usuario la confirma.
ipcMain.handle("journal:peek", async (_event, destRoot) => {
  const key = await assertDestRoot(destRoot);
  return peekJournals(journalDir(key), key);
});

ipcMain.handle("journal:check", async (_event, destRoot) => {
  const key = await assertDestRoot(destRoot);
  return checkJournals(journalDir(key), key);
});

// --- Detección de tipo de disco (para concurrencia adaptativa) ------------

ipcMain.handle("backup:plan-concurrency", async (_event, driveRoot, avgFileSize) => {
  const key = await assertDestRoot(driveRoot);
  const driveInfo = await detectDriveType(key);
  return { concurrency: pickConcurrency(driveInfo, avgFileSize), driveInfo };
});

// --- Cifrado del disco destino (fase 1: detectar y abrir el panel nativo) ---

ipcMain.handle("encryption:status", async (_event, driveRoot) => {
  const key = await assertDestRoot(driveRoot);
  const drive = lastDrives.find((d) => driveKey(d.root) === key);
  const status = await getEncryptionStatus(key);
  // Nunca se ofrece cifrar ni bloquear nada del disco del sistema (ni un
  // volumen cuyo disco no se pudo averiguar). Es sólo para la interfaz: la
  // comprobación que manda se repite al cifrar o bloquear.
  status.systemProtected = isProtectedSystemVolume(drive);
  if (status.systemProtected) status.canEncrypt = false;
  return status;
});

ipcMain.handle("encryption:open-panel", async () => {
  await openBitLockerPanel();
  return { ok: true };
});

// --- Cifrado del disco destino (fases 2 y 3: cifrar, bloquear, desbloquear) ---

const BITLOCKER_HELPER = bitlockerHelperPath(path.join(__dirname, "lib"));

function helperStatusPath(letter, action) {
  return path.join(app.getPath("userData"), "bitlocker", `${letter}-${action}.json`);
}

// PID del ayudante por "<letra>-<acción>", para detectar si se cerró sin
// terminar (p. ej. lo cerró el Administrador de tareas).
const helperPids = new Map();

async function launchHelper(action, key, extra = {}) {
  const result = await launchBitLockerHelper({
    action,
    letter: key[0],
    statusFile: helperStatusPath(key[0], action),
    scriptPath: BITLOCKER_HELPER,
    ...extra,
  });
  if (result.started) helperPids.set(`${key[0]}-${action}`, result.pid || null);
  return result;
}

// Antes de cifrar o bloquear se relee la lista de discos (no se usa la de la
// pantalla, que puede estar vieja si se cambió un disco) y se comprueba que la
// letra sigue siendo el volumen elegido y que no está en el disco del sistema.
// El ayudante elevado repite la comprobación justo antes de actuar.
async function assertBitLockerTarget(driveRoot, volumeId) {
  const key = await assertDestRoot(driveRoot);
  const check = checkBitLockerTarget(await refreshDrives(), key[0], volumeId);
  if (!check.ok) throw new Error(check.error);
  return key;
}

// Lanza el ayudante elevado. La promesa se resuelve cuando el usuario responde
// el aviso de UAC; el resto (contraseña, clave de recuperación, progreso) se
// sigue con encryption:job-status.
ipcMain.handle("encryption:encrypt", async (_event, driveRoot, options = {}) => {
  const key = await assertBitLockerTarget(driveRoot, options.volumeId);
  const status = await getEncryptionStatus(key);
  if (!status.canEncrypt) {
    throw new Error("Esta edición de Windows no puede cifrar discos con BitLocker (sí puede abrir discos ya cifrados).");
  }
  if (status.state !== "off") throw new Error("Este disco ya tiene BitLocker configurado.");
  return launchHelper("Encrypt", key, { fullDisk: !!options.fullDisk, volumeId: options.volumeId });
});

ipcMain.handle("encryption:lock", async (_event, driveRoot, volumeId) => {
  const key = await assertBitLockerTarget(driveRoot, volumeId);
  const status = await getEncryptionStatus(key);
  if (status.state !== "on") throw new Error("Sólo se puede bloquear un disco cifrado y desbloqueado.");
  return launchHelper("Lock", key, { volumeId });
});

// { status: JSON del ayudante o null, alive: true | false | null (desconocido) }
ipcMain.handle("encryption:job-status", async (_event, driveRoot, action) => {
  const key = await assertDestRoot(driveRoot);
  if (action !== "Encrypt" && action !== "Lock") throw new Error("Acción no válida.");
  return {
    status: readHelperStatus(helperStatusPath(key[0], action)),
    alive: isProcessAlive(helperPids.get(`${key[0]}-${action}`)),
  };
});

// Desbloquear no necesita administrador: abre el cuadro de contraseña de
// Windows y devuelve el estado real al cerrarlo.
ipcMain.handle("encryption:unlock", async (_event, driveRoot) => {
  const key = await assertDestRoot(driveRoot);
  await unlockWithWindowsPrompt(key);
  return getEncryptionStatus(key);
});

// --- Copia de backup --------------------------------------------------------

function describeCopyError(err, relativeDest) {
  switch (err.code) {
    case "ENOSPC":
      return "No hay espacio en el disco destino.";
    case "EACCES":
    case "EPERM":
      return "Sin permiso para leer o escribir: " + relativeDest;
    case "EBUSY":
      return "Archivo en uso por otro programa (ciérralo y vuelve a intentar).";
    case "ENOENT":
      return "El archivo ya no existe en el origen.";
    case "ENAMETOOLONG":
      return "La ruta es demasiado larga para el disco destino.";
    default:
      return err.message;
  }
}

ipcMain.handle("backup:copy-files", async (event, tasks, options = {}) => {
  if (!Array.isArray(tasks)) throw new Error("Lista de tareas no válida.");
  const total = tasks.length;
  let copied = 0;
  let deduped = 0;
  const errors = [];
  const done = [];
  if (!total) return { copied, errors, deduped, done };

  const destKey = await assertDestRoot(tasks[0].destRoot);
  await assertDestVolumeUnchanged(destKey, options.destVolumeId);

  // Se valida TODO antes de copiar nada: una tarea inválida se informa como
  // error y no se copia; las demás siguen.
  const validTasks = [];
  for (const task of tasks) {
    try {
      if ((await assertDestRoot(task.destRoot)) !== destKey) throw new Error("Tareas con distinto disco destino.");
      assertSourcePath(task.srcPath);
      assertBackupRelative(destKey, task.relativeDest);
      validTasks.push({ ...task, destRoot: destKey, dedup: !!options.dedup });
    } catch (err) {
      errors.push({ file: String(task && task.relativeDest), error: err.message });
    }
  }

  const drive = lastDrives.find((d) => driveKey(d.root) === destKey);
  const fsInfo = fileSystemInfo(drive && drive.fileSystem);
  // El índice se carga siempre (no sólo con dedup) para mantenerlo al día:
  // cada ruta sobrescrita olvida los hashes que apuntaban a ella.
  const ctx = {
    index: loadContentIndex(destKey),
    pendingWrites: new Map(),
    maxFileSize: fsInfo.maxFileSize,
  };
  const concurrency = options.concurrency > 0 ? options.concurrency : BACKUP_CONCURRENCY;
  const journalPath = startJournal(journalDir(destKey), validTasks);

  async function copyOne(task) {
    try {
      const result = await copyOneTask(task, ctx);
      if (result.dedup) deduped++;
      copied++;
      done.push({ relativeDest: task.relativeDest, hash: result.hash });
      if (journalPath) appendJournalDone(journalPath, task.relativeDest);
      if (copied % INDEX_SAVE_INTERVAL === 0) saveContentIndex(destKey, ctx.index);
      event.sender.send("progress", {
        phase: "backup",
        current: copied,
        total,
        file: task.relativeDest,
        percent: Math.round((copied / total) * 100),
      });
    } catch (err) {
      errors.push({ file: task.relativeDest, error: describeCopyError(err, task.relativeDest), code: err.code });
    }
  }

  const inFlight = new Set();
  for (const task of validTasks) {
    const p = copyOne(task);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    if (inFlight.size >= concurrency) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);

  saveContentIndex(destKey, ctx.index);

  // Con copia a temporal + rename, un error sólo puede dejar temporales: se
  // limpian ahora mismo y el journal ya no hace falta.
  if (journalPath) {
    checkJournals(journalDir(destKey), destKey);
    finishJournal(journalPath);
  }

  return { copied, errors, deduped, done };
});

// --- Copia de versiones anteriores (comprimidas con gzip) ------------------

// Guarda la versión ANTERIOR de cada archivo cambiado: se llama antes de
// sobrescribir el backup, comprimiendo el archivo que está por reemplazarse.
// Igual que backup:copy-files, se planifica en el journal: sin esto, un corte
// a mitad de escribir una versión dejaba un ".kopia-tmp" que journal:peek/
// journal:check nunca veían (no está en la carpeta de backup normal) y
// quedaba huérfano para siempre.
ipcMain.handle("backup:copy-versions", async (_event, tasks, options = {}) => {
  if (!Array.isArray(tasks)) throw new Error("Lista de tareas no válida.");
  const errors = [];
  if (!tasks.length) return { copied: 0, skipped: 0, errors };

  const destKey = await assertDestRoot(tasks[0].destRoot);
  await assertDestVolumeUnchanged(destKey, options.destVolumeId);
  const validTasks = [];
  for (const task of tasks) {
    try {
      if ((await assertDestRoot(task.destRoot)) !== destKey) throw new Error("Tareas con distinto disco destino.");
      assertInsideBackup(task.srcPath);
      const target = assertBackupRelative(destKey, task.relativeDest + ".gz", path.join(METADATA_DIR, "versions"));
      validTasks.push({ ...task, target, journalRelative: path.relative(destKey, target) });
    } catch (err) {
      errors.push({ file: String(task && task.relativeDest), error: err.message });
    }
  }

  // El manifiesto conocía el archivo pero ya no está en el backup (p. ej. se
  // movió a mano): no hay versión previa que preservar. No entra al journal
  // porque nunca se va a escribir nada para él.
  const writableTasks = [];
  let skipped = 0;
  for (const task of validTasks) {
    if (fs.existsSync(task.srcPath)) writableTasks.push(task);
    else skipped++;
  }

  const journalPath = startJournal(
    journalDir(destKey),
    writableTasks.map((t) => ({ relativeDest: t.journalRelative }))
  );

  let copied = 0;
  for (const task of writableTasks) {
    try {
      await writeVersionAtomic(task.srcPath, task.target);
      copied++;
      if (journalPath) appendJournalDone(journalPath, task.journalRelative);
    } catch (err) {
      errors.push({ file: String(task.relativeDest), error: err.message });
    }
  }

  if (journalPath) {
    checkJournals(journalDir(destKey), destKey);
    finishJournal(journalPath);
  }

  return { copied, skipped, errors };
});

ipcMain.handle("log:save", async (_event, destRoot, sourceName, report) => {
  const key = await assertDestRoot(destRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(metadataDir(key), "logs", `${safeName(sourceName)}_${stamp}.json`);
  atomicWriteFileSync(logPath, JSON.stringify(report, null, 2));
  return logPath;
});

function readManifestForRestore(destKey, sourceName) {
  const manifestPath = manifestFilePath(destKey, sourceName);
  if (!fs.existsSync(manifestPath)) {
    throw new Error("No se encontró manifiesto de backup para: " + sourceName);
  }
  if (fs.statSync(manifestPath).size > 50 * 1024 * 1024) {
    throw new Error("El manifiesto es demasiado grande (posible corrupción).");
  }
  const { manifest, warning } = loadManifestWithFallback(destKey, sourceName);
  if (warning && !Object.keys(manifest).length) throw new Error(warning);
  return { manifest, warning };
}

ipcMain.handle("restore:scan", async (event, backupDrive, sourceName, localFolderPath) => {
  const key = await assertDestRoot(backupDrive);
  if (!insideAny(allowed.sources, localFolderPath) && !insideAny(allowed.comparePaths, localFolderPath)) {
    throw new Error("Carpeta local no autorizada: " + localFolderPath);
  }
  const { manifest, warning } = readManifestForRestore(key, sourceName);

  const backupDir = path.join(key, BACKUP_ROOT, safeName(sourceName));
  const localFiles = await scanDirectoryRecursive(localFolderPath, "", compileExcludePatterns(DEFAULT_EXCLUDES));
  const missing = [];
  const lostFromBackup = [];
  const total = Object.keys(manifest).length;
  let checked = 0;

  for (const [relativePath, fileInfo] of Object.entries(manifest)) {
    checked++;
    // Si el manifiesto fue manipulado (o quedó corrupto de un modo que
    // igual parsea como JSON válido), una clave como "../../secreto" no debe
    // usarse para mirar fuera de la carpeta del backup ni para filtrar si
    // algo existe en el resto del disco. Se trata igual que "no está en el
    // backup": no se puede restaurar de forma segura desde acá.
    let backupFilePath;
    try {
      backupFilePath = safePath(backupDir, relativePath);
    } catch {
      lostFromBackup.push({ ...fileInfo, path: relativePath });
      continue;
    }
    const existsInLocal = localFiles[relativePath] != null;
    const existsInBackup = fs.existsSync(backupFilePath);

    if (!existsInLocal && existsInBackup) {
      missing.push({ ...fileInfo, backupFullPath: backupFilePath });
    }

    // El manifiesto dice que está respaldado, pero el archivo ya no está en el
    // disco de backup (borrado manual, disco dañado, etc.). Si no se reporta,
    // el próximo escaneo de backup tampoco lo recopiaría — quedaría perdido.
    if (!existsInBackup) {
      lostFromBackup.push({ ...fileInfo, path: relativePath });
    }

    if (checked % 50 === 0) {
      event.sender.send("progress", {
        phase: "restore-scan",
        current: checked,
        total,
        file: relativePath,
        percent: Math.round((checked / total) * 100),
      });
    }
  }

  return { missing, lostFromBackup, totalChecked: total, warning };
});

ipcMain.handle("restore:copy-files", async (event, files, targetDir, options = {}) => {
  if (!Array.isArray(files)) throw new Error("Lista de archivos no válida.");
  if (!insideAny(allowed.restoreTargets, targetDir)) {
    throw new Error("Carpeta de restauración no autorizada: " + targetDir);
  }
  const total = files.length;
  let copied = 0;
  const errors = [];

  async function restoreOne(file) {
    try {
      assertInsideBackup(file.backupFullPath);
      const dest = safePath(targetDir, file.path);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      // Misma copia verificada que el backup, más el chequeo contra el hash
      // del manifiesto (ver comentario de restoreFileVerified en core.js).
      await restoreFileVerified(file.backupFullPath, dest, file.hash);
      copied++;
      event.sender.send("progress", {
        phase: "restore",
        current: copied,
        total,
        file: file.path,
        percent: Math.round((copied / total) * 100),
      });
    } catch (err) {
      errors.push({ file: String(file && file.path), error: describeCopyError(err, String(file && file.path)) });
    }
  }

  const concurrency = options.concurrency > 0 ? options.concurrency : BACKUP_CONCURRENCY;
  const inFlight = new Set();
  for (const file of files) {
    const p = restoreOne(file);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    if (inFlight.size >= concurrency) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);

  return { copied, errors };
});

ipcMain.handle("restore:list-sources", async (_event, backupDrive) => {
  const key = await assertDestRoot(backupDrive);
  const mDir = manifestDir(key);
  if (!fs.existsSync(mDir)) return [];
  return fs
    .readdirSync(mDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".prev.json"))
    .map((f) => f.replace(/\.json$/, ""));
});

// Lista TODO el contenido de una carpeta del backup (no sólo lo que falte
// contra una carpeta local), para poder restaurarla completa a cualquier
// destino que el usuario elija — útil cuando la carpeta/usuario original ya
// no existe (PC formateado, perfil de usuario distinto, etc.).
ipcMain.handle("restore:full-list", async (_event, backupDrive, sourceName) => {
  const key = await assertDestRoot(backupDrive);
  const { manifest } = readManifestForRestore(key, sourceName);
  const backupDir = path.join(key, BACKUP_ROOT, safeName(sourceName));
  const result = [];
  for (const [relativePath, fileInfo] of Object.entries(manifest)) {
    // Mismo motivo que en restore:scan: una clave de manifiesto manipulada no
    // debe poder resolverse a una ruta fuera de la carpeta del backup, ni
    // siquiera para listarla (restore:copy-files la rechazaría igual al
    // restaurar, pero no hace falta ofrecerla como si fuera válida).
    let backupFullPath;
    try {
      backupFullPath = safePath(backupDir, relativePath);
    } catch {
      continue;
    }
    result.push({ ...fileInfo, path: relativePath, backupFullPath });
  }
  return result;
});

function settingsPath() {
  return path.join(app.getPath("userData"), "kopia-desk-settings.json");
}

ipcMain.handle("settings:load", async () => {
  const loaded = readJsonWithFallback(settingsPath(), null);
  const settings = loaded.data;
  // La configuración sólo se guarda con orígenes ya autorizados (ver
  // settings:save), así que los orígenes recordados vuelven a permitirse.
  if (Array.isArray(settings.sources)) {
    settings.sources.forEach((s) => s && allowSource(s.path));
  }
  // Auditoría: un settings.json dañado antes se volvía {} en silencio (se
  // perdían orígenes recordados y preferencias sin avisar). No es un campo
  // real de la configuración (empieza con "__" y saveState() siempre arma un
  // objeto nuevo al guardar, así que nunca se persiste de vuelta).
  if (loaded.source === "corrupt") settings.__corrupt = true;
  return settings;
});

ipcMain.handle("settings:save", async (_event, settings) => {
  if (typeof settings !== "object" || settings === null) throw new Error("Configuración no válida.");
  const clean = { ...settings };
  if (Array.isArray(clean.sources)) {
    clean.sources = clean.sources.filter(
      (s) => s && typeof s.path === "string" && allowed.sources.has(pathKey(s.path))
    );
  }
  atomicWriteFileSync(settingsPath(), JSON.stringify(clean, null, 2));
  return { ok: true };
});
