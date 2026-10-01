"use strict";

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, screen, shell, Tray, Menu, nativeImage, Notification } = require("electron");
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
  compileExcludes,
  summarizeLastBackup,
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
  stopPowerShellWorker,
  fileSystemInfo,
  checkDriveTarget,
  driveIdentityChanged,
  validateNewPassword,
  ejectScriptPath,
  ejectDrive,
  detectDriveType,
  pickConcurrency,
  hideFolder,
  startJournal,
  createJournalWriter,
  ensureDir,
  runTasks,
  pickRestoreConcurrency,
  finishJournal,
  peekJournals,
  checkJournals,
  restoreEncryptedVerified,
  preserveEncryptedVersion,
} = require("./lib/core.js");
const almacen = require("./lib/almacen.js");

const METADATA_DIR = ".kiopia-data";
const BACKUP_CONCURRENCY = 3;
// content-index.json también se guarda cada tantos archivos copiados, no sólo
// al final del lote: si el proceso se corta a mitad de un backup grande, los
// archivos ya copiados y journalados quedan completos igual, pero sin este
// guardado periódico el índice en disco no se enteraba de ellos y se perdía
// la oportunidad de deduplicarlos la próxima vez (no se pierde nada, sólo se
// vuelve a copiar en vez de enlazar). Se guarda por tiempo y no cada N
// archivos: con muchos archivos pequeños, reescribir el índice entero con
// fsync cada 25 archivos pesaba en la USB.
const INDEX_SAVE_INTERVAL_MS = 30 * 1000;
// El progreso se manda a la interfaz como mucho cada tanto (y siempre el último).
const PROGRESS_INTERVAL_MS = 100;

// Avisa el progreso limitado en el tiempo: con miles de archivos pequeños, un
// mensaje por archivo sólo carga la interfaz. "bytes" son los bytes ya copiados
// en esta llamada (la interfaz calcula con ellos el tiempo que falta).
function progressSender(event, phase, total) {
  let last = 0;
  let pending = null; // el último aviso que se saltó por el límite de tiempo
  const send = (current, file, bytes) => {
    last = Date.now();
    pending = null;
    event.sender.send("progress", { phase, current, total, file, bytes, percent: Math.round((current / total) * 100) });
  };
  const progress = (current, file, bytes = 0) => {
    if (current < total && Date.now() - last < PROGRESS_INTERVAL_MS) {
      pending = [current, file, bytes];
      return;
    }
    send(current, file, bytes);
  };
  // Al terminar: si algún archivo falló, "current" nunca llega a "total" y el
  // último aviso pudo quedar sin enviar; se envía ahora.
  progress.flush = () => {
    if (pending) send(pending[0], pending[1], pending[2]);
  };
  return progress;
}

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
    title: "Kiopia Desk v4",
    icon: path.join(__dirname, "assets", "Kiopia_Desk_icon.png"),
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
  mainWindow.on("close", onWindowClose);
  // Apagar o cerrar sesión en Windows: se cierra sin preguntar.
  mainWindow.on("session-end", () => {
    quitting = true;
  });

  watchDriveChanges(mainWindow);
}

// --- Segundo plano -----------------------------------------------------------------
// Con la X, la app pregunta si cerrar o seguir en segundo plano (con un icono
// junto al reloj de Windows), para que cerrarla sin querer no corte una copia.
// La elección se puede recordar y cambiar después en Opciones. Se guarda en su
// propio archivo: la configuración de la interfaz se reescribe entera al guardar.

let quitting = false;
let tray = null;
let rendererBusy = false;
let cancelAllCopies = false;
const CLOSE_ACTIONS = new Set(["ask", "background", "quit"]);

function windowPrefsPath() {
  return path.join(app.getPath("userData"), "kopia-desk-window.json");
}

function getCloseAction() {
  const { data } = readJsonWithFallback(windowPrefsPath(), null);
  return data && CLOSE_ACTIONS.has(data.closeAction) ? data.closeAction : "ask";
}

function setCloseAction(action) {
  if (!CLOSE_ACTIONS.has(action)) return;
  atomicWriteFileSync(windowPrefsPath(), JSON.stringify({ closeAction: action }, null, 2));
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray() {
  if (tray) return tray;
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "Kiopia_Desk_icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Kiopia Desk v4");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir Kiopia Desk", click: showMainWindow },
      { type: "separator" },
      { label: "Salir", click: () => quitApp() },
    ])
  );
  tray.on("click", showMainWindow);
  return tray;
}

function hideToBackground(firstTime) {
  if (!mainWindow) return;
  ensureTray();
  mainWindow.hide();
  if (firstTime && Notification.isSupported()) {
    new Notification({
      title: "Kiopia Desk sigue abierta",
      body: "Está en segundo plano, junto al reloj de Windows. Haz clic en su icono para volver.",
      icon: path.join(__dirname, "assets", "Kiopia_Desk_icon.png"),
    }).show();
  }
}

