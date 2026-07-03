"use strict";

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const {
  DEFAULT_EXCLUDES,
  safeName,
  safePath,
  compileExcludePatterns,
  scanDirectoryRecursive,
  hashFileAsync,
  quickHashFile,
  listDrives,
  detectDriveType,
  pickConcurrency,
  hideFolder,
  startJournal,
  appendJournalDone,
  finishJournal,
  peekJournals,
  checkJournals,
} = require("./lib/core.js");

const BACKUP_ROOT = "KopiaDesk_Backup";
const METADATA_DIR = ".kopia-data";
const BACKUP_CONCURRENCY = 3;

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
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: "Kopia Desk",
    icon: path.join(__dirname, "assets", "Kopia_Desk.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

ipcMain.handle("drives:list", () => listDrives());

ipcMain.handle("dialog:select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Seleccionar carpeta de origen",
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:select-restore-target", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Seleccionar carpeta destino para restaurar",
  });
  if (result.canceled || !result.filePaths.length) return null;
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

ipcMain.handle("fs:scan-directory", (event, dirPath, excludePatterns) => {
  if (!fs.existsSync(dirPath)) throw new Error("La carpeta no existe: " + dirPath);
  const patterns = Array.isArray(excludePatterns) && excludePatterns.length ? excludePatterns : DEFAULT_EXCLUDES;
  return scanDirectoryRecursive(dirPath, "", compileExcludePatterns(patterns));
});

// --- Hashing -------------------------------------------------------------

ipcMain.handle("fs:hash-file", async (_event, filePath) => hashFileAsync(filePath));

ipcMain.handle("fs:quick-hash", (_event, filePath, size) => quickHashFile(filePath, size));

function manifestDir(destRoot) {
  return path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "manifests");
}

function manifestFilePath(destRoot, sourceName) {
  return path.join(manifestDir(destRoot), safeName(sourceName) + ".json");
}

ipcMain.handle("manifest:load", async (_event, destRoot, sourceName) => {
  const fp = manifestFilePath(destRoot, sourceName);
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return {};
  }
});

ipcMain.handle("manifest:save", async (_event, destRoot, sourceName, manifest) => {
  const fp = manifestFilePath(destRoot, sourceName);
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(fp)) {
    const prevPath = fp.replace(/\.json$/, ".prev.json");
    fs.copyFileSync(fp, prevPath);
  }

  fs.writeFileSync(fp, JSON.stringify(manifest, null, 2), "utf-8");
  await hideFolder(path.join(destRoot, BACKUP_ROOT, METADATA_DIR));
  return { ok: true };
});

// --- Origen recordado por carpeta (para restaurar sin volver a preguntar) ---

function sourcesMapPath(destRoot) {
  return path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "sources.json");
}

ipcMain.handle("sources:remember", async (_event, destRoot, sourceName, sourcePath) => {
  const fp = sourcesMapPath(destRoot);
  let map = {};
  if (fs.existsSync(fp)) {
    try {
      map = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      map = {};
    }
  }
  map[sourceName] = sourcePath;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(map, null, 2), "utf-8");
  return { ok: true };
});

ipcMain.handle("sources:known-paths", async (_event, destRoot) => {
  const fp = sourcesMapPath(destRoot);
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return {};
  }
});

// --- Deduplicación por contenido (hardlinks) -------------------------------

function contentIndexPath(destRoot) {
  return path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "content-index.json");
}