// Cerrar de verdad. Si hay una copia en curso se detiene como con el botón
// Detener (termina y verifica el archivo en curso, guarda lo copiado) y se
// espera a que la interfaz lo confirme, hasta un minuto.
async function quitApp() {
  if (quitting) return;
  if (rendererBusy && mainWindow) {
    cancelAllCopies = true;
    showMainWindow();
    mainWindow.webContents.send("app:stopping-for-quit");
    const deadline = Date.now() + 60000;
    while (rendererBusy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  }
  quitting = true;
  if (tray) tray.destroy();
  tray = null;
  app.quit();
}

let backgroundHintShown = false;

async function onWindowClose(event) {
  if (quitting) return;
  event.preventDefault();
  let action = getCloseAction();
  if (action === "ask") {
    const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "Cerrar Kiopia Desk",
      message: "¿Cerrar Kiopia Desk o dejarla en segundo plano?",
      detail: rendererBusy
        ? "Hay una copia en curso. En segundo plano sigue copiando. Si la cierras, la copia se detiene: lo ya copiado queda guardado y verificado, y el resto se copia en el próximo backup."
        : "En segundo plano sigue abierta junto al reloj de Windows (haz clic en su icono para volver).",
      buttons: ["Seguir en segundo plano", "Cerrar Kiopia Desk", "Cancelar"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      checkboxLabel: "Recordar mi elección (se puede cambiar en Opciones)",
      checkboxChecked: false,
    });
    if (response === 2) return;
    action = response === 0 ? "background" : "quit";
    if (checkboxChecked) {
      setCloseAction(action);
      if (mainWindow) mainWindow.webContents.send("window:close-action", action);
    }
  }
  if (action === "background") {
    hideToBackground(!backgroundHintShown);
    backgroundHintShown = true;
  } else {
    quitApp();
  }
}

ipcMain.handle("app:busy", (_event, busy) => {
  rendererBusy = !!busy;
  if (!rendererBusy) cancelAllCopies = false;
  if (tray) tray.setToolTip(rendererBusy ? "Kiopia Desk v4 — trabajando…" : "Kiopia Desk v4");
});

// Aviso de Windows (sólo si la ventana no está a la vista): p. ej. copia terminada.
ipcMain.handle("app:notify", (_event, title, body) => {
  if (!mainWindow || (mainWindow.isVisible() && mainWindow.isFocused())) return false;
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: String(title).slice(0, 120),
    body: String(body).slice(0, 400),
    icon: path.join(__dirname, "assets", "Kiopia_Desk_icon.png"),
  });
  n.on("click", showMainWindow);
  n.show();
  return true;
});

ipcMain.handle("app:get-close-action", () => getCloseAction());
ipcMain.handle("app:set-close-action", (_event, action) => {
  setCloseAction(action);
  return getCloseAction();
});

// Conectar o quitar una USB: Windows avisa a todas las ventanas con
// WM_DEVICECHANGE. Se escucha ese aviso en vez de consultar los discos cada
// pocos segundos. No siempre llega DBT_DEVICEARRIVAL (al montar un disco
// virtual sólo llega DBT_DEVNODES_CHANGED), así que se atienden los tres; y
// como DBT_DEVNODES_CHANGED también llega por cualquier otro dispositivo, antes
// de avisar a la interfaz se comprueba que la lista de discos (letra e
// identidad de volumen) cambió de verdad. Si la letra todavía no está asignada,
// se vuelve a mirar una vez un poco después.
const WM_DEVICECHANGE = 0x0219;
const DBT_DEVNODES_CHANGED = 0x0007;
const DBT_DEVICEARRIVAL = 0x8000;
const DBT_DEVICEREMOVECOMPLETE = 0x8004;
const DRIVE_EVENTS = new Set([DBT_DEVNODES_CHANGED, DBT_DEVICEARRIVAL, DBT_DEVICEREMOVECOMPLETE]);
const DRIVE_CHANGE_DEBOUNCE_MS = 1200;
const DRIVE_CHANGE_RECHECK_MS = 2500;

function driveSignature(drives) {
  return drives
    .map((d) => d.root + "|" + (d.volumeId || ""))
    .sort()
    .join(";");
}

function watchDriveChanges(win) {
  if (process.platform !== "win32" || typeof win.hookWindowMessage !== "function") return;
  let known = null;
  let timer = null;
  let checking = false;
  let again = false;

  const check = async (recheck) => {
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    try {
      const signature = driveSignature(await listDrives());
      // Si la lista inicial no se pudo leer (known === null), un aviso de Windows
      // cuenta como cambio: mejor recargar de más que no mostrar la USB nueva.
      if (known === null ? recheck : signature !== known) {
        known = signature;
        if (!win.isDestroyed()) win.webContents.send("drives:changed");
      } else {
        known = signature;
        if (recheck) timer = setTimeout(() => check(false), DRIVE_CHANGE_RECHECK_MS);
      }
    } catch {
      // no se pudo leer la lista: el próximo aviso lo vuelve a intentar
    } finally {
      checking = false;
      if (again) {
        again = false;
        check(true);
      }
    }
  };

  check(false); // estado inicial, para comparar
  win.hookWindowMessage(WM_DEVICECHANGE, (wParam) => {
    const event = wParam.length >= 8 ? Number(wParam.readBigUInt64LE(0)) : wParam.readUInt32LE(0);
    if (!DRIVE_EVENTS.has(event)) return;
    clearTimeout(timer);
    timer = setTimeout(() => check(true), DRIVE_CHANGE_DEBOUNCE_MS);
  });
}

// Instancia única: dos Kiopia Desk abiertas a la vez escribirían sobre los
// mismos manifiestos, índice y configuración y podrían pisarse. Si ya hay una,
// esta se cierra y se trae al frente la ventana existente.
// Hasta la v2 el ayudante de BitLocker dejaba en los datos de la app archivos
// de estado (y, un momento, la contraseña protegida con DPAPI). La v3 ya no usa
// BitLocker: se borra esa carpeta al arrancar.
function removeOldBitLockerFiles() {
  try {
    fs.rmSync(path.join(app.getPath("userData"), "bitlocker"), { recursive: true, force: true });
  } catch {
    // se reintenta al próximo arranque
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Abrirla otra vez (también si estaba en segundo plano) trae la ventana.
  app.on("second-instance", showMainWindow);
  app.whenReady().then(() => {
    // El PowerShell de consultas arranca y hace la primera lista de discos
    // mientras se abre la ventana (antes la interfaz esperaba ~2 s por ella).
    startupDrives = refreshDrives();
    removeOldBitLockerFiles();
    createWindow();
  });
  // Salir por otra vía (p. ej. el sistema): no volver a preguntar.
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    stopPowerShellWorker();
  });
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
//   - rutas del backup dentro de <disco>\KiopiaDesk_Backup.

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
  // Número de serie de cada disco según esta lista (ver assertDestVolumeUnchanged).
  await Promise.all(
    lastDrives.map(async (d) => {
      const key = driveKey(d.root);
      const serial = key && d.volumeId ? await volumeSerial(key) : null;
      if (serial !== null) verifiedSerials.set(d.volumeId, serial);
    })
  );
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
// Número de serie del volumen (fs.stat de la raíz lo da en "dev"): se lee al
// instante, sin PowerShell. Con la USB ocupada, pedir la lista de discos a
// Windows (Get-Volume) tardó hasta 28 s, y se hacía antes de cada carpeta y de
// las versiones. Ahora la comprobación completa se hace una vez por disco y,
// mientras el número de serie siga siendo el mismo, no se repite.
const verifiedSerials = new Map(); // volumeId -> número de serie confirmado

async function volumeSerial(destKey) {
  try {
    return (await fs.promises.stat(destKey)).dev;
  } catch {
    return null;
  }
}

async function assertDestVolumeUnchanged(destKey, expectedVolumeId) {
  if (!expectedVolumeId) return;
  const serial = await volumeSerial(destKey);
  if (serial !== null && verifiedSerials.get(expectedVolumeId) === serial) return;
  const drives = await refreshDrives();
  if (driveIdentityChanged(drives, destKey[0], expectedVolumeId)) {
    verifiedSerials.delete(expectedVolumeId);
    throw new Error(
      `El disco ${destKey} cambió desde que lo elegiste (se desconectó o se conectó otro con la misma letra). ` +
        "No se copió nada más en este lote para no mezclar dos discos distintos en el mismo backup. Volvé a elegirlo."
    );
  }
  if (serial !== null) verifiedSerials.set(expectedVolumeId, serial);
}