function loadContentIndex(destRoot) {
  const fp = contentIndexPath(destRoot);
  if (!fs.existsSync(fp)) return new Map();
  try {
    const obj = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveContentIndex(destRoot, indexMap) {
  const fp = contentIndexPath(destRoot);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(Object.fromEntries(indexMap), null, 2), "utf-8");
}

async function linkTo(existingAbsolute, target) {
  if (!fs.existsSync(existingAbsolute)) return false;
  try {
    await fs.promises.unlink(target).catch(() => {});
    await fs.promises.link(existingAbsolute, target);
    return true;
  } catch {
    return false; // p. ej. límite de hardlinks: se copia normal como respaldo
  }
}

async function copyOneTask(task, dedupIndex, pendingWrites) {
  const target = safePath(task.destRoot, task.relativeDest);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  let contentHash = null;
  let resolvePending = null;
  if (task.dedup) {
    contentHash = await hashFileAsync(task.srcPath);

    const existingRelative = dedupIndex.get(contentHash);
    if (existingRelative && (await linkTo(path.join(task.destRoot, existingRelative), target))) {
      return { dedup: true };
    }

    // Sección crítica síncrona (sin await entre get/set): si dos tareas de este
    // mismo lote comparten contenido, sólo la primera copia de verdad; la(s)
    // siguiente(s) esperan su resultado y enlazan, en vez de copiar ambas a la vez.
    const pending = pendingWrites.get(contentHash);
    if (pending) {
      const firstRelative = await pending;
      if (firstRelative && (await linkTo(path.join(task.destRoot, firstRelative), target))) {
        return { dedup: true };
      }
    } else {
      let resolveFirst;
      pendingWrites.set(contentHash, new Promise((resolve) => (resolveFirst = resolve)));
      resolvePending = resolveFirst;
    }
  }

  try {
    await fs.promises.copyFile(task.srcPath, target);
  } catch (err) {
    // Si la copia "titular" falla, se libera a quienes esperaban enlazarse a
    // ella (null = "no hay nada que enlazar"), para que copien por su cuenta
    // en vez de quedarse esperando una promesa que nunca se resolvería.
    if (resolvePending) resolvePending(null);
    throw err;
  }

  if (task.dedup && contentHash) {
    const relative = path.relative(task.destRoot, target);
    if (!dedupIndex.has(contentHash)) dedupIndex.set(contentHash, relative);
    if (resolvePending) resolvePending(relative);
  }
  return { dedup: false };
}

// --- Journal de operaciones (detecta/limpia backups interrumpidos) ---------
// La lógica vive en lib/core.js (append-only, testeable); acá sólo se resuelve
// la carpeta donde se guarda dentro del disco destino.

function journalDir(destRoot) {
  return path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "journal");
}

// Peek: sólo informa si hay un backup interrumpido, sin tocar archivos. La
// limpieza real (journal:check) se dispara cuando el usuario la confirma.
ipcMain.handle("journal:peek", async (_event, destRoot) => {
  return peekJournals(journalDir(destRoot));
});

ipcMain.handle("journal:check", async (_event, destRoot) => {
  return checkJournals(journalDir(destRoot), destRoot);
});

// --- Detección de tipo de disco (para concurrencia adaptativa) ------------

ipcMain.handle("backup:plan-concurrency", async (_event, driveRoot, avgFileSize) => {
  const driveInfo = await detectDriveType(driveRoot);
  return { concurrency: pickConcurrency(driveInfo, avgFileSize), driveInfo };
});

// --- Copia de backup --------------------------------------------------------

ipcMain.handle("backup:copy-files", async (event, tasks, options = {}) => {
  const total = tasks.length;
  let copied = 0;
  let deduped = 0;
  const errors = [];

  const destRoot = tasks.length ? tasks[0].destRoot : null;
  const dedupIndex = options.dedup && destRoot ? loadContentIndex(destRoot) : null;
  const pendingWrites = options.dedup ? new Map() : null;
  const concurrency = options.concurrency > 0 ? options.concurrency : BACKUP_CONCURRENCY;

  const journalPath = destRoot ? startJournal(journalDir(destRoot), tasks) : null;

  async function copyOne(task) {
    try {
      const result = await copyOneTask({ ...task, dedup: options.dedup }, dedupIndex, pendingWrites);
      if (result.dedup) deduped++;
      copied++;
      if (journalPath) appendJournalDone(journalPath, task.relativeDest);
      event.sender.send("progress", {
        phase: "backup",
        current: copied,
        total,
        file: task.relativeDest,
        percent: Math.round((copied / total) * 100),
      });
    } catch (err) {
      let message = err.message;
      if (err.code === "ENOSPC") message = "No hay espacio en el disco destino.";
      if (err.code === "EACCES") message = "Sin permiso para escribir: " + task.relativeDest;
      errors.push({ file: task.relativeDest, error: message });
    }
  }

  const inFlight = new Set();
  for (const task of tasks) {
    const p = copyOne(task);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    if (inFlight.size >= concurrency) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);

  if (dedupIndex) saveContentIndex(destRoot, dedupIndex);

  // Sin errores, el journal ya cumplió; con errores se conserva para que el
  // próximo journal:check limpie los archivos que quedaron a medias.
  if (journalPath && errors.length === 0) finishJournal(journalPath);

  return { copied, errors, deduped };
});

// --- Copia de versiones anteriores (comprimidas con gzip) ------------------

function writeVersionStream(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
    } catch (err) {
      return reject(err);
    }
    const gzip = zlib.createGzip();
    const input = fs.createReadStream(srcPath);
    const out = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    input.on("error", fail);
    gzip.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    input.pipe(gzip).pipe(out);
  });
}

// Guarda la versión ANTERIOR de cada archivo cambiado: se llama antes de
// sobrescribir el backup, comprimiendo el archivo que está por reemplazarse.
ipcMain.handle("backup:copy-versions", async (_event, tasks) => {
  let copied = 0;
  let skipped = 0;
  const errors = [];

  for (const task of tasks) {
    try {
      if (!fs.existsSync(task.srcPath)) {
        // El manifiesto lo conocía pero el backup no lo tiene (p. ej. backup
        // viejo movido a mano): no hay versión previa que preservar.
        skipped++;
        continue;
      }
      const target = safePath(task.destRoot, task.relativeDest + ".gz");
      await writeVersionStream(task.srcPath, target);
      copied++;
    } catch (err) {
      errors.push({ file: task.relativeDest, error: err.message });
    }
  }
  return { copied, skipped, errors };
});

ipcMain.handle("log:save", async (_event, destRoot, sourceName, report) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = path.join(destRoot, BACKUP_ROOT, METADATA_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${safeName(sourceName)}_${stamp}.json`);
  fs.writeFileSync(logPath, JSON.stringify(report, null, 2), "utf-8");
  return logPath;
});

ipcMain.handle("restore:scan", async (event, backupDrive, sourceName, localFolderPath) => {
  const manifestPath = manifestFilePath(backupDrive, sourceName);
  if (!fs.existsSync(manifestPath)) {
    throw new Error("No se encontró manifiesto de backup para: " + sourceName);
  }

  const rawManifest = fs.readFileSync(manifestPath, "utf-8");
  if (rawManifest.length > 50 * 1024 * 1024) {
    throw new Error("El manifiesto es demasiado grande (posible corrupción).");
  }
  const manifest = JSON.parse(rawManifest);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("Manifiesto con formato inválido.");
  }

  const backupDir = path.join(backupDrive, BACKUP_ROOT, safeName(sourceName));
  const localFiles = await scanDirectoryRecursive(localFolderPath, "", compileExcludePatterns(DEFAULT_EXCLUDES));
  const missing = [];
  const lostFromBackup = [];
  const total = Object.keys(manifest).length;
  let checked = 0;

  for (const [relativePath, fileInfo] of Object.entries(manifest)) {
    checked++;
    const backupFilePath = path.join(backupDir, relativePath);
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

  return { missing, lostFromBackup, totalChecked: total };
});

ipcMain.handle("restore:copy-files", async (event, files, targetDir, options = {}) => {
  const total = files.length;
  let copied = 0;
  const errors = [];

  async function restoreOne(file) {
    try {
      const dest = safePath(targetDir, file.path);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(file.backupFullPath, dest);
      copied++;
      event.sender.send("progress", {
        phase: "restore",
        current: copied,
        total,
        file: file.path,
        percent: Math.round((copied / total) * 100),
      });
    } catch (err) {
      errors.push({ file: file.path, error: err.message });
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
  const mDir = manifestDir(backupDrive);
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
  const manifestPath = manifestFilePath(backupDrive, sourceName);
  if (!fs.existsSync(manifestPath)) {
    throw new Error("No se encontró manifiesto de backup para: " + sourceName);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const backupDir = path.join(backupDrive, BACKUP_ROOT, safeName(sourceName));
  return Object.entries(manifest).map(([relativePath, fileInfo]) => ({
    ...fileInfo,
    backupFullPath: path.join(backupDir, relativePath),
  }));
});

function settingsPath() {
  return path.join(app.getPath("userData"), "kopia-desk-settings.json");
}

ipcMain.handle("settings:load", async () => {
  const fp = settingsPath();
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return {};
  }
});

ipcMain.handle("settings:save", async (_event, settings) => {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf-8");
  return { ok: true };
});