// A mitad de una copia grande, si el USB se desconecta del todo (no uno
// distinto con la misma letra, sino que ya no hay nada), assertDestVolumeUnchanged
// no lo nota: driveIdentityChanged no puede confirmar "cambió" cuando el disco
// ya no aparece en la lista (a propósito, ver su comentario), así que cada
// archivo pendiente fallaría uno por uno con mensajes confusos ("ya no existe en
// el origen", hablando en realidad del destino). Esto comprueba directo si la
// raíz del destino sigue respondiendo, para cortar la copia con un solo aviso claro.
async function destRootGone(destKey) {
  try {
    await fs.promises.stat(destKey);
    return false;
  } catch {
    return true;
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

// Ruta relativa al disco destino que debe quedar bajo KiopiaDesk_Backup (y,
// opcionalmente, bajo una subcarpeta concreta como .kiopia-data/versions).
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

// La primera lista de discos se pide al arrancar, en paralelo con la ventana
// (ver whenReady); la interfaz la recoge ya hecha en su primera consulta. Las
// siguientes, y todas las comprobaciones de seguridad, consultan en el momento.
let startupDrives = null;

ipcMain.handle("drives:list", async () => {
  let drives;
  if (startupDrives) {
    drives = await startupDrives.catch(() => refreshDrives());
    startupDrives = null;
  } else {
    drives = await refreshDrives();
  }
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

// Carpetas o archivos que NO se copian: sólo pueden estar dentro de una
// carpeta de origen ya elegida (y no ser la carpeta de origen entera).
ipcMain.handle("dialog:select-exclude", async (_event, kind, startPath) => {
  const folder = kind === "folder";
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: [folder ? "openDirectory" : "openFile", "multiSelections"],
    title: folder ? "Carpetas que no se copian" : "Archivos que no se copian",
    defaultPath: insideAny(allowed.sources, startPath) ? startPath : undefined,
  });
  if (result.canceled || !result.filePaths.length) return { accepted: [], rejected: [] };
  const accepted = [];
  const rejected = [];
  for (const p of result.filePaths) {
    const isSourceRoot = [...allowed.sources].some((root) => pathKey(root) === pathKey(p));
    if (insideAny(allowed.sources, p) && !isSourceRoot) accepted.push(p);
    else rejected.push(p);
  }
  return { accepted, rejected };
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

ipcMain.handle("fs:scan-directory", async (event, dirPath, excludePatterns, excludePaths) => {
  assertSourcePath(dirPath);
  if (!fs.existsSync(dirPath)) throw new Error("La carpeta no existe: " + dirPath);
  const patterns = Array.isArray(excludePatterns) && excludePatterns.length ? excludePatterns : DEFAULT_EXCLUDES;
  const report = createScanReport();
  const files = await scanDirectoryRecursive(dirPath, "", compileExcludes(dirPath, patterns, excludePaths), report);
  return { files, excluded: report.excluded, skipped: report.skipped, excludedItems: report.excludedItems };
});

// Peso de una carpeta de origen (con las mismas exclusiones que el backup),
// para mostrar al agregarla si cabe en el disco. Sólo devuelve los totales.
ipcMain.handle("fs:measure-directory", async (_event, dirPath, excludePatterns, excludePaths) => {
  assertSourcePath(dirPath);
  if (!fs.existsSync(dirPath)) throw new Error("La carpeta no existe: " + dirPath);
  const patterns = Array.isArray(excludePatterns) && excludePatterns.length ? excludePatterns : DEFAULT_EXCLUDES;
  const files = await scanDirectoryRecursive(dirPath, "", compileExcludes(dirPath, patterns, excludePaths), createScanReport());
  let bytes = 0;
  let count = 0;
  for (const f of Object.values(files)) {
    bytes += f.size || 0;
    count++;
  }
  return { bytes, files: count };
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

// --- Backup cifrado (v3) ----------------------------------------------------
// La clave maestra de cada disco abierto vive sólo en memoria, mientras la app
// esté abierta, y va atada al número de serie del volumen: si en esa letra
// aparece otro disco, hay que volver a escribir la contraseña. Todo lo demás
// (nombres opacos, manifiestos e índices cifrados) está en lib/almacen.js.

const unlockedKeys = new Map(); // destKey -> { masterKey, serial }

function cryptoLockedError(destKey) {
  const err = new Error("El backup de " + destKey + " está cifrado: hay que escribir la contraseña para abrirlo (CRYPTO_LOCKED).");
  err.code = "CRYPTO_LOCKED";
  return err;
}

// null = backup sin cifrar; la clave si está abierto; error si está cerrado.
async function destCryptoKey(destKey) {
  if (!almacen.isEncrypted(destKey)) return null;
  const entry = unlockedKeys.get(destKey);
  if (entry) {
    const serial = await volumeSerial(destKey);
    if (serial !== null && serial === entry.serial) return entry.masterKey;
    unlockedKeys.delete(destKey);
  }
  throw cryptoLockedError(destKey);
}

async function rememberKey(destKey, masterKey) {
  unlockedKeys.set(destKey, { masterKey, serial: await volumeSerial(destKey) });
}

function recoveryScriptSource() {
  return path.join(__dirname, "lib", almacen.SCRIPT_NAME).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

ipcMain.handle("crypto:status", async (_event, destRoot) => {
  const key = await assertDestRoot(destRoot);
  const encrypted = almacen.isEncrypted(key);
  // Cada vez que se elige (o vuelve) el disco: si Abrir-KiopiaDesk.cmd o el
  // script se borraron sin querer, o son de una versión vieja, se reponen.
  if (encrypted) {
    try {
      almacen.writeRecoveryTools(key, recoveryScriptSource());
    } catch {
      // disco de sólo lectura, etc.: no impide usarlo
    }
  }
  let unlocked = false;
  if (encrypted) unlocked = await destCryptoKey(key).then(() => true, () => false);
  return { encrypted, unlocked, plainBackup: !encrypted && almacen.hasPlainBackup(key) };
});

ipcMain.handle("crypto:enable", async (_event, destRoot, password) => {
  const key = await assertDestRoot(destRoot);
  const check = validateNewPassword(password);
  if (!check.ok) return { ok: false, error: check.error };
  try {
    const { masterKey, recoveryKey } = almacen.enableEncryption(key, password, { scriptSource: recoveryScriptSource() });
    await rememberKey(key, masterKey);
    await hideFolder(metadataDir(key));
    return { ok: true, recoveryKey };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

ipcMain.handle("crypto:unlock", async (_event, destRoot, secret) => {
  const key = await assertDestRoot(destRoot);
  let masterKey;
  try {
    masterKey = almacen.unlock(key, secret);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!masterKey) return { ok: false, error: "La contraseña o la clave de recuperación no es correcta." };
  await rememberKey(key, masterKey);
  // El script de recuperación del disco se pone al día con el de esta versión.
  try {
    almacen.writeRecoveryTools(key, recoveryScriptSource());
  } catch {
    // disco de sólo lectura, etc.: no impide abrirlo
  }
  return { ok: true };
});

ipcMain.handle("crypto:lock", async (_event, destRoot) => {
  const key = await assertDestRoot(destRoot);
  unlockedKeys.delete(key);
  return { ok: true };
});

ipcMain.handle("crypto:change-password", async (_event, destRoot, newPassword) => {
  const key = await assertDestRoot(destRoot);
  const masterKey = await destCryptoKey(key);
  if (!masterKey) return { ok: false, error: "Este disco no tiene un backup cifrado." };
  const check = validateNewPassword(newPassword);
  if (!check.ok) return { ok: false, error: check.error };
  almacen.changePassword(key, masterKey, newPassword);
  return { ok: true };
});

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
function loadManifestWithFallback(destRoot, sourceName, masterKey = null) {
  let result;
  if (masterKey) {
    const r = almacen.loadManifest(destRoot, masterKey, sourceName);
    result = { data: r.manifest, source: r.source };
  } else {
    const fp = manifestFilePath(destRoot, sourceName);
    result = readJsonWithFallback(fp, prevManifestPath(fp));
  }
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
  return loadManifestWithFallback(key, sourceName, await destCryptoKey(key));
});

ipcMain.handle("manifest:save", async (_event, destRoot, sourceName, manifest) => {
  const key = await assertDestRoot(destRoot);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("Manifiesto con formato inválido.");
  }
  const masterKey = await destCryptoKey(key);
  if (masterKey) {
    almacen.saveManifest(key, masterKey, sourceName, manifest);
    await hideFolder(metadataDir(key));
    return { ok: true };
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
  const masterKey = await destCryptoKey(key);
  if (masterKey) {
    const map = almacen.loadSources(key, masterKey).data;
    map[sourceName] = sourcePath;
    almacen.saveSources(key, masterKey, map);
    return { ok: true };
  }
  const fp = sourcesMapPath(key);
  const map = readJsonWithFallback(fp, null).data;
  map[sourceName] = sourcePath;
  atomicWriteFileSync(fp, JSON.stringify(map, null, 2));
  return { ok: true };
});

ipcMain.handle("sources:known-paths", async (_event, destRoot) => {
  const key = await assertDestRoot(destRoot);
  const masterKey = await destCryptoKey(key);
  const loaded = masterKey ? almacen.loadSources(key, masterKey) : readJsonWithFallback(sourcesMapPath(key), null);
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

function loadContentIndex(destRoot, masterKey = null) {
  if (masterKey) return new ContentIndex(almacen.loadIndexData(destRoot, masterKey));
  return new ContentIndex(readJsonWithFallback(contentIndexPath(destRoot), null).data);
}

function saveContentIndex(destRoot, index, masterKey = null) {
  if (masterKey) return almacen.saveIndexData(destRoot, masterKey, index);
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

// El tipo de disco (USB, SSD, HDD) no cambia mientras el volumen sigue siendo
// el mismo: se recuerda por su identidad y no se vuelve a preguntar a Windows
// cada vez que se elige el disco o antes de cada copia.
const driveTypeCache = new Map();

async function driveTypeOf(key) {
  const drive = lastDrives.find((d) => driveKey(d.root) === key);
  const id = drive && drive.volumeId;
  if (id && driveTypeCache.has(id)) return driveTypeCache.get(id);
  const info = await detectDriveType(key);
  if (id && info.busType !== "Unknown") driveTypeCache.set(id, info);
  return info;
}

// Cuántos SHA-256 calcular a la vez al escanear una carpeta de origen, según
// su disco: SSD/NVMe 4 (medido: 2,2 veces más rápido que de a uno), disco
// mecánico 1 (como antes: leer varios a la vez hace saltar el cabezal), USB o
// desconocido 2.
ipcMain.handle("fs:hash-concurrency", async (_event, sourcePath) => {
  assertSourcePath(sourcePath);
  const m = /^([A-Za-z]):/.exec(String(sourcePath));
  if (!m) return 1;
  if (!lastDrives.length) await refreshDrives();
  const info = await driveTypeOf(m[1].toUpperCase() + ":\\");
  if (info.mediaType === "SSD" || info.busType === "NVMe") return 4;
  if (info.mediaType === "HDD") return 1;
  return 2;
});

ipcMain.handle("backup:plan-concurrency", async (_event, driveRoot, avgFileSize) => {
  const key = await assertDestRoot(driveRoot);
  const driveInfo = await driveTypeOf(key);
  return { root: driveRoot, concurrency: pickConcurrency(driveInfo, avgFileSize), driveInfo };
});

// --- Expulsar el disco destino ------------------------------------------------
// Como "Quitar hardware de forma segura", sin administrador. Antes se comprueba
// con la lista de discos recién leída que la letra sigue siendo el volumen
// elegido y que no está en el disco del sistema.
const EJECT_SCRIPT = ejectScriptPath(path.join(__dirname, "lib"));

ipcMain.handle("drive:eject", async (_event, driveRoot, volumeId) => {
  const key = await assertDestRoot(driveRoot);
  const check = checkDriveTarget(await refreshDrives(), key[0], volumeId);
  if (!check.ok) {
    throw new Error(
      check.code === "system-disk"
        ? `${key[0]}: está en el disco del sistema: Kiopia Desk no lo expulsa.`
        : check.error
    );
  }
  return ejectDrive(key, EJECT_SCRIPT);
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

// Botón Detener: la interfaz manda el identificador de su copia (opId). Cada
// copia deja de empezar archivos nuevos cuando ve el suyo aquí; el que está en
// curso termina y se verifica (nunca se deja un archivo a medias en el backup).
// El identificador (y no un simple "sí/no") evita que una orden de parar que
// llega entre dos carpetas se pierda o detenga una copia posterior.
const cancelledOps = new Set();

function isCancelled(opId) {
  // Al cerrar la app con una copia en curso se detienen todas (ver quitApp).
  return cancelAllCopies || (typeof opId === "string" && cancelledOps.has(opId));
}

ipcMain.handle("copy:cancel", (_event, opId) => {
  if (typeof opId !== "string" || !opId || opId.length > 100) return false;
  if (cancelledOps.size > 200) cancelledOps.clear();
  cancelledOps.add(opId);
  return true;
});

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
  const masterKey = await destCryptoKey(destKey);

  // Se valida TODO antes de copiar nada: una tarea inválida se informa como
  // error y no se copia; las demás siguen. En un backup cifrado, la ruta que
  // pide la interfaz ("logicalDest") se cambia por su nombre opaco en datos\.
  const validTasks = [];
  for (const task of tasks) {
    try {
      if ((await assertDestRoot(task.destRoot)) !== destKey) throw new Error("Tareas con distinto disco destino.");
      assertSourcePath(task.srcPath);
      assertBackupRelative(destKey, task.relativeDest);
      let relativeDest = task.relativeDest;
      if (masterKey) {
        relativeDest = almacen.dataRelative(masterKey, task.relativeDest).relative;
        assertBackupRelative(destKey, relativeDest, almacen.DATA_DIR);
      }
      validTasks.push({ ...task, relativeDest, logicalDest: task.relativeDest, destRoot: destKey, dedup: !!options.dedup });
    } catch (err) {
      errors.push({ file: String(task && task.relativeDest), error: err.message });
    }
  }

  const drive = lastDrives.find((d) => driveKey(d.root) === destKey);
  const fsInfo = fileSystemInfo(drive && drive.fileSystem);
  // El índice se carga siempre (no sólo con dedup) para mantenerlo al día:
  // cada ruta sobrescrita olvida los hashes que apuntaban a ella.
  const ctx = {
    index: loadContentIndex(destKey, masterKey),
    pendingWrites: new Map(),
    maxFileSize: fsInfo.maxFileSize,
    madeDirs: new Set(),
    masterKey,
  };
  const concurrency = options.concurrency > 0 ? options.concurrency : BACKUP_CONCURRENCY;
  const journalPath = startJournal(journalDir(destKey), validTasks);
  const journal = createJournalWriter(journalPath);
  const progress = progressSender(event, "backup", total);
  let indexSavedAt = Date.now();
  let bytesDone = 0;
  let destinationGone = false;

  async function copyOne(task) {
    try {
      const result = await copyOneTask(task, ctx);
      if (result.dedup) deduped++;
      copied++;
      done.push({ relativeDest: task.logicalDest, hash: result.hash });
      journal.add(task.relativeDest);
      if (Date.now() - indexSavedAt >= INDEX_SAVE_INTERVAL_MS) {
        saveContentIndex(destKey, ctx.index, masterKey);
        indexSavedAt = Date.now();
      }
      bytesDone += Number.isFinite(task.size) ? task.size : 0;
      progress(copied, task.logicalDest, bytesDone);
    } catch (err) {
      errors.push({ file: task.logicalDest, error: describeCopyError(err, task.logicalDest), code: err.code });
      if (!destinationGone && (await destRootGone(destKey))) destinationGone = true;
    }
  }

  // Muchos archivos pequeños de a uno (USB): se mide si 2 a la vez va más
  // rápido en este disco y se sigue con lo mejor (ver runTasks).
  const knownSizes = validTasks.filter((t) => Number.isFinite(t.size));
  const avgSize = knownSizes.length ? knownSizes.reduce((s, t) => s + t.size, 0) / knownSizes.length : 0;
  const adaptive = concurrency === 1 && avgSize > 0 && avgSize < 2 * 1024 * 1024;
  const run = await runTasks(validTasks, copyOne, {
    concurrency,
    adaptive,
    shouldStop: () => isCancelled(options.opId) || destinationGone,
  });
  progress.flush();
  journal.flush();

  // El disco se desconectó a mitad de la copia: en vez de dejar un error por
  // cada archivo que no llegó a intentarse o falló (confusos: hablan del
  // origen cuando el problema es que el destino ya no está), un solo aviso
  // claro. Los que ya se habían copiado y verificado (`done`) siguen contando.
  if (destinationGone) {
    errors.length = 0;
    errors.push({
      file: "",
      error: "El disco de backup ya no está conectado: se detuvo la copia para no perder ni mezclar archivos. Vuelve a conectarlo y repite el backup.",
      code: "DEST_GONE",
    });
  } else {
    saveContentIndex(destKey, ctx.index, masterKey);
  }

  // Con copia a temporal + rename, un error sólo puede dejar temporales: se
  // limpian ahora mismo y el journal ya no hace falta (si el disco ya no está,
  // ni intentarlo).
  if (journalPath && !destinationGone) {
    checkJournals(journalDir(destKey), destKey);
    finishJournal(journalPath);
  }

  return {
    copied,
    errors,
    deduped,
    done,
    concurrency: run.concurrency,
    probe: run.probe,
    stopped: run.stopped || destinationGone,
    destinationGone,
  };
});

// --- Copia de versiones anteriores (comprimidas con gzip) ------------------

// Guarda la versión ANTERIOR de cada archivo cambiado: se llama antes de
// sobrescribir el backup, comprimiendo el archivo que está por reemplazarse.
// Igual que backup:copy-files, se planifica en el journal: sin esto, un corte
// a mitad de escribir una versión dejaba un ".kiopia-tmp" que journal:peek/
// journal:check nunca veían (no está en la carpeta de backup normal) y
// quedaba huérfano para siempre.
ipcMain.handle("backup:copy-versions", async (event, tasks, options = {}) => {
  if (!Array.isArray(tasks)) throw new Error("Lista de tareas no válida.");
  const errors = [];
  if (!tasks.length) return { copied: 0, skipped: 0, errors };

  const destKey = await assertDestRoot(tasks[0].destRoot);
  await assertDestVolumeUnchanged(destKey, options.destVolumeId);
  const masterKey = await destCryptoKey(destKey);
  const validTasks = [];
  for (const task of tasks) {
    try {
      if ((await assertDestRoot(task.destRoot)) !== destKey) throw new Error("Tareas con distinto disco destino.");
      assertInsideBackup(task.srcPath);
      if (masterKey) {
        // Backup cifrado: el archivo anterior ya está cifrado en datos\; se
        // enlaza (o copia) tal cual con un nombre opaco, sin comprimir.
        const srcRelative = path.relative(destKey, task.srcPath);
        const srcPath = assertBackupRelative(destKey, almacen.dataRelative(masterKey, srcRelative).relative, almacen.DATA_DIR);
        const v = almacen.versionRelative(masterKey, task.relativeDest);
        const target = assertBackupRelative(destKey, v.relative, path.join(METADATA_DIR, "versions"));
        validTasks.push({
          ...task,
          srcPath,
          target,
          stamp: v.stamp,
          logical: v.logical,
          versionRelative: v.relative,
          journalRelative: path.relative(destKey, target),
        });
        continue;
      }
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
  const journal = createJournalWriter(journalPath);

  let copied = 0;
  let stopped = false;
  let destinationGone = false;
  let bytesDone = 0;
  const saved = []; // versiones cifradas guardadas: { stamp, logical, relative }
  const progress = progressSender(event, "versions", writableTasks.length);
  for (const task of writableTasks) {
    if (isCancelled(options.opId) || destinationGone) {
      stopped = true;
      break;
    }
    try {
      if (masterKey) {
        await preserveEncryptedVersion(task.srcPath, task.target);
        saved.push({ stamp: task.stamp, logical: task.logical, relative: task.versionRelative });
      } else {
        await writeVersionAtomic(task.srcPath, task.target);
      }
      copied++;
      journal.add(task.journalRelative);
      bytesDone += Number(task.size) || 0;
      progress(copied, task.relativeDest, bytesDone);
    } catch (err) {
      errors.push({ file: String(task.relativeDest), error: err.message });
      if (!destinationGone && (await destRootGone(destKey))) destinationGone = true;
    }
  }

  progress.flush();
  journal.flush();

  // Mismo caso que en backup:copy-files: un solo aviso claro en vez de uno
  // confuso por archivo.
  if (destinationGone) {
    errors.length = 0;
    errors.push({
      file: "",
      error: "El disco de backup ya no está conectado: se detuvo la copia para no perder ni mezclar archivos. Vuelve a conectarlo y repite el backup.",
      code: "DEST_GONE",
    });
  } else {
    if (masterKey) {
      for (const stamp of new Set(saved.map((v) => v.stamp))) {
        try {
          almacen.recordVersions(destKey, masterKey, stamp, saved.filter((v) => v.stamp === stamp));
        } catch (err) {
          errors.push({ file: "versions/" + stamp, error: "No se pudo guardar el índice de versiones: " + err.message });
        }
      }
    }
    if (journalPath) {
      checkJournals(journalDir(destKey), destKey);
      finishJournal(journalPath);
    }
  }

  return { copied, skipped, errors, stopped: stopped || destinationGone, destinationGone };
});

// Último backup en ese disco (fecha, cuántos archivos), o null si no hay.
ipcMain.handle("backup:last-run", async (_event, destRoot) => {
  const key = await assertDestRoot(destRoot);
  if (almacen.isEncrypted(key)) {
    // Cerrado: no se puede leer cuándo fue el último backup.
    const masterKey = await destCryptoKey(key).catch(() => null);
    return masterKey ? summarizeLastBackup(almacen.logsDir(key), almacen.logReader(masterKey)) : { locked: true };
  }
  return summarizeLastBackup(path.join(metadataDir(key), "logs"));
});

// --- Kiopia Desk portable en el disco de backup ---------------------------------
// La versión portable viaja dentro del instalador (scripts/build.js) y se copia
// al disco al terminar un backup, para abrir las copias en otro PC sin instalar
// nada. Si la app ya se está ejecutando como portable, se copia a sí misma.
const PORTABLE_BUILD_NAME = "KiopiaDesk-Portable.exe";

function portableSource() {
  const running = process.env.PORTABLE_EXECUTABLE_FILE;
  if (running && fs.existsSync(running)) return running;
  const packed = path.join(process.resourcesPath, "portable", PORTABLE_BUILD_NAME);
  if (fs.existsSync(packed)) return packed;
  // En desarrollo (npm start), la que haya compilado npm run build.
  if (!app.isPackaged) {
    const dev = path.join(__dirname, "dist", "portable", PORTABLE_BUILD_NAME);
    if (fs.existsSync(dev)) return dev;
  }
  return null;
}

ipcMain.handle("backup:ensure-portable", async (event, destRoot, destVolumeId) => {
  const key = await assertDestRoot(destRoot);
  await assertDestVolumeUnchanged(key, destVolumeId);
  const source = portableSource();
  // El aviso de progreso se arma recién si de verdad hay que copiar (con el
  // tamaño del archivo como total, en bytes): así se ve avanzar de verdad en
  // vez de quedarse en "0 de 1" todo lo que tarda la copia (ver
  // copyFileWithProgress en almacen.js).
  let progress = null;
  const onProgress = (done, total) => {
    if (!progress) progress = progressSender(event, "portable", total);
    progress(done, almacen.PORTABLE_NAME, done);
  };
  try {
    const result = await almacen.ensurePortableApp(key, source, onProgress);
    if (progress) progress.flush();
    return result;
  } catch (err) {
    return { copied: false, reason: "error", error: err.message };
  }
});

// Abre en el Explorador la carpeta del backup de ese disco (si existe).
ipcMain.handle("backup:open-folder", async (_event, destRoot) => {
  const key = await assertDestRoot(destRoot);
  const folder = backupRootOf(key);
  if (!fs.existsSync(folder)) return { ok: false, error: "Todavía no hay un backup en este disco." };
  const error = await shell.openPath(folder);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle("log:save", async (_event, destRoot, sourceName, report) => {
  const key = await assertDestRoot(destRoot);
  const masterKey = await destCryptoKey(key);
  if (masterKey) return almacen.saveLog(key, masterKey, report);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(metadataDir(key), "logs", `${safeName(sourceName)}_${stamp}.json`);
  atomicWriteFileSync(logPath, JSON.stringify(report, null, 2));
  return logPath;
});

function readManifestForRestore(destKey, sourceName, masterKey = null) {
  if (masterKey) {
    const { manifest, warning } = loadManifestWithFallback(destKey, sourceName, masterKey);
    if (!Object.keys(manifest).length) {
      throw new Error(warning || "No se encontró manifiesto de backup para: " + sourceName);
    }
    return { manifest, warning };
  }
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

// Ruta en el disco del archivo "relativePath" de la carpeta respaldada: la de
// siempre sin cifrar, o su nombre opaco en datos\ si está cifrado. Lanza si
// una clave del manifiesto (manipulado) intenta salirse del backup.
function backupFileLocator(destKey, sourceName, masterKey) {
  if (masterKey) {
    return (relativePath) => {
      safePath(path.join(destKey, BACKUP_ROOT, safeName(sourceName)), relativePath);
      return almacen.dataPath(destKey, masterKey, sourceName, relativePath);
    };
  }
  const backupDir = path.join(destKey, BACKUP_ROOT, safeName(sourceName));
  return (relativePath) => safePath(backupDir, relativePath);
}

ipcMain.handle("restore:scan", async (event, backupDrive, sourceName, localFolderPath) => {
  const key = await assertDestRoot(backupDrive);
  if (!insideAny(allowed.sources, localFolderPath) && !insideAny(allowed.comparePaths, localFolderPath)) {
    throw new Error("Carpeta local no autorizada: " + localFolderPath);
  }
  const masterKey = await destCryptoKey(key);
  const { manifest, warning } = readManifestForRestore(key, sourceName, masterKey);

  const locate = backupFileLocator(key, sourceName, masterKey);
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
      backupFilePath = locate(relativePath);
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
  const madeDirs = new Set();
  const progress = progressSender(event, "restore", total);
  let bytesDone = 0;

  // Clave de cada disco de backup que aparece en la lista (normalmente uno).
  const keys = new Map();
  async function keyFor(backupFullPath) {
    const destKey = [...allowed.destRoots].find((k) => isInside(backupRootOf(k), backupFullPath));
    if (!keys.has(destKey)) keys.set(destKey, destCryptoKey(destKey));
    return keys.get(destKey);
  }

  async function restoreOne(file) {
    try {
      assertInsideBackup(file.backupFullPath);
      const dest = safePath(targetDir, file.path);
      const masterKey = await keyFor(file.backupFullPath);
      await ensureDir(path.dirname(dest), madeDirs);
      // Misma copia verificada que el backup, más el chequeo contra el hash
      // del manifiesto (ver comentario de restoreFileVerified en core.js).
      if (masterKey) {
        await restoreEncryptedVerified(masterKey, file.backupFullPath, dest, file.hash, Number(file.lastModified));
      } else {
        await restoreFileVerified(file.backupFullPath, dest, file.hash);
      }
      copied++;
      bytesDone += Number(file.size) || 0;
      progress(copied, file.path, bytesDone);
    } catch (err) {
      errors.push({ file: String(file && file.path), error: describeCopyError(err, String(file && file.path)) });
    }
  }

  // Muchos archivos pequeños: 4 a la vez (el destino es el disco del equipo);
  // grandes: lo que diga el tipo de disco (ver pickRestoreConcurrency).
  const avgSize = total ? files.reduce((s, f) => s + ((f && f.size) || 0), 0) / total : 0;
  const requested = options.concurrency > 0 ? options.concurrency : BACKUP_CONCURRENCY;
  const concurrency = Math.max(requested, pickRestoreConcurrency(avgSize));
  const run = await runTasks(files, restoreOne, { concurrency, shouldStop: () => isCancelled(options.opId) });
  progress.flush();

  return { copied, errors, concurrency, stopped: run.stopped };
});

ipcMain.handle("restore:list-sources", async (_event, backupDrive) => {
  const key = await assertDestRoot(backupDrive);
  const masterKey = await destCryptoKey(key);
  if (masterKey) return almacen.listSources(key, masterKey);
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
  const masterKey = await destCryptoKey(key);
  const { manifest } = readManifestForRestore(key, sourceName, masterKey);
  const locate = backupFileLocator(key, sourceName, masterKey);
  const result = [];
  for (const [relativePath, fileInfo] of Object.entries(manifest)) {
    // Mismo motivo que en restore:scan: una clave de manifiesto manipulada no
    // debe poder resolverse a una ruta fuera de la carpeta del backup, ni
    // siquiera para listarla (restore:copy-files la rechazaría igual al
    // restaurar, pero no hace falta ofrecerla como si fuera válida).
    let backupFullPath;
    try {
      backupFullPath = locate(relativePath);
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
