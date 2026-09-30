"use strict";

const BACKUP_ROOT = "KopiaDesk_Backup";
const MAX_RENDERED_FILES = 50;
const SPACE_SAFETY_MARGIN = 1.05; // exige 5% extra de espacio libre sobre lo calculado
const THEME_STORAGE_KEY = "kopiaDeskTheme";

const state = {
  sources: [],
  destination: null,
  comparisons: [],
  copied: 0,
  deduped: 0,
  busy: false,
  excludePatterns: [],
  // Carpetas o archivos concretos (rutas completas) que el usuario no quiere copiar.
  excludePaths: [],
  // Discos (por volumeId) en los que el usuario pulsó "Omitir por ahora" el cifrado.
  encryptionSkipped: {},
  // Grupos de reglas por defecto que el usuario desmarcó (se copian).
  defaultExcludesOff: [],
  // Velocidad medida de backups anteriores por disco (volumeId -> bytes/s).
  diskSpeeds: {},
  // Tiempo de la copia en curso (ver beginTiming).
  timing: null,
  // Copia en curso que se puede detener: { id, stopRequested } (ver startStoppable).
  stoppable: null,
  // Disco de backup elegido que se desconectó: { volumeId, root, label }. Al
  // volver a conectarlo (aunque tenga otra letra) se elige solo otra vez.
  lostDestination: null,
  compareSources: [],
  compareSelection: {},
  journalPending: false,
  suspiciousAcknowledged: false,
  // Ya se vio el tutorial (se guarda en la configuración).
  tutorialDone: false,
  // Cifrado de las copias en el destino ({ encrypted, unlocked, plainBackup }):
  // null mientras se consulta o sin destino.
  encryption: null,
  // Operación en curso sobre el disco: { root, action: "Enable"|"Unlock"|"Eject", phase }.
  encryptionJob: null,
  // Peso de cada carpeta de origen, por ruta: { status: "measuring"|"done"|"error", bytes, files }.
  sourceSizes: {},
  // Se conectó o quitó un disco mientras había una operación en curso: se
  // actualiza la lista al terminar.
  drivesChangedPending: false,
};

const els = {
  addSourceBtn: document.querySelector("#addSourceBtn"),
  quickFolders: document.querySelector("#quickFolders"),
  destinationSelect: document.querySelector("#destinationSelect"),
  refreshDrivesBtn: document.querySelector("#refreshDrivesBtn"),
  scanBtn: document.querySelector("#scanBtn"),
  backupBtn: document.querySelector("#backupBtn"),
  clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
  sourcesList: document.querySelector("#sourcesList"),
  destinationLabel: document.querySelector("#destinationLabel"),
  changesView: document.querySelector("#changesView"),
  sumSelected: document.querySelector("#sumSelected"),
  sumSelectedDetail: document.querySelector("#sumSelectedDetail"),
  sumPlanned: document.querySelector("#sumPlanned"),
  sumPlannedDetail: document.querySelector("#sumPlannedDetail"),
  sumFree: document.querySelector("#sumFree"),
  sumFreeDetail: document.querySelector("#sumFreeDetail"),
  sumFreeLabel: document.querySelector("#sumFreeLabel"),
  sumBar: document.querySelector("#sumBar"),
  sumFit: document.querySelector("#sumFit"),
  sumDetailsBtn: document.querySelector("#sumDetailsBtn"),
  summaryActions: document.querySelector(".summary-actions"),
  tutorialBtn: document.querySelector("#tutorialBtn"),
  actionDock: document.querySelector("#actionDock"),
  dockText: document.querySelector("#dockText"),
  dockScanBtn: document.querySelector("#dockScanBtn"),
  dockBackupBtn: document.querySelector("#dockBackupBtn"),
  sourceCount: document.querySelector("#sourceCount"),
  changeCount: document.querySelector("#changeCount"),
  copiedCount: document.querySelector("#copiedCount"),
  dedupedCount: document.querySelector("#dedupedCount"),
  logList: document.querySelector("#logList"),
  spaceInfo: document.querySelector("#spaceInfo"),
  usageFill: document.querySelector("#usageFill"),
  repoPathHint: document.querySelector("#repoPathHint"),
  fsWarning: document.querySelector("#fsWarning"),
  encryptionPanel: document.querySelector("#encryptionPanel"),
  encryptionStatus: document.querySelector("#encryptionStatus"),
  encryptionRecheckBtn: document.querySelector("#encryptionRecheckBtn"),
  encryptBtn: document.querySelector("#encryptBtn"),
  skipEncryptBtn: document.querySelector("#skipEncryptBtn"),
  showEncryptBtn: document.querySelector("#showEncryptBtn"),
  unlockBtn: document.querySelector("#unlockBtn"),
  lockBtn: document.querySelector("#lockBtn"),
  changePasswordBtn: document.querySelector("#changePasswordBtn"),
  ejectBtn: document.querySelector("#ejectBtn"),
  unlockBox: document.querySelector("#unlockBox"),
  unlockPassword: document.querySelector("#unlockPassword"),
  unlockError: document.querySelector("#unlockError"),
  recoveryDialog: document.querySelector("#recoveryDialog"),
  recoveryDialogDrive: document.querySelector("#recoveryDialogDrive"),
  recoveryKeyText: document.querySelector("#recoveryKeyText"),
  recoveryCopyBtn: document.querySelector("#recoveryCopyBtn"),
  recoverySavedToggle: document.querySelector("#recoverySavedToggle"),
  recoveryDoneBtn: document.querySelector("#recoveryDoneBtn"),
  changePasswordDialog: document.querySelector("#changePasswordDialog"),
  chgPassword1: document.querySelector("#chgPassword1"),
  chgPassword2: document.querySelector("#chgPassword2"),
  chgPasswordStrength: document.querySelector("#chgPasswordStrength"),
  changePasswordCancel: document.querySelector("#changePasswordCancel"),
  changePasswordConfirm: document.querySelector("#changePasswordConfirm"),
  encryptPasswordBox: document.querySelector("#encryptPasswordBox"),
  encPassword1: document.querySelector("#encPassword1"),
  encPassword2: document.querySelector("#encPassword2"),
  encPasswordStrength: document.querySelector("#encPasswordStrength"),
  lockAfterLabel: document.querySelector("#lockAfterLabel"),
  lockAfterToggle: document.querySelector("#lockAfterToggle"),
  encryptDialog: document.querySelector("#encryptDialog"),
  encryptDialogDrive: document.querySelector("#encryptDialogDrive"),
  encryptDialogCancel: document.querySelector("#encryptDialogCancel"),
  encryptDialogConfirm: document.querySelector("#encryptDialogConfirm"),
  suspiciousWarning: document.querySelector("#suspiciousWarning"),
  suspiciousWarningText: document.querySelector("#suspiciousWarningText"),
  suspiciousAckCheckbox: document.querySelector("#suspiciousAckCheckbox"),
  folderTemplate: document.querySelector("#folderTemplate"),
  versioningToggle: document.querySelector("#versioningToggle"),
  hashToggle: document.querySelector("#hashToggle"),
  dedupToggle: document.querySelector("#dedupToggle"),
  excludeFolderBtn: document.querySelector("#excludeFolderBtn"),
  excludeFileBtn: document.querySelector("#excludeFileBtn"),
  excludeList: document.querySelector("#excludeList"),
  defaultExcludes: document.querySelector("#defaultExcludes"),
  progressTime: document.querySelector("#progressTime"),
  stopCopyBtn: document.querySelector("#stopCopyBtn"),
  closeActionSelect: document.querySelector("#closeActionSelect"),
  excludePatternsBox: document.querySelector("#excludePatternsBox"),
  excludePatternsCount: document.querySelector("#excludePatternsCount"),
  lastBackupRow: document.querySelector("#lastBackupRow"),
  lastBackupText: document.querySelector("#lastBackupText"),
  openBackupBtn: document.querySelector("#openBackupBtn"),
  excludeInput: document.querySelector("#excludeInput"),
  journalNotice: document.querySelector("#journalNotice"),
  journalNoticeText: document.querySelector("#journalNoticeText"),
  journalCleanBtn: document.querySelector("#journalCleanBtn"),
  journalSkipBtn: document.querySelector("#journalSkipBtn"),
  themeToggle: document.querySelector("#themeToggle"),
  themeIconMoon: document.querySelector("#themeIconMoon"),
  themeIconSun: document.querySelector("#themeIconSun"),
  progressContainer: document.querySelector("#progressContainer"),
  progressPhase: document.querySelector("#progressPhase"),
  progressPercent: document.querySelector("#progressPercent"),
  progressBar: document.querySelector("#progressBar"),
  progressDetail: document.querySelector("#progressDetail"),
  tabBackup: document.querySelector("#tabBackup"),
  tabCompare: document.querySelector("#tabCompare"),
  tabRestoreFull: document.querySelector("#tabRestoreFull"),
  backupView: document.querySelector("#backupView"),
  compareView: document.querySelector("#compareView"),
  restoreFullView: document.querySelector("#restoreFullView"),
  comparePreview: document.querySelector("#comparePreview"),
  compareBtn: document.querySelector("#compareBtn"),
  compareResults: document.querySelector("#compareResults"),
  restoreFullList: document.querySelector("#restoreFullList"),
  winMin: document.querySelector("#winMin"),
  winMax: document.querySelector("#winMax"),
  winClose: document.querySelector("#winClose"),
  winMaxIcon: document.querySelector("#winMaxIcon"),
  winRestoreIcon: document.querySelector("#winRestoreIcon"),
};

const MAX_LOG_ENTRIES = 300;

function log(message) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  item.appendChild(time);
  item.appendChild(document.createTextNode(" — " + message));
  els.logList.prepend(item);
  // El registro se alimenta archivo por archivo en operaciones grandes; sin
  // tope, el DOM acumula miles de <li> y la ventana se vuelve lenta. Se
  // conservan las entradas más recientes (las más viejas están al final).
  while (els.logList.childElementCount > MAX_LOG_ENTRIES) {
    els.logList.lastElementChild.remove();
  }
}

function showProgress(phase, current, total, file) {
  els.progressContainer.hidden = false;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  els.progressPhase.textContent = phase;
  els.progressPercent.textContent = percent + "%";
  els.progressBar.style.width = percent + "%";
  els.progressDetail.textContent = file
    ? current + "/" + total + " — " + file
    : current + "/" + total;
}

function hideProgress() {
  els.progressContainer.hidden = true;
  els.progressBar.style.width = "0%";
  stopTimingTicker();
  els.progressTime.hidden = true;
}

window.kopiaAPI.onProgress((data) => {
  const labels = {
    backup: "Copiando archivos...",
    versions: "Guardando versiones anteriores...",
    "restore-scan": "Comparando backup vs PC...",
    restore: "Restaurando archivos...",
    portable: "Guardando Kopia Desk portable en la USB (sólo la primera vez o al actualizarla)...",
  };
  showProgress(labels[data.phase] || data.phase, data.current, data.total, data.file);
  if (state.timing && (data.phase === "backup" || data.phase === "restore" || data.phase === "versions")) {
    state.timing.callBytes = Number(data.bytes) || 0;
    renderTiming();
  }
});

// --- Tiempo: lo que lleva, lo que falta y la velocidad ----------------------------
// Una copia puede hacer varias llamadas (una por carpeta de origen): "bytes" de
// cada aviso es lo copiado en la llamada en curso y baseBytes lo de las anteriores.

function beginTiming(totalBytes) {
  stopTimingTicker();
  state.timing = { start: Date.now(), totalBytes, baseBytes: 0, callBytes: 0, ticker: null };
  // Un archivo grande puede tardar minutos sin avisos: el reloj sigue igual.
  state.timing.ticker = setInterval(renderTiming, 1000);
  renderTiming();
}

// Terminó una llamada (una carpeta): lo copiado pasa a la base.
function advanceTiming() {
  if (!state.timing) return;
  state.timing.baseBytes += state.timing.callBytes;
  state.timing.callBytes = 0;
}

function stopTimingTicker() {
  if (state.timing && state.timing.ticker) {
    clearInterval(state.timing.ticker);
    state.timing.ticker = null;
  }
}

// --- Detener una copia ------------------------------------------------------------
// Cada copia (backup o restauración) tiene un identificador; "Detener" se lo
// manda al proceso principal, que deja de empezar archivos nuevos. El archivo en
// curso termina y se verifica: nunca queda uno a medias en el backup.

function startStoppable() {
  state.stoppable = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10), stopRequested: false };
  els.stopCopyBtn.hidden = false;
  els.stopCopyBtn.disabled = false;
  els.stopCopyBtn.querySelector("span").textContent = "Detener";
  return state.stoppable;
}

function endStoppable() {
  state.stoppable = null;
  els.stopCopyBtn.hidden = true;
}

function stopRequested() {
  return !!(state.stoppable && state.stoppable.stopRequested);
}

els.stopCopyBtn.addEventListener("click", () => {
  const op = state.stoppable;
  if (!op || op.stopRequested) return;
  op.stopRequested = true;
  els.stopCopyBtn.disabled = true;
  els.stopCopyBtn.querySelector("span").textContent = "Deteniendo…";
  log("Deteniendo la copia: se termina y verifica el archivo en curso…");
  window.kopiaAPI.cancelCopy(op.id).catch(() => {});
});

// Cerrar la app con una copia en curso: el proceso principal ya la está
// deteniendo; aquí sólo se cuenta qué pasa mientras termina el archivo en curso.
window.kopiaAPI.onStoppingForQuit(() => {
  if (state.stoppable) {
    state.stoppable.stopRequested = true;
    els.stopCopyBtn.disabled = true;
    els.stopCopyBtn.querySelector("span").textContent = "Cerrando…";
  }
  log("Cerrando Kopia Desk: se detiene la copia (termina y verifica el archivo en curso) y luego se cierra.");
});

// Devuelve { bytes, seconds } de la copia que termina.
function endTiming() {
  const t = state.timing;
  if (!t) return null;
  stopTimingTicker();
  state.timing = null;
  return { bytes: t.baseBytes + t.callBytes, seconds: (Date.now() - t.start) / 1000 };
}

function renderTiming() {
  const t = state.timing;
  if (!t) return;
  const seconds = (Date.now() - t.start) / 1000;
  const done = t.baseBytes + t.callBytes;
  const parts = ["Lleva " + formatClock(seconds)];
  // Con pocos segundos o sin bytes todavía la estimación saltaría mucho.
  if (seconds >= 3 && done > 0) {
    const rate = done / seconds;
    const left = Math.max(0, t.totalBytes - done) / rate;
    parts.push("quedan " + formatDuration(left, "~"));
    parts.push(formatBytes(rate) + "/s");
  } else {
    parts.push("calculando lo que falta…");
  }
  els.progressTime.hidden = false;
  els.progressTime.textContent = parts.join(" · ");
}

// 83 -> "1:23"; 3725 -> "1:02:05"
function formatClock(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? h + ":" + pad(m) + ":" + pad(s % 60) : m + ":" + pad(s % 60);
}

// Duración aproximada: "menos de 1 min", "~4 min", "~1 h 20 min".
function formatDuration(seconds, prefix = "unos ") {
  if (seconds < 60) return "menos de 1 min";
  const min = Math.round(seconds / 60);
  if (min < 60) return prefix + min + " min";
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return prefix + h + " h" + (rest ? " " + rest + " min" : "");
}

// Clave de la velocidad medida: por disco y, aparte, con las copias cifradas
// (cifrar y verificar cuesta más: con una sola velocidad, un disco cifrado
// estimaba 11 min y tardaba casi 30).
function diskSpeedKey() {
  const id = state.destination && state.destination.volumeId;
  if (!id) return null;
  return encryptionState(state.encryption) === "open" ? id + "|cifrado" : id;
}

// Guarda la velocidad del backup en ese disco para estimar el siguiente
// (media con la anterior, para no depender de una sola corrida).
function rememberDiskSpeed(measure) {
  const id = diskSpeedKey();
  if (!id || !measure || measure.seconds < 3 || measure.bytes < 5 * 1024 * 1024) return;
  const bps = measure.bytes / measure.seconds;
  const old = state.diskSpeeds[id];
  state.diskSpeeds[id] = old ? Math.round(old * 0.5 + bps * 0.5) : Math.round(bps);
  saveState();
}

// Trabajo de la copia en bytes: lo que se copia y, con "Guardar versiones", la
// versión anterior de cada cambiado, que se lee y se escribe comprimida en el
// mismo disco antes de sobrescribirla (con archivos grandes pesa tanto como la copia).
// Con las copias cifradas en NTFS la versión anterior se enlaza al instante.
function plannedCopyBytes() {
  let bytes = 0;
  const linkedVersions = encryptionState(state.encryption) === "open" && state.destination && state.destination.fileSystem === "NTFS";
  const versions = els.versioningToggle.checked && !linkedVersions;
  for (const c of state.comparisons) {
    if (c.decisions.new) c.newFiles.forEach((f) => (bytes += f.size || 0));
    if (c.decisions.changed) {
      c.changedFiles.forEach((f) => {
        bytes += f.size || 0;
        if (versions && f.previous) bytes += f.previous.size || 0;
      });
    }
  }
  return bytes;
}

// " Tardará unos 4 min." si ya se midió la velocidad de este disco.
function backupTimeEstimate() {
  const id = diskSpeedKey();
  const bps = id && state.diskSpeeds[id];
  const bytes = plannedCopyBytes();
  if (!bps || !bytes) return "";
  return " Tardará " + formatDuration(bytes / bps) + " (aprox.).";
}

function setBusy(busy) {
  state.busy = busy;
  // El proceso principal lo usa al cerrar: con una copia en curso avisa y la detiene bien.
  window.kopiaAPI.setBusy(busy).catch(() => {});
  els.scanBtn.disabled = busy;
  els.addSourceBtn.disabled = busy;
  // Bloquear los controles que mutan el estado del que dependen las operaciones
  // en curso: cambiar de disco o refrescar discos pone state.destination en null
  // a mitad de una copia. Cambiar de pestaña resetea las listas de comparar/
  // restaurar. Se rehabilitan al terminar.
  els.refreshDrivesBtn.disabled = busy;
  els.destinationSelect.disabled = busy;
  els.clearHistoryBtn.disabled = busy;
  els.tabBackup.disabled = busy;
  els.tabCompare.disabled = busy;
  els.tabRestoreFull.disabled = busy;
  updateCounts();
  updateCompareBtn();
  renderEncryptionPanel();
  renderExcludes();
  // Se conectó o quitó un disco durante la operación: ahora sí se actualiza.
  if (!busy && state.drivesChangedPending) {
    setTimeout(() => refreshDrivesKeepingSelection().catch((e) => log(e.message)), 0);
  }
}

function totalChanges() {
  return state.comparisons.reduce(
    (t, c) => t + c.newFiles.length + c.changedFiles.length + c.missingFiles.length,
    0
  );
}

// Aviso de espacio en vivo: se recalcula al escanear, cambiar decisiones,
// versionado o destino. Si no alcanza, se explica el porqué y se deshabilita
// "Copiar aceptados" en vez de fallar recién al apretar el botón.
// ¿Cabe lo que se va a copiar? El aviso lo muestra la tarjeta Resumen
// ("✘ No cabe: faltan …"), junto al botón de copiar.
function updateSpaceStatus() {
  if (!state.destination) return true;
  const planned = computePlannedBytes();
  return planned === 0 || planned * SPACE_SAFETY_MARGIN <= state.destination.free;
}

// Heurística simple para frenar antes de copiar si el patrón de cambios se
// parece a corrupción masiva o a un ataque tipo ransomware (mucho contenido
// cambiado de golpe, o muchos archivos reemplazados a la vez). No es un
// antivirus ni lo detecta con certeza — sólo evita copiar en automático algo
// raro sobre la única copia buena que había, pidiendo que el usuario lo mire
// y confirme a propósito antes de seguir.
const SUSPICIOUS_MIN_SAMPLE = 20; // carpetas chicas no alcanzan para sacar conclusiones
const SUSPICIOUS_CHANGED_RATIO = 0.5; // más de la mitad de lo ya respaldado cambió junto
const SUSPICIOUS_REPLACED_RATIO = 0.3; // muchos desaparecieron Y muchos nuevos a la vez

function detectSuspiciousChange(comparison) {
  const previousTotal = Object.keys(comparison.previousManifest || {}).length;
  if (previousTotal < SUSPICIOUS_MIN_SAMPLE) return null;

  const changedRatio = comparison.changedFiles.length / previousTotal;
  if (changedRatio > SUSPICIOUS_CHANGED_RATIO) {
    return Math.round(changedRatio * 100) + "% de los archivos ya respaldados cambió de contenido en este mismo escaneo";
  }

  const missingRatio = comparison.missingFiles.length / previousTotal;
  const newRatio = comparison.newFiles.length / previousTotal;
  if (missingRatio > SUSPICIOUS_REPLACED_RATIO && newRatio > SUSPICIOUS_REPLACED_RATIO) {
    return (
      comparison.missingFiles.length +
      " archivo(s) desaparecieron y " +
      comparison.newFiles.length +
      " nuevo(s) aparecieron al mismo tiempo (patrón típico de un renombrado masivo)"
    );
  }

  return null;
}

function suspiciousReasons() {
  return state.comparisons
    .map((c) => {
      const reason = detectSuspiciousChange(c);
      return reason ? c.sourceName + ": " + reason : null;
    })
    .filter(Boolean);
}

function updateSuspiciousStatus() {
  const reasons = suspiciousReasons();
  if (!reasons.length) {
    els.suspiciousWarning.hidden = true;
    return true;
  }
  els.suspiciousWarning.hidden = false;
  els.suspiciousWarningText.textContent =
    "Se detectó un patrón de cambios inusual — típico de un archivo corrupto o de un ataque que cifra/renombra archivos en masa (ransomware) — antes de copiar esto sobre tu backup, conviene revisarlo: " +
    reasons.join("; ") +
    ".";
  return state.suspiciousAcknowledged;
}

// Archivos seleccionados que no entran en el sistema de archivos destino
// (FAT32: 4 GB por archivo). Se avisan antes de copiar y se omiten.
function oversizedSelectedFiles() {
  const max = state.destination && state.destination.maxFileSize;
  if (!max) return [];
  return state.comparisons.flatMap((c) =>
    [...(c.decisions.new ? c.newFiles : []), ...(c.decisions.changed ? c.changedFiles : [])].filter(
      (f) => f.size > max
    )
  );
}

function updateFsWarning() {
  const tooBig = oversizedSelectedFiles();
  if (!tooBig.length) {
    els.fsWarning.hidden = true;
    return;
  }
  els.fsWarning.hidden = false;
  els.fsWarning.textContent =
    "El disco destino es " + state.destination.fileSystem + " y no admite archivos de 4 GB o más: " +
    tooBig.length + " archivo(s) se omitirán (" + tooBig.slice(0, 3).map((f) => f.path).join(", ") +
    (tooBig.length > 3 ? ", ..." : "") + "). Usa un disco NTFS o exFAT para respaldarlos.";
}

// ¿El destino elegido es del disco del sistema (o de un disco no identificado)?
// No se ofrece expulsarlo.
function isSystemProtectedDestination() {
  const d = state.destination;
  if (!d) return false;
  return !!(d.isSystemDrive || d.onSystemDisk !== false);
}

// Cifrado: es opcional. Unas copias sin cifrar se usan directamente (el panel
// sigue mostrando cómo cifrarlas); unas cifradas y cerradas no se pueden usar
// hasta escribir la contraseña.
function encryptionAllowsBackup() {
  // Se está cifrando, abriendo o expulsando el disco: no copiar.
  if (currentEncryptionJob()) return false;
  return encryptionState(state.encryption) !== "locked";
}

// Texto para las listas de Comparar y Restaurar cuando las copias están
// cifradas y cerradas (o null si el error es otro).
function lockedBackupText(error) {
  if (error && !/CRYPTO_LOCKED/.test(error.message)) return null;
  return "Las copias de " + state.destination.root + " están cifradas. Escribe la contraseña en el panel del disco para verlas.";
}

// Antes de leer el backup (buscar cambios, comparar, restaurar): si las copias
// están cifradas y cerradas, se pide la contraseña en vez de fallar.
function requireOpenBackup() {
  if (encryptionState(state.encryption) !== "locked") return true;
  log("Las copias de " + state.destination.root + " están cifradas: escribe la contraseña en el panel del disco para usarlas.");
  if (encryptionSkippedHere()) setEncryptionSkipped(false);
  els.unlockPassword.focus();
  return false;
}

function updateCounts() {
  els.sourceCount.textContent = state.sources.length;
  els.changeCount.textContent = totalChanges();
  els.copiedCount.textContent = state.copied;
  els.dedupedCount.textContent = state.deduped > 0 ? state.deduped : "—";
  const spaceOk = updateSpaceStatus();
  const suspiciousOk = updateSuspiciousStatus();
  updateFsWarning();
  els.backupBtn.disabled =
    state.busy ||
    !state.destination ||
    totalChanges() === 0 ||
    !spaceOk ||
    !suspiciousOk ||
    !encryptionAllowsBackup();
  renderSummary();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1) + " " + units[index];
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "carpeta";
}

// Une la raíz del disco destino (p. ej. "D:\") con una ruta relativa del
// backup sin duplicar separadores.
function joinDestPath(root, relativePath) {
  return root.replace(/[\\/]+$/, "") + "\\" + relativePath;
}

// Patrones extra que el usuario escribió a mano (uno por línea o separados
// por coma), además de los DEFAULT_EXCLUDES que ya vienen de main.js.
function getCustomExcludePatterns() {
  return (els.excludeInput.value || "")
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Reglas por defecto que se pueden desmarcar ($RECYCLE.BIN y System Volume
// Information se ignoran siempre: son de Windows y no se pueden leer).
const DEFAULT_RULE_GROUPS = [
  { key: "windows", label: "Archivos de Windows", detail: "desktop.ini, Thumbs.db", patterns: ["Thumbs.db", "desktop.ini"] },
  { key: "temporales", label: "Temporales", detail: "*.tmp, ~$* (Office abierto)", patterns: ["*.tmp", "~$*"] },
  { key: "git", label: "Historial de Git", detail: ".git", patterns: [".git"] },
  { key: "node", label: "Dependencias", detail: "node_modules", patterns: ["node_modules"] },
];

function getExcludePatterns() {
  const off = new Set(
    DEFAULT_RULE_GROUPS.filter((g) => state.defaultExcludesOff.includes(g.key)).flatMap((g) => g.patterns.map((p) => p.toLowerCase()))
  );
  return state.excludePatterns.filter((p) => !off.has(p.toLowerCase())).concat(getCustomExcludePatterns());
}

function renderDefaultExcludes() {
  const box = els.defaultExcludes;
  if (box.childElementCount === DEFAULT_RULE_GROUPS.length) {
    box.querySelectorAll("input").forEach((input) => (input.checked = !state.defaultExcludesOff.includes(input.value)));
    return;
  }
  box.textContent = "";
  for (const g of DEFAULT_RULE_GROUPS) {
    const label = document.createElement("label");
    label.className = "default-exclude";
    label.title = "Si la desmarcas, se copia: " + g.detail;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = g.key;
    input.checked = !state.defaultExcludesOff.includes(g.key);
    input.addEventListener("change", () => {
      state.defaultExcludesOff = input.checked
        ? state.defaultExcludesOff.filter((k) => k !== g.key)
        : state.defaultExcludesOff.concat(g.key);
      log((input.checked ? "Se ignora otra vez: " : "Ahora se copia: ") + g.label + " (" + g.detail + ").");
      renderExcludes();
      exclusionsChanged();
    });
    const text = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = g.label;
    const small = document.createElement("small");
    small.textContent = g.detail;
    text.appendChild(strong);
    text.appendChild(small);
    label.appendChild(input);
    label.appendChild(text);
    box.appendChild(label);
  }
}

// --- Excluir: carpetas o archivos concretos ------------------------------------

function isInsideFolder(folder, p) {
  const a = folder.replace(/[\\/]+$/, "").toLowerCase();
  const b = p.toLowerCase();
  return b === a || b.startsWith(a + "\\") || b.startsWith(a + "/");
}

// Carpeta de origen a la que pertenece una ruta excluida (o null si ya no está).
function sourceOfPath(p) {
  return state.sources.find((s) => isInsideFolder(s.path, p)) || null;
}

// "Fotos\Temp" en vez de la ruta completa: lo que se reconoce en la app.
function shortExcludePath(p) {
  const source = sourceOfPath(p);
  return source ? source.name + p.slice(source.path.replace(/[\\/]+$/, "").length) : p;
}

function renderExcludes() {
  const list = els.excludeList;
  list.textContent = "";
  list.classList.toggle("empty", state.excludePaths.length === 0);
  if (!state.excludePaths.length) {
    list.textContent = "Nada excluido: se copia todo lo de tus carpetas.";
  }
  state.excludePaths.forEach((p) => {
    const row = document.createElement("div");
    row.className = "source-pill exclude-pill";
    const label = document.createElement("strong");
    label.textContent = p.split(/[\\/]/).filter(Boolean).pop() || p;
    row.appendChild(label);
    const where = document.createElement("span");
    where.className = "pill-path";
    // Se muestra la ruta dentro de su carpeta de origen, que es lo que se reconoce.
    where.textContent = shortExcludePath(p);
    where.title = p;
    row.appendChild(where);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Volver a copiarlo";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.excludePaths = state.excludePaths.filter((x) => x !== p);
      log("Ya no se excluye: " + shortExcludePath(p));
      renderExcludes();
      exclusionsChanged();
    });
    row.appendChild(remove);
    list.appendChild(row);
  });
  renderDefaultExcludes();
  const active = DEFAULT_RULE_GROUPS.filter((g) => !state.defaultExcludesOff.includes(g.key)).length;
  const patterns = getCustomExcludePatterns().length;
  els.excludePatternsCount.textContent = "(" + formatCount(active + patterns, "regla", "reglas") + ")";
  const noSources = state.sources.length === 0;
  els.excludeFolderBtn.disabled = noSources || state.busy;
  els.excludeFileBtn.disabled = noSources || state.busy;
}

// Lo que se copia cambió: el escaneo anterior ya no vale y los pesos se recalculan.
function exclusionsChanged() {
  saveState();
  if (state.comparisons.length) {
    state.comparisons = [];
    renderComparisons();
    log("Cambiaron las exclusiones: vuelve a escanear para ver qué se copia.");
  }
  measureAllSources();
}

async function pickExcludes(kind) {
  if (state.busy) return;
  if (!state.sources.length) {
    log("Añade primero una carpeta de origen.");
    return;
  }
  const { accepted, rejected } = await window.kopiaAPI.selectExclude(kind, state.sources[0].path);
  if (rejected.length) {
    log(
      "Solo se puede excluir algo que esté dentro de tus carpetas de origen (y no la carpeta entera: para eso, quítala de Origen). " +
        "No se añadió: " + rejected.join(", ")
    );
  }
  const nuevos = accepted.filter((p) => !state.excludePaths.some((x) => x.toLowerCase() === p.toLowerCase()));
  if (!nuevos.length) return;
  state.excludePaths = state.excludePaths.concat(nuevos);
  nuevos.forEach((p) => log("No se copiará: " + shortExcludePath(p)));
  renderExcludes();
  exclusionsChanged();
}

// --- Tema claro/oscuro ------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const isDark = theme === "dark";
  // El botón sólo tiene ícono (sin texto): se muestra el sol/la luna del
  // tema al que se pasaría al hacer clic, y se alterna con "hidden" en vez
  // de textContent para no borrar los <svg> anidados.
  els.themeIconMoon.hidden = isDark;
  els.themeIconSun.hidden = !isDark;
  els.themeToggle.setAttribute("aria-label", "Cambiar a tema " + (isDark ? "claro" : "oscuro"));
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}

els.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem(THEME_STORAGE_KEY, next);
});

function switchTab(tab) {
  els.tabBackup.classList.toggle("active", tab === "backup");
  els.tabCompare.classList.toggle("active", tab === "compare");
  els.tabRestoreFull.classList.toggle("active", tab === "restore-full");
  els.backupView.hidden = tab !== "backup";
  els.compareView.hidden = tab !== "compare";
  els.restoreFullView.hidden = tab !== "restore-full";
  if (tab === "compare") loadComparePreview().catch((e) => log(e.message));
  if (tab === "restore-full") loadFullRestoreList().catch((e) => log(e.message));
}

// --- Pestaña "Comparar": elegir qué carpetas revisar contra una carpeta local ---

// Lista las carpetas que hay en el backup para que el usuario elija manualmente
// cuáles comparar y contra qué carpeta local — nada se compara automáticamente,
// hay que marcarlas y apretar "Comparar seleccionados".
async function loadComparePreview() {
  els.comparePreview.textContent = "";
  state.compareSources = [];
  state.compareSelection = {};
  updateCompareBtn();

  if (!state.destination) {
    els.comparePreview.classList.add("empty");
    els.comparePreview.textContent = "Selecciona un disco con backup.";
    return;
  }

  if (encryptionState(state.encryption) === "locked") {
    els.comparePreview.classList.add("empty");
    els.comparePreview.textContent = lockedBackupText();
    return;
  }

  try {
    const sources = await window.kopiaAPI.restoreListSources(state.destination.root);
    if (!sources.length) {
      els.comparePreview.classList.add("empty");
      els.comparePreview.textContent = "No se encontraron backups en " + state.destination.root;
      return;
    }

    const knownPaths = await window.kopiaAPI.knownSourcePaths(state.destination.root).catch(() => ({}));
    if (knownPaths.__corrupt) {
      log("Atención: el registro de orígenes conocidos (sources.json) está dañado; " +
        "vas a tener que elegir de nuevo la carpeta local de cada backup para restaurar.");
    }
    state.compareSources = sources;
    sources.forEach((sourceName) => {
      state.compareSelection[sourceName] = { checked: false, localPath: knownPaths[sourceName] || null };
    });

    els.comparePreview.classList.remove("empty");
    renderCompareSelectionList();
  } catch (error) {
    els.comparePreview.classList.add("empty");
    els.comparePreview.textContent = lockedBackupText(error) || "Error al leer el backup: " + error.message;
  }
}

function updateCompareBtn() {
  const anySelected = state.compareSources.some((name) => {
    const sel = state.compareSelection[name];
    return sel && sel.checked && sel.localPath;
  });
  els.compareBtn.disabled = state.busy || !anySelected;
}

function renderCompareSelectionList() {
  els.comparePreview.textContent = "";

  state.compareSources.forEach((sourceName) => {
    const sel = state.compareSelection[sourceName];
    const row = document.createElement("div");
    row.className = "source-pill selectable";

    const checkLabel = document.createElement("label");
    checkLabel.className = "pill-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = sel.checked;
    const label = document.createElement("strong");
    label.textContent = sourceName;
    checkLabel.appendChild(cb);
    checkLabel.appendChild(label);
    row.appendChild(checkLabel);

    const pathSpan = document.createElement("span");
    pathSpan.className = "pill-path";
    pathSpan.textContent = sel.localPath || "Sin carpeta local elegida";
    pathSpan.title = sel.localPath || "";
    row.appendChild(pathSpan);

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "ghost";
    pickBtn.textContent = sel.localPath ? "Cambiar" : "Elegir carpeta";
    row.appendChild(pickBtn);

    cb.addEventListener("change", () => {
      sel.checked = cb.checked;
      updateCompareBtn();
    });

    pickBtn.addEventListener("click", async () => {
      const picked = await window.kopiaAPI.selectFolder();
      if (!picked) return;
      sel.localPath = picked;
      sel.checked = true;
      cb.checked = true;
      pathSpan.textContent = picked;
      pickBtn.textContent = "Cambiar";
      updateCompareBtn();
    });

    els.comparePreview.appendChild(row);
  });

  updateCompareBtn();
}

els.tabBackup.addEventListener("click", () => switchTab("backup"));
els.tabCompare.addEventListener("click", () => switchTab("compare"));
els.tabRestoreFull.addEventListener("click", () => switchTab("restore-full"));

// --- Peso de las carpetas y resumen "¿cabe?" ---------------------------------
// Al agregar una carpeta se mide su peso (con las mismas exclusiones que el
// backup), de una en una para no saturar el disco. Tras escanear, el peso se
// toma del propio escaneo. El resumen compara con el espacio libre del destino:
// antes de escanear, todo lo seleccionado; después, lo que de verdad falta
// copiar (en un backup incremental suele ser mucho menos).

let measureChain = Promise.resolve();

function measureSource(source) {
  const token = {};
  state.sourceSizes[source.path] = { status: "measuring", token };
  measureChain = measureChain.then(async () => {
    const current = () => state.sourceSizes[source.path];
    if (!current() || current().token !== token) return; // se quitó o se volvió a medir
    let result;
    try {
      const r = await window.kopiaAPI.measureDirectory(source.path, getExcludePatterns(), state.excludePaths);
      result = { status: "done", bytes: r.bytes, files: r.files };
    } catch {
      result = { status: "error" };
    }
    if (current() && current().token === token) {
      state.sourceSizes[source.path] = result;
      renderSources();
    }
  });
}

function measureAllSources() {
  state.sources.forEach(measureSource);
  renderSources();
}

// Tras escanear ya se conocen todos los archivos: el peso sale gratis.
function sizesFromComparisons() {
  for (const c of state.comparisons) {
    const source = state.sources.find((s) => s.name === c.sourceName);
    if (!source || !c.manifest) continue;
    let bytes = 0;
    let files = 0;
    for (const f of Object.values(c.manifest)) {
      bytes += f.size || 0;
      files++;
    }
    state.sourceSizes[source.path] = { status: "done", bytes, files };
  }
}

function formatCount(n, singular, plural) {
  return n.toLocaleString("es-ES") + " " + (n === 1 ? singular : plural);
}

function selectedTotals() {
  let bytes = 0;
  let measuring = 0;
  let failed = 0;
  for (const s of state.sources) {
    const size = state.sourceSizes[s.path];
    if (!size || size.status === "measuring") measuring++;
    else if (size.status === "error") failed++;
    else bytes += size.bytes;
  }
  return { bytes, measuring, failed };
}

// ¿Hay un escaneo vigente de TODAS las carpetas elegidas?
function scanCoversSources() {
  return (
    state.sources.length > 0 &&
    state.comparisons.length > 0 &&
    state.sources.every((s) => state.comparisons.some((c) => c.sourceName === s.name))
  );
}

function renderSummary() {
  const dest = state.destination;
  const sel = selectedTotals();
  const scanned = scanCoversSources();
  let level = "";
  let fit = "";
  let need = 0;

  // Seleccionado
  const selectedReady = state.sources.length && !(sel.measuring && sel.bytes === 0);
  els.sumSelected.classList.toggle("muted", !selectedReady);
  if (!state.sources.length) {
    els.sumSelected.textContent = "Nada aún";
    els.sumSelectedDetail.textContent = "Agrega carpetas";
  } else if (!selectedReady) {
    els.sumSelected.textContent = "Calculando…";
    els.sumSelectedDetail.textContent = formatCount(state.sources.length, "carpeta", "carpetas");
  } else {
    els.sumSelected.textContent = formatBytes(sel.bytes) + (sel.measuring ? "…" : "");
    els.sumSelectedDetail.textContent =
      formatCount(state.sources.length, "carpeta", "carpetas") +
      (sel.measuring ? " · calculando" : "") +
      (sel.failed ? " · " + sel.failed + " sin medir" : "");
  }

  // A copiar ahora
  els.sumPlanned.classList.toggle("muted", !scanned);
  if (scanned) {
    let nuevos = 0;
    let cambiados = 0;
    for (const c of state.comparisons) {
      if (c.decisions.new) nuevos += c.newFiles.length;
      if (c.decisions.changed) cambiados += c.changedFiles.length;
    }
    need = computePlannedBytes();
    els.sumPlanned.textContent = formatBytes(need);
    els.sumPlannedDetail.textContent =
      formatCount(nuevos, "nuevo", "nuevos") + " · " + formatCount(cambiados, "cambiado", "cambiados");
  } else {
    els.sumPlanned.textContent = "Sin escanear";
    els.sumPlannedDetail.textContent = state.comparisons.length ? "Vuelve a escanear" : "Escanea para saberlo";
  }

  // Libre en el destino
  els.sumFreeLabel.textContent = dest ? "Libre en " + dest.root : "Libre";
  els.sumFree.classList.toggle("muted", !dest);
  els.sumFree.textContent = dest ? formatBytes(dest.free) : "Sin disco";
  els.sumFreeDetail.textContent = dest ? (dest.label || dest.fileSystem || "") : "Elige un destino";

  // ¿Cabe?
  if (!state.sources.length) {
    fit = "Agrega una carpeta para empezar.";
  } else if (!dest) {
    fit = "Elige un disco destino para saber si cabe.";
  } else if (scanned) {
    if (need === 0) {
      fit = "No hay nada nuevo que copiar.";
      level = "good";
    } else if (need * SPACE_SAFETY_MARGIN <= dest.free) {
      fit = "✔ Cabe. Quedarán " + formatBytes(dest.free - need) + " libres." + backupTimeEstimate();
      level = "good";
    } else {
      fit = "✘ No cabe: faltan " + formatBytes(need * SPACE_SAFETY_MARGIN - dest.free) +
        ". Libera espacio, elige otro disco o desmarca archivos.";
      level = "bad";
    }
  } else if (sel.measuring) {
    fit = "Calculando el peso de las carpetas…";
    need = sel.bytes;
  } else {
    need = sel.bytes;
    if (need * SPACE_SAFETY_MARGIN <= dest.free) {
      fit = "✔ Todo lo seleccionado cabe. Escanea para ver qué falta por copiar.";
      level = "good";
    } else {
      fit = "Lo seleccionado ocupa más que el espacio libre. Escanea: si ya hay un backup en este disco, " +
        "solo se copiará lo que falte.";
      level = "warn";
    }
  }
  els.sumFit.textContent = fit;
  els.sumFit.dataset.level = level;

  const pct = dest && need > 0 ? (dest.free > 0 ? Math.min(100, (need / dest.free) * 100) : 100) : 0;
  els.sumBar.style.width = pct + "%";
  els.sumBar.dataset.level = level === "good" ? "" : level;
  els.sumBar.parentElement.title = dest && need > 0 ? Math.round(pct) + " % del espacio libre" : "";

  els.sumDetailsBtn.hidden = !(scanned && totalChanges() > 0);

  // Barra fija: versión corta del veredicto y los mismos botones.
  let dock;
  if (!state.sources.length) dock = "Agrega una carpeta para empezar.";
  else if (!dest) dock = "Elige un disco destino.";
  else if (scanned && need === 0) dock = "No hay nada nuevo que copiar.";
  else if (scanned) dock = formatBytes(need) + " a copiar · " + (level === "good" ? "✔ Cabe" : "✘ No cabe");
  else if (sel.measuring) dock = "Calculando el peso de las carpetas…";
  else dock = formatBytes(sel.bytes) + " seleccionados · " + (level === "good" ? "✔ Cabe todo" : "Escanea para ver qué copiar");
  els.dockText.textContent = dock;
  els.dockText.dataset.level = level;
  els.dockScanBtn.disabled = els.scanBtn.disabled;
  els.dockBackupBtn.disabled = els.backupBtn.disabled;
}

// --- Tutorial ---------------------------------------------------------------
// La primera vez que se abre la app recién instalada, un recorrido guiado por
// cada parte (renderer/tutorial.js). Después no vuelve a salir solo; se puede
// repetir desde Opciones.

const TUTORIAL_STEPS = [
  {
    target: () => els.addSourceBtn.closest(".card"),
    title: "1. Elige qué respaldar",
    text:
      "Añade las carpetas que quieres guardar (Fotos, Documentos…) con «Añadir carpeta» o con los accesos rápidos. " +
      "Junto a cada una verás cuánto pesa.",
  },
  {
    target: () => els.destinationSelect.closest(".card"),
    title: "2. Elige dónde guardarlo",
    text:
      "Conecta una USB o un disco externo y elígelo aquí. Si lo desconectas y lo vuelves a conectar, " +
      "Kopia Desk lo reconoce solo, aunque Windows le cambie la letra.",
  },
  {
    target: () => (els.encryptionPanel.hidden ? els.destinationSelect.closest(".card") : els.encryptionPanel),
    title: "3. Cifra las copias (opcional)",
    text:
      "Con una contraseña, las copias se guardan cifradas: sin ella nadie puede ver tus archivos ni sus nombres. " +
      "Guarda la clave de recuperación que te mostrará. En la USB queda «Abrir-KopiaDesk» para ver tus archivos " +
      "en cualquier Windows, aunque no tenga Kopia Desk.",
  },
  {
    target: ".summary-card",
    title: "4. Escanea y copia",
    text:
      "«Escanear» busca lo nuevo y lo cambiado desde el último backup y te dice cuánto ocupa, si cabe y cuánto tardará. " +
      "Revisa la lista y pulsa «Copiar». Nada se copia sin que lo confirmes.",
  },
  {
    target: ".exclude-card",
    title: "5. Lo que no quieres copiar",
    text: "Elige carpetas o archivos concretos que no se copien, o reglas por nombre o tipo (por ejemplo, *.iso).",
  },
  {
    target: () => els.versioningToggle.closest(".card"),
    title: "6. Opciones",
    text:
      "Guardar la versión anterior de lo que cambia, deduplicar archivos repetidos y qué hacer al cerrar la ventana " +
      "(por ejemplo, seguir copiando en segundo plano).",
  },
  {
    target: ".nav-rail nav",
    title: "7. Recuperar tus archivos",
    text:
      "«Comparar» trae sólo lo que falta en tu PC; «Restaurar» copia carpetas enteras del backup donde quieras, " +
      "por ejemplo en un PC nuevo.",
  },
  {
    target: ".log-panel",
    title: "8. Registro",
    text: "Aquí queda todo lo que hace la app: qué se copió, qué falló y por qué. Puedes repetir este tutorial desde Opciones.",
  },
];

function startTutorial() {
  if (window.KopiaTutorial.isRunning()) return;
  switchTab("backup");
  window.KopiaTutorial.start(TUTORIAL_STEPS, {
    onEnd: () => {
      if (!state.tutorialDone) {
        state.tutorialDone = true;
        saveState();
      }
    },
  });
}

els.tutorialBtn.addEventListener("click", () => {
  if (!state.busy) startTutorial();
});

// La barra fija se muestra sólo mientras los botones del Resumen no se ven.
if ("IntersectionObserver" in window) {
  new IntersectionObserver(
    (entries) => {
      for (const entry of entries) els.actionDock.hidden = entry.isIntersecting;
    },
    { threshold: 0.9 }
  ).observe(els.summaryActions);
}
els.dockScanBtn.addEventListener("click", () => els.scanBtn.click());
els.dockBackupBtn.addEventListener("click", () => els.backupBtn.click());

function renderSources() {
  renderExcludes();
  els.sourcesList.textContent = "";
  els.sourcesList.classList.toggle("empty", state.sources.length === 0);
  if (!state.sources.length) {
    els.sourcesList.textContent = "Sin carpetas seleccionadas";
    updateCounts();
    return;
  }

  state.sources.forEach((source, index) => {
    const row = document.createElement("div");
    row.className = "source-pill";

    const label = document.createElement("strong");
    label.textContent = source.name;
    row.appendChild(label);

    const pathSpan = document.createElement("span");
    pathSpan.className = "pill-path";
    pathSpan.textContent = source.path;
    pathSpan.title = source.path;
    row.appendChild(pathSpan);

    const size = state.sourceSizes[source.path];
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "pill-size mono";
    sizeSpan.dataset.state = size ? size.status : "measuring";
    if (size && size.status === "done") {
      sizeSpan.textContent = formatBytes(size.bytes) + " · " + formatCount(size.files, "archivo", "archivos");
    } else if (size && size.status === "error") {
      sizeSpan.textContent = "no se pudo medir";
    } else {
      sizeSpan.textContent = "calculando…";
    }
    row.appendChild(sizeSpan);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Quitar carpeta";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      delete state.sourceSizes[source.path];
      state.sources.splice(index, 1);
      state.comparisons = state.comparisons.filter((c) => c.sourceName !== source.name);
      state.excludePaths = state.excludePaths.filter((p) => !isInsideFolder(source.path, p));
      renderExcludes();
      renderSources();
      renderComparisons();
      log("Carpeta quitada: " + source.name);
      saveState();
    });
    row.appendChild(remove);
    els.sourcesList.appendChild(row);
  });
  updateCounts();
}

// Dos carpetas de origen distintas que terminan en el mismo nombre (p. ej.
// "C:\ProyectoA\Backup" y "D:\ProyectoB\Backup") sanearían al mismo nombre de
// manifiesto/carpeta de destino y mezclarían sus historiales de backup entre
// sí. Se detecta por safeName (la misma sanitización que usa main.js) y se
// desambigua automáticamente en vez de dejar que colisionen en silencio.
function uniqueSourceName(candidateName, folderPath) {
  const collidesWith = (n) =>
    state.sources.some((s) => s.path !== folderPath && safeName(s.name) === safeName(n));

  if (!collidesWith(candidateName)) return candidateName;

  const parts = folderPath.split(/[\\/]/).filter(Boolean);
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;
  if (parent) {
    const withParent = parent + " - " + candidateName;
    if (!collidesWith(withParent)) return withParent;
  }

  let n = 2;
  let attempt = candidateName + " (" + n + ")";
  while (collidesWith(attempt)) {
    n++;
    attempt = candidateName + " (" + n + ")";
  }
  return attempt;
}

function addFolderToSources(folderPath, displayName) {
  if (state.sources.some((s) => s.path === folderPath)) {
    log("La carpeta " + (displayName || folderPath) + " ya estaba seleccionada.");
    return;
  }

  const requestedName = displayName || folderPath.split(/[\\/]/).pop();
  const name = uniqueSourceName(requestedName, folderPath);
  if (name !== requestedName) {
    log(
      "Ya había una carpeta llamada '" + requestedName + "'; ésta se agregó como '" + name +
        "' para no mezclar sus backups."
    );
  }

  const source = { name, path: folderPath };
  state.sources.push(source);
  measureSource(source);
  renderSources();
  log("Carpeta añadida: " + name);
  saveState();
}

async function addSource() {
  if (state.busy) return;
  const folderPath = await window.kopiaAPI.selectFolder();
  if (!folderPath) return;
  addFolderToSources(folderPath);
}

async function loadQuickFolders() {
  els.quickFolders.textContent = "";
  try {
    const folders = await window.kopiaAPI.quickFolders();
    folders.forEach((folder) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-folder-chip";
      btn.textContent = folder.name;
      btn.title = folder.path;
      btn.addEventListener("click", () => {
        if (state.busy) return;
        addFolderToSources(folder.path, folder.name);
      });
      els.quickFolders.appendChild(btn);
    });
  } catch {
    // no crítico: sencillamente no se muestran accesos rápidos
  }
}

// Lecturas de la lista de discos en curso. Mientras hay una, la lista está vacía
// ("Buscando discos...") y no hay destino: un aviso de Windows que llegue en ese
// momento se deja pendiente y se atiende al terminar, cuando quien la pidió ya
// volvió a elegir el disco.
let drivesLoading = 0;

async function loadDrives() {
  drivesLoading++;
  try {
    await loadDrivesNow();
  } finally {
    drivesLoading--;
    if (drivesLoading === 0) flushPendingDriveRefresh();
  }
}

async function loadDrivesNow() {
  els.destinationSelect.textContent = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Buscando discos...";
  els.destinationSelect.appendChild(placeholder);
  state.destination = null;
  updateCounts();

  try {
    const drives = await window.kopiaAPI.listDrives();

    els.destinationSelect.textContent = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Selecciona un disco";
    els.destinationSelect.appendChild(defaultOpt);

    drives.forEach((drive) => {
      const option = document.createElement("option");
      option.value = drive.root;
      option.textContent =
        drive.root +
        (drive.label ? " - " + drive.label : "") +
        " (" +
        formatBytes(drive.free) +
        " libres)" +
        (drive.isSystemDrive
          ? " — disco del sistema, no recomendado"
          : drive.onSystemDisk
            ? " — en el disco del sistema, no recomendado"
            : "");
      option.dataset.free = drive.free;
      option.dataset.total = drive.total;
      option.dataset.label = drive.label || "";
      option.dataset.isSystemDrive = drive.isSystemDrive ? "1" : "";
      option.dataset.fileSystem = drive.fileSystem || "";
      option.dataset.volumeId = drive.volumeId || "";
      // "1" disco del sistema, "0" otro disco, "" no se pudo saber.
      option.dataset.onSystemDisk = drive.onSystemDisk === true ? "1" : drive.onSystemDisk === false ? "0" : "";
      option.dataset.veracrypt = drive.veracrypt ? "1" : "";
      if (drive.veracrypt) option.textContent += " — cifrado con VeraCrypt";
      option.dataset.maxFileSize = (drive.fsInfo && drive.fsInfo.maxFileSize) || "";
      option.dataset.hardlinks = drive.fsInfo && drive.fsInfo.supportsHardlinks === false ? "" : "1";
      option.dataset.journaled = drive.fsInfo && drive.fsInfo.journaled === false ? "" : "1";
      els.destinationSelect.appendChild(option);
    });

    if (!drives.length) {
      els.destinationSelect.textContent = "";
      const noDisks = document.createElement("option");
      noDisks.value = "";
      noDisks.textContent = "No hay discos disponibles";
      els.destinationSelect.appendChild(noDisks);
      els.destinationLabel.textContent = "Conecta un disco o USB";
    } else {
      els.destinationLabel.textContent = "Selecciona donde guardar";
    }
    log("Discos detectados: " + drives.length + ".");
  } catch (error) {
    els.destinationSelect.textContent = "";
    const errOpt = document.createElement("option");
    errOpt.value = "";
    errOpt.textContent = "Error detectando discos";
    els.destinationSelect.appendChild(errOpt);
    log("Error al leer discos: " + error.message);
  }
}

function refreshActiveExtraTab() {
  if (els.tabCompare.classList.contains("active")) {
    loadComparePreview().catch((e) => log(e.message));
  } else if (els.tabRestoreFull.classList.contains("active")) {
    loadFullRestoreList().catch((e) => log(e.message));
  }
}

function destinationFromOption(option) {
  return {
    root: option.value,
    label: option.dataset.label || "",
    free: Number(option.dataset.free || 0),
    total: Number(option.dataset.total || 0),
    isSystemDrive: option.dataset.isSystemDrive === "1",
    fileSystem: option.dataset.fileSystem || "",
    // Identidad del volumen elegido: al cifrar o bloquear se comprueba que la
    // letra siga siendo este mismo disco.
    volumeId: option.dataset.volumeId || "",
    onSystemDisk: option.dataset.onSystemDisk === "1" ? true : option.dataset.onSystemDisk === "0" ? false : null,
    maxFileSize: Number(option.dataset.maxFileSize || 0),
    supportsHardlinks: option.dataset.hardlinks === "1",
    journaled: option.dataset.journaled === "1",
    // Unidad montada con VeraCrypt: sin Expulsar (se desmonta en VeraCrypt).
    veracrypt: option.dataset.veracrypt === "1",
  };
}

function renderDestinationLabel() {
  const d = state.destination;
  els.destinationLabel.textContent =
    d.root + " seleccionado — " + formatBytes(d.free) + " libres" +
    (d.fileSystem ? " · " + d.fileSystem : "") +
    (d.isSystemDrive ? " (disco del sistema)" : "");
}

function renderDestinationSpace() {
  const d = state.destination;
  const usedPct = d.total > 0 ? Math.round(((d.total - d.free) / d.total) * 100) : 0;
  els.spaceInfo.textContent = "Disco: " + formatBytes(d.free) + " libres de " + formatBytes(d.total) + " (" + usedPct + "% usado)";
  els.usageFill.style.width = usedPct + "%";
  els.repoPathHint.textContent = "Se guarda en: " + joinDestPath(d.root, BACKUP_ROOT);
}

// "Último backup" del disco elegido, en la tarjeta del destino.
async function loadLastBackup() {
  const root = state.destination && state.destination.root;
  els.lastBackupRow.hidden = true;
  if (!root) return;
  let last = null;
  try {
    last = await window.kopiaAPI.lastBackup(root);
  } catch {
    return;
  }
  if (!state.destination || state.destination.root !== root) return;
  els.lastBackupRow.hidden = false;
  els.openBackupBtn.hidden = !last;
  if (!last) {
    els.lastBackupText.textContent = "Aún no hay backups en este disco.";
    return;
  }
  if (last.locked) {
    els.lastBackupText.textContent = "Copias cifradas: ábrelas con la contraseña para ver el último backup.";
    els.lastBackupText.title = "";
    return;
  }
  const when = last.date ? formatWhen(new Date(last.date)) : "fecha desconocida";
  let text =
    "Último backup: " + when + " · " +
    (last.copied || last.failed ? formatCount(last.copied, "archivo copiado", "archivos copiados") : "nada nuevo que copiar");
  if (last.failed) text += " · " + formatCount(last.failed, "con error", "con error");
  els.lastBackupText.textContent = text;
  els.lastBackupText.title = last.sources.length ? "Carpetas: " + last.sources.join(", ") : "";
}

// "hoy 22:14", "ayer 09:05" o "12/09/2026 18:30".
function formatWhen(d) {
  const hora = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const hoy = new Date();
  const ayer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1);
  if (d.toDateString() === hoy.toDateString()) return "hoy " + hora;
  if (d.toDateString() === ayer.toDateString()) return "ayer " + hora;
  return d.toLocaleDateString("es", { day: "2-digit", month: "2-digit", year: "numeric" }) + " " + hora;
}

async function selectDestination() {
  const option = els.destinationSelect.selectedOptions[0];

  if (!option || !option.value) {
    state.destination = null;
    els.lastBackupRow.hidden = true;
    els.destinationLabel.textContent = "Selecciona donde guardar";
    els.spaceInfo.textContent = "";
    els.usageFill.style.width = "0%";
    els.repoPathHint.textContent = "";
    els.journalNotice.hidden = true;
    state.journalPending = false;
    resetEncryptionPanel();
    updateCounts();
    refreshActiveExtraTab();
    return;
  }

  state.destination = destinationFromOption(option);
  renderDestinationLabel();
  loadLastBackup();

  if (state.destination.fileSystem && !state.destination.journaled) {
    log(
      "El disco " + state.destination.root + " usa " + state.destination.fileSystem +
        ": no admite hardlinks (la deduplicación copiará normal) y es más sensible a desconexiones " +
        "sin expulsar. " + (state.destination.maxFileSize ? "Además, no admite archivos de 4 GB o más. " : "") +
        "Para backups se recomienda NTFS."
    );
  }

  checkEncryption();
  renderDestinationSpace();

  log("Destino elegido: " + state.destination.root);
  if (state.destination.isSystemDrive) {
    log(
      "Atención: " + state.destination.root + " es el disco donde está instalado Windows. " +
        "No se recomienda usarlo como destino de backup — elegí un disco externo o USB."
    );
  }

  // Tipo de disco (se recalcula con datos reales al copiar)
  window.kopiaAPI
    .planConcurrency(state.destination.root, 1024 * 1024)
    .then((plan) => {
      // El tipo de conexión decide si se ofrece "Expulsar" (sólo discos USB).
      if (state.destination && state.destination.root === plan.root) {
        state.destination.busType = plan.driveInfo.busType || "Unknown";
        renderEncryptionPanel();
      }
    })
    .catch(() => {});

  // Journal: si quedó un backup interrumpido se avisa qué pasó y se pide
  // confirmación antes de borrar los archivos parciales (antes se limpiaba
  // en silencio y el usuario no sabía por qué la app "limpiaba" algo).
  els.journalNotice.hidden = true;
  state.journalPending = false;
  window.kopiaAPI
    .journalPeek(state.destination.root)
    .then((info) => {
      if (info.found > 0 && info.pendingFiles > 0) {
        showJournalNotice(info);
      } else if (info.found > 0) {
        // Sólo quedaron metadatos de journal (sin archivos parciales): se
        // limpian en silencio, no hay nada del usuario que borrar ni confirmar.
        return window.kopiaAPI.journalCheck(state.destination.root).catch(() => {});
      }
    })
    .catch(() => {});

  refreshActiveExtraTab();

  updateCounts();
  saveState();
}

// --- Cifrado de las copias (propio de Kopia Desk, v3) ---------------------------
// Se cifran las copias, no el disco: el contenido y también los nombres de
// archivos y carpetas (AES-256, ver lib/cifrado.js y lib/almacen.js). Funciona
// en cualquier Windows y en cualquier disco, también FAT32 y exFAT.
// La contraseña nunca se guarda: se toma de los campos, que se borran en el
// acto, y el proceso principal sólo conserva la clave del disco abierto
// mientras la app sigue abierta.

const MIN_PASSWORD_LENGTH = 8;

// 0-5: largo >= 12, largo >= 16, mayúsculas y minúsculas, dígitos, símbolos.
function passwordScore(p) {
  let score = 0;
  if (p.length >= 12) score++;
  if (p.length >= 16) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p)) score++;
  if (/[^A-Za-z0-9]/.test(p)) score++;
  return score;
}

// Texto y nivel para la contraseña nueva `p` repetida como `repeat`.
function describeNewPassword(p, repeat) {
  let text = "";
  let level = "";
  if (p.length > 0 && p.length < MIN_PASSWORD_LENGTH) {
    text = "Muy corta: faltan " + (MIN_PASSWORD_LENGTH - p.length) + " caracteres";
    level = "bad";
  } else if (p.length > 0 && p.length < 12) {
    text = "Fortaleza: aceptable (con 12 o más caracteres es más segura)";
    level = "warn";
  } else if (p.length > 0 && passwordScore(p) <= 2) {
    text = "Fortaleza: aceptable (agrega mayúsculas, números o símbolos)";
    level = "warn";
  } else if (p.length > 0) {
    text = "Fortaleza: buena";
    level = "good";
  }
  if (repeat.length > 0 && repeat !== p) {
    text = "Las contraseñas no coinciden";
    level = "bad";
  }
  const valid = p.length >= MIN_PASSWORD_LENGTH && !/[\u0000-\u001f\u007f]/.test(p) && p === repeat;
  return { text, level, valid };
}

function newPasswordValid() {
  return describeNewPassword(els.encPassword1.value, els.encPassword2.value).valid;
}

function renderPasswordStrength() {
  const d = describeNewPassword(els.encPassword1.value, els.encPassword2.value);
  els.encPasswordStrength.textContent = d.text;
  els.encPasswordStrength.dataset.level = d.level;
  els.encryptBtn.disabled = state.busy || !d.valid;
}

function clearPasswordFields() {
  els.encPassword1.value = "";
  els.encPassword2.value = "";
  els.unlockPassword.value = "";
  els.unlockError.textContent = "";
  document.querySelectorAll(".pw-eye").forEach((btn) => setPasswordVisible(btn, false));
  renderPasswordStrength();
}

// Ojo junto a cada campo: muestra u oculta lo escrito en ese campo.
function setPasswordVisible(btn, visible) {
  const input = document.getElementById(btn.dataset.target);
  if (!input) return;
  input.type = visible ? "text" : "password";
  btn.setAttribute("aria-pressed", visible ? "true" : "false");
  const label = visible ? "Ocultar contraseña" : "Mostrar contraseña";
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

const ENCRYPTION_TEXT = {
  open: "Copias cifradas y abiertas: lo que copies se guarda cifrado, con sus nombres. Al cerrar Kopia Desk se vuelve a pedir la contraseña.",
  locked: "Las copias de este disco están cifradas. Escribe la contraseña (o la clave de recuperación) para copiar o restaurar.",
  off: "Las copias en este disco NO están cifradas: si se pierde, cualquiera puede ver tus archivos y sus nombres. Cifrarlas es opcional.",
  plain:
    "Las copias en este disco no están cifradas. Para tener copias cifradas usa otro disco (o uno vacío): " +
    "Kopia Desk no mezcla copias cifradas y sin cifrar en el mismo disco.",
  unknown: "No se pudo comprobar si las copias de este disco están cifradas.",
};

const JOB_TEXT = {
  enabling: "Preparando el cifrado...",
  unlocking: "Comprobando la contraseña...",
  ejecting: "Expulsando el disco...",
};

// "open", "locked", "off" (sin backup, se puede cifrar), "plain" (con backup
// sin cifrar), "unknown", o null mientras se consulta.
function encryptionState(enc) {
  if (!enc) return null;
  if (enc.error) return "unknown";
  if (enc.encrypted) return enc.unlocked ? "open" : "locked";
  return enc.plainBackup ? "plain" : "off";
}

// La operación en curso, sólo si es del disco elegido ahora.
function currentEncryptionJob() {
  const job = state.encryptionJob;
  return job && state.destination && job.root === state.destination.root ? job : null;
}

function resetEncryptionPanel() {
  state.encryption = null;
  clearPasswordFields();
  els.encryptionPanel.hidden = true;
}

function renderEncryptionPanel() {
  els.encryptionPanel.hidden = !state.destination;
  if (!state.destination) return;

  const buttons = [
    els.encryptBtn,
    els.skipEncryptBtn,
    els.showEncryptBtn,
    els.unlockBtn,
    els.lockBtn,
    els.changePasswordBtn,
    els.ejectBtn,
  ];
  buttons.forEach((b) => (b.hidden = true));
  delete els.encryptionPanel.dataset.collapsed;
  els.encryptPasswordBox.hidden = true;
  els.unlockBox.hidden = true;
  els.lockAfterLabel.hidden = true;
  els.encryptionRecheckBtn.hidden = false;

  const job = currentEncryptionJob();
  if (job) {
    els.encryptionPanel.dataset.state = "job";
    els.encryptionStatus.textContent = JOB_TEXT[job.phase] || "Trabajando...";
    els.encryptionRecheckBtn.hidden = true;
    return;
  }

  const st = encryptionState(state.encryption);
  if (!st) {
    els.encryptionPanel.dataset.state = "checking";
    els.encryptionStatus.textContent = "Comprobando si las copias están cifradas...";
    els.encryptionRecheckBtn.hidden = true;
    return;
  }

  els.encryptionPanel.dataset.state = st;
  const bus = state.destination.busType;
  // Expulsar: sólo para discos USB. Un disco interno no se expulsa; si aún no
  // se sabe el tipo, se muestra (la app igual se negaría a expulsar algo que
  // Windows no marque como extraíble).
  // Una unidad de VeraCrypt se desmonta en VeraCrypt, no se expulsa.
  const canEject =
    !isSystemProtectedDestination() &&
    !state.destination.veracrypt &&
    (bus === undefined || bus === "Unknown" || bus === "USB");

  // "Omitir por ahora": el aviso queda en una línea con "Cifrar…" para volver
  // a abrirlo. Se recuerda para ese disco.
  if ((st === "off" || st === "plain") && encryptionSkippedHere()) {
    els.encryptionPanel.dataset.collapsed = "1";
    els.encryptionStatus.textContent = "Copias sin cifrar.";
    els.showEncryptBtn.hidden = st !== "off";
    els.ejectBtn.hidden = !canEject;
    els.encryptionRecheckBtn.hidden = true;
    els.ejectBtn.disabled = state.busy;
    return;
  }

  els.encryptionStatus.textContent = ENCRYPTION_TEXT[st];
  if (st === "off") {
    els.encryptBtn.hidden = false;
    els.encryptPasswordBox.hidden = false;
  }
  els.skipEncryptBtn.hidden = !(st === "off" || st === "plain");
  if (st === "locked") {
    els.unlockBox.hidden = false;
    els.unlockBtn.hidden = false;
  }
  if (st === "open") {
    els.lockBtn.hidden = false;
    els.changePasswordBtn.hidden = false;
    els.lockAfterLabel.hidden = false;
  }
  els.ejectBtn.hidden = !canEject;

  // Durante un backup no se cierra, cambia ni expulsa el disco que se está usando.
  [els.unlockBtn, els.lockBtn, els.changePasswordBtn, els.ejectBtn].forEach((b) => (b.disabled = state.busy));
  renderPasswordStrength();
}

function encryptionSkippedHere() {
  const id = state.destination && state.destination.volumeId;
  return !!(id && state.encryptionSkipped[id]);
}

function setEncryptionSkipped(skipped) {
  const id = state.destination && state.destination.volumeId;
  if (!id) return;
  if (skipped) state.encryptionSkipped[id] = true;
  else delete state.encryptionSkipped[id];
  if (!skipped) clearPasswordFields();
  renderEncryptionPanel();
  saveState();
}

async function checkEncryption() {
  if (!state.destination) return;
  const root = state.destination.root;
  // Una contraseña escrita para otro disco no se usa en este.
  if (state.passwordFor !== root) {
    clearPasswordFields();
    state.passwordFor = root;
  }
  state.encryption = null;
  renderEncryptionPanel();
  updateCounts();
  let status;
  try {
    status = await window.kopiaAPI.cryptoStatus(root);
  } catch (error) {
    status = { error: error.message };
  }
  // El usuario pudo cambiar de disco mientras se consultaba.
  if (!state.destination || state.destination.root !== root) return;
  state.encryption = status;
  renderEncryptionPanel();
  updateCounts();
}

// Al abrir o cerrar las copias cifradas cambia lo que se puede leer del disco:
// el último backup y las listas de Comparar y Restaurar.
async function afterCryptoChange(root) {
  await checkEncryption();
  if (state.destination && state.destination.root === root) {
    loadLastBackup();
    refreshActiveExtraTab();
  }
}

function setEncryptionJob(job) {
  state.encryptionJob = job;
  renderEncryptionPanel();
  updateCounts();
}

// Ejecuta `work` mostrando `phase` en el panel mientras dura.
async function withEncryptionJob(action, phase, work) {
  const root = state.destination.root;
  const job = { root, action, phase };
  setEncryptionJob(job);
  try {
    return await work(root);
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (state.encryptionJob === job) setEncryptionJob(null);
  }
}

async function enableEncryption(password) {
  if (!state.destination) return;
  const root = state.destination.root;
  const result = await withEncryptionJob("Enable", "enabling", (r) => window.kopiaAPI.cryptoEnable(r, password));
  if (!result.ok) {
    log("No se pudieron cifrar las copias de " + root + ": " + result.error);
    await checkEncryption();
    return;
  }
  log("Las copias en " + root + " se guardarán cifradas. Guarda la clave de recuperación fuera de este disco.");
  showRecoveryKey(root, result.recoveryKey);
  await afterCryptoChange(root);
}

function showRecoveryKey(root, recoveryKey) {
  els.recoveryDialogDrive.textContent = root;
  els.recoveryKeyText.textContent = recoveryKey;
  els.recoverySavedToggle.checked = false;
  els.recoveryDoneBtn.disabled = true;
  els.recoveryCopyBtn.textContent = "Copiar";
  els.recoveryDialog.showModal();
}

async function copyRecoveryKey() {
  const text = els.recoveryKeyText.textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Sin permiso de portapapeles: se selecciona el texto para copiarlo a mano.
    const range = document.createRange();
    range.selectNodeContents(els.recoveryKeyText);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("copy");
  }
  els.recoveryCopyBtn.textContent = "Copiada";
}

async function unlockCurrentDrive() {
  if (!state.destination) return;
  const secret = els.unlockPassword.value;
  if (!secret) {
    els.unlockError.textContent = "Escribe la contraseña o la clave de recuperación.";
    els.unlockPassword.focus();
    return;
  }
  const root = state.destination.root;
  const result = await withEncryptionJob("Unlock", "unlocking", (r) => window.kopiaAPI.cryptoUnlock(r, secret));
  els.unlockPassword.value = "";
  if (!result.ok) {
    renderEncryptionPanel();
    els.unlockError.textContent = result.error;
    els.unlockPassword.focus();
    return;
  }
  els.unlockError.textContent = "";
  log("Copias cifradas de " + root + " abiertas.");
  await afterCryptoChange(root);
}

async function lockCurrentDrive() {
  if (!state.destination) return false;
  const root = state.destination.root;
  try {
    await window.kopiaAPI.cryptoLock(root);
  } catch (error) {
    log("No se pudieron cerrar las copias cifradas: " + error.message);
    return false;
  }
  log("Copias cifradas de " + root + " cerradas. Para volver a usarlas, escribe la contraseña.");
  await afterCryptoChange(root);
  return true;
}

function renderChangePasswordStrength() {
  const d = describeNewPassword(els.chgPassword1.value, els.chgPassword2.value);
  els.chgPasswordStrength.textContent = d.text;
  els.chgPasswordStrength.dataset.level = d.level;
  els.changePasswordConfirm.disabled = !d.valid;
}

function closeChangePasswordDialog() {
  els.chgPassword1.value = "";
  els.chgPassword2.value = "";
  renderChangePasswordStrength();
  if (els.changePasswordDialog.open) els.changePasswordDialog.close();
}

// Si se conectó o quitó un disco durante una expulsión y el flujo no terminó
// recargando la lista (falló, o se cambió de destino mientras tanto), se
// actualiza ahora. Si ya hay una recarga en marcha, ella misma atiende el
// aviso al terminar.
function flushPendingDriveRefresh() {
  const ready = () =>
    state.drivesChangedPending && !state.busy && !state.encryptionJob && !state.ejecting &&
    !drivesRefreshRunning && !drivesLoading;
  if (ready()) {
    setTimeout(() => {
      if (ready()) refreshDrivesKeepingSelection().catch((e) => log(e.message));
    }, 0);
  }
}

async function ejectCurrentDrive() {
  if (!state.destination) return;
  const root = state.destination.root;
  const volumeId = state.destination.volumeId;
  const job = { root, action: "Eject", phase: "ejecting" };
  // Mientras se expulsa, el aviso de Windows de "disco quitado" no recarga la
  // lista por su cuenta: la recarga se hace aquí al final.
  state.ejecting = true;
  setEncryptionJob(job);
  try {
    let result;
    try {
      result = await window.kopiaAPI.ejectDrive(root, volumeId);
    } catch (error) {
      result = { ok: false, error: error.message };
    } finally {
      if (state.encryptionJob === job) setEncryptionJob(null);
    }
    if (!result.ok) {
      log("No se pudo expulsar " + root + ": " + result.error);
      return;
    }
    log("Disco " + root + " expulsado. Ya puedes desconectarlo con seguridad. Al volver a conectarlo se elegirá solo.");
    rememberLostDestination(state.destination);
    // Windows tarda un momento en quitar la letra: se espera antes de releer.
    for (let i = 0; i < 10; i++) {
      const drives = await window.kopiaAPI.listDrives().catch(() => []);
      if (!drives.some((d) => d.root === root)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    state.drivesChangedPending = false;
    await loadDrives();
    await selectDestination();
    saveState();
  } finally {
    state.ejecting = false;
    flushPendingDriveRefresh();
  }
}

els.encPassword1.addEventListener("input", renderPasswordStrength);
els.encPassword2.addEventListener("input", renderPasswordStrength);

els.ejectBtn.addEventListener("click", () => {
  if (state.busy || currentEncryptionJob() || isSystemProtectedDestination()) return;
  ejectCurrentDrive().catch((e) => log(e.message));
});

els.encryptBtn.addEventListener("click", () => {
  if (!state.destination || state.busy || currentEncryptionJob()) return;
  if (!newPasswordValid()) {
    renderPasswordStrength();
    els.encPassword1.focus();
    return;
  }
  els.encryptDialogDrive.textContent = state.destination.root;
  els.encryptDialog.showModal();
});

els.encryptDialogCancel.addEventListener("click", () => els.encryptDialog.close());

els.encryptDialogConfirm.addEventListener("click", () => {
  els.encryptDialog.close();
  if (!state.destination || state.busy || !newPasswordValid()) return;
  // La contraseña sale de los campos y se borran en el acto: no queda en la
  // pantalla ni en el estado de la app.
  const password = els.encPassword1.value;
  clearPasswordFields();
  enableEncryption(password).catch((e) => log(e.message));
});

els.recoveryCopyBtn.addEventListener("click", () => {
  copyRecoveryKey().catch((e) => log(e.message));
});
els.recoverySavedToggle.addEventListener("change", () => {
  els.recoveryDoneBtn.disabled = !els.recoverySavedToggle.checked;
});
// Sin confirmar que se guardó, Esc no cierra la ventana de la clave.
els.recoveryDialog.addEventListener("cancel", (event) => {
  if (!els.recoverySavedToggle.checked) event.preventDefault();
});
els.recoveryDialog.addEventListener("close", () => {
  els.recoveryKeyText.textContent = "";
});
els.recoveryDoneBtn.addEventListener("click", () => {
  if (els.recoverySavedToggle.checked) els.recoveryDialog.close();
});

els.unlockBtn.addEventListener("click", () => {
  if (state.busy || currentEncryptionJob()) return;
  unlockCurrentDrive().catch((e) => log(e.message));
});
els.unlockPassword.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || state.busy || currentEncryptionJob()) return;
  event.preventDefault();
  unlockCurrentDrive().catch((e) => log(e.message));
});
els.unlockPassword.addEventListener("input", () => {
  els.unlockError.textContent = "";
});

els.lockBtn.addEventListener("click", () => {
  if (state.busy) return;
  lockCurrentDrive().catch((e) => log(e.message));
});

els.lockAfterToggle.addEventListener("change", saveState);

els.changePasswordBtn.addEventListener("click", () => {
  if (state.busy || !state.destination) return;
  closeChangePasswordDialog();
  els.changePasswordDialog.showModal();
  els.chgPassword1.focus();
});
els.chgPassword1.addEventListener("input", renderChangePasswordStrength);
els.chgPassword2.addEventListener("input", renderChangePasswordStrength);
els.changePasswordCancel.addEventListener("click", closeChangePasswordDialog);
els.changePasswordDialog.addEventListener("close", () => {
  els.chgPassword1.value = "";
  els.chgPassword2.value = "";
});
els.changePasswordConfirm.addEventListener("click", async () => {
  if (!state.destination) return;
  const root = state.destination.root;
  const d = describeNewPassword(els.chgPassword1.value, els.chgPassword2.value);
  if (!d.valid) return;
  const password = els.chgPassword1.value;
  closeChangePasswordDialog();
  try {
    const result = await window.kopiaAPI.cryptoChangePassword(root, password);
    log(result.ok ? "Contraseña de las copias de " + root + " cambiada." : "No se pudo cambiar la contraseña: " + result.error);
  } catch (error) {
    log("No se pudo cambiar la contraseña: " + error.message);
    await checkEncryption();
  }
});

els.skipEncryptBtn.addEventListener("click", () => {
  setEncryptionSkipped(true);
  log("Aviso de cifrado plegado para " + state.destination.root + ". Puedes cifrar las copias cuando quieras con «Cifrar…».");
});
els.showEncryptBtn.addEventListener("click", () => {
  setEncryptionSkipped(false);
  els.encPassword1.focus();
});

els.encryptionRecheckBtn.addEventListener("click", () => {
  checkEncryption().catch((e) => log(e.message));
});

// --- Aviso de backup interrumpido (journal) ---------------------------------

function showJournalNotice(info) {
  const when = info.lastInterruptedAt
    ? new Date(info.lastInterruptedAt).toLocaleString()
    : "fecha desconocida";
  state.journalPending = true;
  els.journalNoticeText.textContent =
    "Se detectó un backup anterior interrumpido (" + when + "). Quedaron " +
    info.pendingFiles + " archivo(s) a medio copiar. Se recomienda eliminarlos " +
    "para liberar espacio y evitar copias corruptas — tus backups completos no se tocan.";
  els.journalNotice.hidden = false;
}

async function cleanInterruptedJournal() {
  const result = await window.kopiaAPI.journalCheck(state.destination.root);
  state.journalPending = false;
  els.journalNotice.hidden = true;
  return result;
}

els.journalCleanBtn.addEventListener("click", async () => {
  if (!state.destination) return;
  if (state.busy) {
    log("Espera a que termine la operación en curso antes de limpiar.");
    return;
  }
  try {
    const result = await cleanInterruptedJournal();
    log(
      "Limpieza del backup interrumpido completada: se eliminaron " +
        result.filesCleaned + " archivo(s) parcial(es)."
    );
  } catch (error) {
    log("No se pudo limpiar el backup interrumpido: " + error.message);
  }
});

els.journalSkipBtn.addEventListener("click", () => {
  els.journalNotice.hidden = true;
  log("Limpieza pospuesta. Se volverá a avisar la próxima vez que elijas este disco.");
});

// compareManifests() vive en compare.js (cargado antes que este script en
// index.html) para poder probarla con `node --test` sin un DOM real.

const SKIP_REASONS = {
  enlace: "Enlace o junction (no se sigue)",
  "sin-permiso": "Sin permiso de lectura",
  ilegible: "No se pudo leer",
};

async function scanAll() {
  if (state.busy || !state.sources.length) {
    if (!state.sources.length) log("Añade al menos una carpeta antes de escanear.");
    return;
  }
  if (state.destination && !requireOpenBackup()) return;

  // El escaneo trae los tamaños de todas formas: las mediciones que aún
  // esperaban turno se cancelan (no se recorre dos veces la misma carpeta).
  for (const size of Object.values(state.sourceSizes)) {
    if (size.status === "measuring") size.token = null;
  }

  setBusy(true);
  state.comparisons = [];
  state.suspiciousAcknowledged = false;
  els.suspiciousAckCheckbox.checked = false;
  const excludePatterns = getExcludePatterns();

  const emptyMsg = document.createElement("div");
  emptyMsg.className = "changes-view empty-state";
  const h = document.createElement("h3");
  h.textContent = "Escaneando...";
  const p = document.createElement("p");
  p.textContent = "Esto puede tardar si hay muchas subcarpetas.";
  emptyMsg.appendChild(h);
  emptyMsg.appendChild(p);
  els.changesView.textContent = "";
  els.changesView.className = "changes-view empty-state";
  els.changesView.appendChild(h);
  els.changesView.appendChild(p);

  // Cada carpeta se escanea en su propio try/catch: si una falla (p. ej. un
  // origen desconectado), las demás igual se muestran en vez de perderse todas
  // porque una excepción cortaba el loop antes de llegar a renderComparisons().
  let failures = 0;
  try {
    for (let i = 0; i < state.sources.length; i++) {
      const source = state.sources[i];
      try {
        log("Escaneando " + source.name + "...");
        showProgress("Escaneando...", i, state.sources.length, source.name);

        let previous = {};
        if (state.destination) {
          const loaded = await window.kopiaAPI.loadManifest(state.destination.root, source.name);
          previous = loaded.manifest;
          if (loaded.warning) log("Atención: " + loaded.warning);
        }

        const scan = await window.kopiaAPI.scanDirectory(source.path, excludePatterns, state.excludePaths);
        const current = scan.files;

        const hashConcurrency = await window.kopiaAPI.hashConcurrency(source.path).catch(() => 1);
        const diff = await compareManifests(
          current,
          previous,
          els.hashToggle.checked,
          window.kopiaAPI.hashFile,
          (checked, total, filePath) => showProgress("Comparando contenido...", checked, total, filePath),
          hashConcurrency
        );

        const skipped = scan.skipped.map((s) => ({ path: s.path, detail: SKIP_REASONS[s.reason] || s.reason }));

        state.comparisons.push({
          sourceName: source.name,
          sourcePath: source.path,
          manifest: current,
          previousManifest: previous,
          ...diff,
          skipped,
          excludedCount: scan.excluded,
          excludedItems: (scan.excludedItems || []).map((i) => ({
            path: i.path,
            detail: (i.folder ? "carpeta" : "archivo") + " · " + (i.rule === "elegido en Excluir" ? i.rule : "regla " + i.rule),
          })),
          decisions: { new: true, changed: true, missing: false },
        });
        log(
          source.name +
            ": " +
            diff.newFiles.length +
            " nuevos, " +
            diff.changedFiles.length +
            " cambiados, " +
            diff.missingFiles.length +
            " eliminados." +
            (skipped.length ? " " + skipped.length + " omitido(s) (ver detalle)." : "") +
            (scan.excluded ? " " + scan.excluded + " excluido(s) por filtros." : "")
        );
      } catch (error) {
        failures++;
        log("Error escaneando '" + source.name + "': " + error.message + " — se continúa con las demás carpetas.");
      }
    }
  } finally {
    sizesFromComparisons();
    // Una carpeta cuyo escaneo falló y cuya medición se canceló: se mide ahora.
    for (const source of state.sources) {
      const size = state.sourceSizes[source.path];
      if (size && size.status === "measuring" && size.token === null) measureSource(source);
    }
    renderSources();
    renderComparisons();
    if (failures) {
      log(failures + " carpeta(s) no se pudieron escanear. Las demás se muestran igual.");
    }
    setBusy(false);
    hideProgress();
  }
}

function renderComparisons() {
  updateCounts();
  els.changesView.textContent = "";

  if (!state.comparisons.length) {
    els.changesView.className = "changes-view empty-state";
    const h = document.createElement("h3");
    h.textContent = "Listo para escanear";
    const p = document.createElement("p");
    p.textContent = "Agrega carpetas, elige destino y ejecuta el escaneo.";
    els.changesView.appendChild(h);
    els.changesView.appendChild(p);
    return;
  }

  els.changesView.className = "changes-view";

  state.comparisons.forEach((comparison) => {
    const node = els.folderTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector("h3").textContent = comparison.sourceName;
    node.querySelector("p").textContent =
      Object.keys(comparison.manifest).length + " archivos revisados";

    const stats = node.querySelector(".folder-stats");
    stats.textContent = "";
    const badges = [
      {
        cls: "new",
        text: comparison.newFiles.length + " nuevos",
        tip: "Archivos que no estaban en el último backup",
      },
      {
        cls: "changed",
        text: comparison.changedFiles.length + " cambiados",
        tip: "Archivos modificados desde el último backup",
      },
      {
        cls: "missing",
        text: comparison.missingFiles.length + " faltantes",
        tip: "Archivos que ya no están en tu PC (siguen guardados en el backup)",
      },
    ];
    badges.forEach((b) => {
      const span = document.createElement("span");
      span.className = "badge " + b.cls;
      span.textContent = b.text;
      span.title = b.tip;
      stats.appendChild(span);
    });

    node.querySelectorAll(".decision-row input").forEach((input) => {
      input.checked = comparison.decisions[input.dataset.kind];
      input.addEventListener("change", () => {
        comparison.decisions[input.dataset.kind] = input.checked;
        updateCounts();
      });
    });

    const groups = node.querySelector(".file-groups");
    groups.appendChild(
      fileGroup("Nuevos", comparison.newFiles, "Archivos que no estaban en el último backup.")
    );
    groups.appendChild(
      fileGroup("Cambiados", comparison.changedFiles, "Archivos modificados desde el último backup.")
    );
    groups.appendChild(
      fileGroup(
        "Eliminados del origen",
        comparison.missingFiles,
        "Ya no están en tu PC, pero siguen guardados en el backup: no se borra nada."
      )
    );
    if (comparison.skipped.length) {
      groups.appendChild(
        fileGroup(
          "Omitidos (no se respaldan)",
          comparison.skipped,
          "Enlaces, carpetas sin permiso o archivos que no se pudieron leer. No quedan en el backup."
        )
      );
    }
    if (comparison.excludedItems && comparison.excludedItems.length) {
      groups.appendChild(
        fileGroup(
          "Excluidos por filtros",
          comparison.excludedItems,
          "No se copian por una regla de la tarjeta Excluir (desmárcala allí para copiarlos). Una carpeta excluida cuenta como uno."
        )
      );
    }
    els.changesView.appendChild(node);
  });
}

function fileGroup(title, files, hint) {
  const details = document.createElement("details");
  details.className = "file-group";
  details.open = files.length > 0 && files.length <= 8;

  const summary = document.createElement("summary");
  summary.title = hint;
  const titleSpan = document.createElement("span");
  titleSpan.textContent = title;
  const countSpan = document.createElement("span");
  countSpan.textContent = files.length;
  summary.appendChild(titleSpan);
  summary.appendChild(countSpan);
  details.appendChild(summary);

  const list = document.createElement("div");
  list.className = "file-list";

  if (!files.length) {
    const row = document.createElement("div");
    row.className = "file-row";
    const strong = document.createElement("strong");
    strong.textContent = "Sin archivos";
    const empty = document.createElement("span");
    const hintSpan = document.createElement("span");
    hintSpan.textContent = hint;
    row.appendChild(strong);
    row.appendChild(empty);
    row.appendChild(hintSpan);
    list.appendChild(row);
  } else {
    files.slice(0, MAX_RENDERED_FILES).forEach((file) => {
      const row = document.createElement("div");
      row.className = "file-row";
      const nameEl = document.createElement("strong");
      nameEl.textContent = file.path;
      nameEl.title = file.path;
      const sizeEl = document.createElement("span");
      sizeEl.textContent = file.size != null ? formatBytes(file.size) : "";
      const dateEl = document.createElement("span");
      dateEl.textContent = file.detail || (file.lastModified ? new Date(file.lastModified).toLocaleString() : "");
      row.appendChild(nameEl);
      row.appendChild(sizeEl);
      row.appendChild(dateEl);
      list.appendChild(row);
    });
    if (files.length > MAX_RENDERED_FILES) {
      const row = document.createElement("div");
      row.className = "file-row";
      const more = document.createElement("strong");
      more.textContent = "+ " + (files.length - MAX_RENDERED_FILES) + " más";
      const empty = document.createElement("span");
      const note = document.createElement("span");
      note.textContent = "No se listan todos aquí; el detalle completo queda en el log del backup.";
      row.appendChild(more);
      row.appendChild(empty);
      row.appendChild(note);
      list.appendChild(row);
    }
  }

  details.appendChild(list);
  return details;
}

function computePlannedBytes() {
  // Los archivos que no caben en el sistema de archivos destino (FAT32: 4 GB)
  // se omiten al copiar, así que no cuentan para el espacio necesario: si no,
  // un solo archivo grande bloquearía por "falta de espacio" todo el backup.
  const max = (state.destination && state.destination.maxFileSize) || 0;
  const sumar = (files) => files.reduce((t, f) => t + (max && f.size > max ? 0 : f.size), 0);
  let bytes = 0;
  for (const comparison of state.comparisons) {
    if (comparison.decisions.new) {
      bytes += sumar(comparison.newFiles);
    }
    if (comparison.decisions.changed) {
      const changedBytes = sumar(comparison.changedFiles);
      bytes += changedBytes;
      if (els.versioningToggle.checked) bytes += changedBytes; // copia adicional de versión
    }
  }
  return bytes;
}

async function backupAll() {
  if (state.busy || !state.destination) {
    if (!state.destination) log("Elige un destino antes de copiar.");
    return;
  }

  // Doble chequeo: el botón ya se deshabilita en vivo cuando no hay espacio
  // (updateSpaceStatus), pero se vuelve a validar por si el disco se llenó
  // entre el escaneo y el clic.
  if (!updateSpaceStatus()) {
    log("Backup cancelado: espacio insuficiente en el destino.");
    updateCounts();
    return;
  }

  setBusy(true);

  // Si quedó un backup interrumpido sin limpiar (el usuario eligió "Ahora no"),
  // se limpia antes de copiar: si no, el journal viejo apuntaría a archivos que
  // esta corrida va a dejar completos y una limpieza posterior los borraría.
  if (state.journalPending) {
    try {
      const cleaned = await cleanInterruptedJournal();
      if (cleaned.filesCleaned > 0) {
        log(
          "Antes de copiar se eliminaron " + cleaned.filesCleaned +
            " archivo(s) parcial(es) del backup interrumpido."
        );
      }
    } catch (error) {
      log("No se pudo limpiar el backup interrumpido: " + error.message);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let completed = false;
  // Marca común a los informes de todas las carpetas de esta corrida ("Último backup").
  const runId = new Date().toISOString();
  let totalCopied = 0;
  let totalDeduped = 0;

  const dedup = els.dedupToggle.checked;

  // Concurrencia: se calcula una sola vez para toda la corrida (antes se
  // repetía por cada carpeta de origen, lanzando PowerShell de más — el
  // disco destino y su tipo no cambian entre carpetas de la misma corrida).
  const allSelectedFiles = state.comparisons.flatMap((c) => [
    ...(c.decisions.new ? c.newFiles : []),
    ...(c.decisions.changed ? c.changedFiles : []),
  ]);
  const overallAvgSize = allSelectedFiles.length
    ? allSelectedFiles.reduce((t, f) => t + f.size, 0) / allSelectedFiles.length
    : 0;
  let concurrency = 3;
  try {
    const plan = await window.kopiaAPI.planConcurrency(state.destination.root, overallAvgSize);
    concurrency = plan.concurrency;
  } catch {
    // se usa el valor por defecto
  }
  beginTiming(plannedCopyBytes());
  const op = startStoppable();
  let stopped = false;

  try {
    const maxFileSize = state.destination.maxFileSize || 0;
    for (const comparison of state.comparisons) {
      // Detenido: las carpetas que faltan se quedan para el próximo backup.
      if (stopRequested()) {
        stopped = true;
        break;
      }
      const wanted = [
        ...(comparison.decisions.new ? comparison.newFiles : []),
        ...(comparison.decisions.changed ? comparison.changedFiles : []),
      ];
      // FAT32: los de 4 GB o más fallarían; se omiten y se informan. Como no
      // entran al manifiesto, vuelven a aparecer en el próximo escaneo.
      const tooLarge = maxFileSize ? wanted.filter((f) => f.size > maxFileSize) : [];
      const selected = tooLarge.length ? wanted.filter((f) => f.size <= maxFileSize) : wanted;
      tooLarge.forEach((f) =>
        log("Omitido: " + comparison.sourceName + "/" + f.path + " — archivo de 4 GB o más en disco FAT32.")
      );
      const removingMissing = comparison.decisions.missing && comparison.missingFiles.length > 0;
      const touched = comparison.touchedFiles || [];

      // Aunque no haya nada para copiar, si el usuario aceptó "eliminados" hay
      // que seguir para actualizar el manifiesto (si no, esos archivos seguirían
      // marcándose como faltantes en cada escaneo aunque el usuario ya lo aceptó).
      // Igual con los "tocados" (fecha nueva, mismo contenido).
      if (!selected.length && !removingMissing && !touched.length) continue;

      const tasks = [];
      const versionTasks = [];
      const destRelativeOf = new Map();
      for (const item of selected) {
        const destRelative = BACKUP_ROOT + "/" + safeName(comparison.sourceName) + "/" + item.path;
        destRelativeOf.set(item.path, destRelative);
        tasks.push({
          srcPath: item.fullPath,
          destRoot: state.destination.root,
          relativeDest: destRelative,
          size: item.size,
        });

        // Versionado: se comprime el archivo que YA está en el backup (la
        // versión anterior) antes de que la copia nueva lo sobrescriba. Por eso
        // el origen es la ruta dentro del backup, no el archivo del PC.
        if (els.versioningToggle.checked && item.previous) {
          const versionRelative =
            BACKUP_ROOT +
            "/.kopia-data/versions/" +
            stamp +
            "/" +
            safeName(comparison.sourceName) +
            "/" +
            item.path;
          versionTasks.push({
            srcPath: joinDestPath(state.destination.root, destRelative),
            destRoot: state.destination.root,
            relativeDest: versionRelative,
            size: item.previous.size || 0,
          });
        }
      }

      // relativeDest -> SHA-256 de lo que se copió y verificó.
      const doneHashes = new Map();
      let copyErrors = [];

      if (tasks.length) {
        if (versionTasks.length) {
          const versionResult = await window.kopiaAPI.backupCopyVersions(versionTasks, {
            destVolumeId: state.destination.volumeId,
            opId: op.id,
          });
          // Las versiones también cuentan en el tiempo (ver plannedCopyBytes).
          advanceTiming();
          if (versionResult.copied > 0) {
            log(
              comparison.sourceName + ": " + versionResult.copied +
                " versión(es) anterior(es) guardada(s) comprimida(s)."
            );
          }
          if (versionResult.errors.length) {
            versionResult.errors.forEach((e) => log("Error al guardar versión: " + e.file + " — " + e.error));
          }
        }

        // Si se detuvo mientras se guardaban las versiones, no se empieza a copiar.
        const result = stopRequested()
          ? { copied: 0, deduped: 0, done: [], errors: [], stopped: true }
          : await window.kopiaAPI.backupCopyFiles(tasks, {
              dedup,
              concurrency,
              destVolumeId: state.destination.volumeId,
              opId: op.id,
            });
        advanceTiming();
        if (result.stopped) stopped = true;
        // Sólo si la app midió en este disco que 2 a la vez va más rápido (ver runTasks).
        if (result.probe && result.concurrency > 1) {
          log(comparison.sourceName + ": se copiaron " + result.concurrency + " archivos a la vez (medido más rápido en este disco).");
        }
        totalCopied += result.copied;
        totalDeduped += result.deduped || 0;
        (result.done || []).forEach((d) => doneHashes.set(d.relativeDest, d.hash));
        copyErrors = result.errors;

        if (result.errors.length) {
          result.errors.forEach((e) => log("Error: " + e.file + " — " + e.error));
        }
      }

      // Sólo se registran como respaldados los archivos que de verdad se
      // copiaron y verificaron. Un nuevo que falló no entra (vuelve a salir
      // como nuevo); un cambiado que falló conserva su entrada anterior
      // (vuelve a salir como cambiado).
      const nextManifest = { ...comparison.previousManifest };
      let registered = 0;
      selected.forEach((item) => {
        const hash = doneHashes.get(destRelativeOf.get(item.path));
        if (!hash) return;
        const entry = { ...comparison.manifest[item.path] };
        delete entry.fullPath;
        delete entry.quickHash;
        entry.hash = hash;
        nextManifest[item.path] = entry;
        registered++;
      });
      touched.forEach((item) => {
        if (nextManifest[item.path] && nextManifest[item.path].hash === item.hash) {
          nextManifest[item.path] = { ...nextManifest[item.path], lastModified: item.lastModified };
        }
      });
      if (comparison.decisions.missing) {
        comparison.missingFiles.forEach((item) => delete nextManifest[item.path]);
      }

      await window.kopiaAPI.saveManifest(state.destination.root, comparison.sourceName, nextManifest);
      await window.kopiaAPI
        .rememberSourcePath(state.destination.root, comparison.sourceName, comparison.sourcePath)
        .catch(() => {});

      const report = {
        run: runId,
        date: new Date().toISOString(),
        source: comparison.sourceName,
        copied: registered,
        failed: copyErrors.map((e) => ({ file: e.file, error: e.error })),
        tooLargeForFileSystem: tooLarge.map((f) => f.path),
        skippedByScan: comparison.skipped,
        excludedByFilters: comparison.excludedCount || 0,
        skippedNew: comparison.decisions.new ? 0 : comparison.newFiles.length,
        skippedChanged: comparison.decisions.changed ? 0 : comparison.changedFiles.length,
        missingRegistered: comparison.decisions.missing
          ? comparison.missingFiles.map((f) => f.path)
          : [],
      };
      await window.kopiaAPI.logSave(state.destination.root, comparison.sourceName, report);
      const notDone = selected.length - registered;
      log(
        comparison.sourceName + ": " + registered + " archivos copiados y verificados." +
          (notDone > 0
            ? " " + notDone + (stopped ? " quedan para el próximo backup (copia detenida)." : " no se pudieron copiar (se reintentarán en el próximo backup).")
            : "") +
          (removingMissing ? " Eliminados registrados: " + comparison.missingFiles.length + "." : "")
      );
    }

    state.copied = totalCopied;
    state.deduped = totalDeduped;
    updateCounts();
    let summary = (stopped ? "Copia detenida: " : "Copia finalizada: ") + totalCopied + " archivos.";
    if (totalDeduped > 0) summary += " (" + totalDeduped + " deduplicados sin copiar bytes nuevos)";
    const measure = endTiming();
    if (measure && measure.bytes > 0) summary += " Tardó " + formatClock(measure.seconds) + ".";
    rememberDiskSpeed(measure);
    if (stopped) summary += " Lo que faltó se copiará en el próximo backup (vuelve a escanear).";
    log(summary);
    completed = !stopped;
    if (completed) await copyPortableToDisk();
    loadLastBackup();
    // Si la app está en segundo plano, aviso de Windows.
    window.kopiaAPI.notify(stopped ? "Copia detenida" : "Copia terminada", summary).catch(() => {});
  } catch (error) {
    log("Error en backup: " + error.message);
  } finally {
    endStoppable();
    setBusy(false);
    hideProgress();
  }

  // El disco tiene ahora menos espacio libre: se vuelve a leer.
  refreshDrivesKeepingSelection().catch(() => {});

  // Cerrar las copias cifradas al terminar (la próxima vez se pide la contraseña).
  if (completed && els.lockAfterToggle.checked && encryptionState(state.encryption) === "open") {
    await lockCurrentDrive();
  }
}

// Al terminar un backup, deja en el disco Kopia Desk portable (si falta o es de
// otra versión) para abrir las copias en otro PC sin instalar nada.
async function copyPortableToDisk() {
  if (!state.destination) return;
  try {
    const r = await window.kopiaAPI.ensurePortable(state.destination.root, state.destination.volumeId);
    if (r.copied) {
      log("Kopia Desk portable guardada en el disco (KopiaDesk_Backup\\Kopia Desk (portable).exe): en otro PC se abre sin instalar nada.");
    } else if (r.reason === "sin-espacio") {
      log("No se guardó Kopia Desk portable en el disco: no queda espacio (" + formatBytes(r.size) + ").");
    } else if (r.reason === "en-uso") {
      log("Kopia Desk portable del disco está abierta: no se actualizó (se hará en el próximo backup).");
    } else if (r.reason === "error") {
      log("No se pudo guardar Kopia Desk portable en el disco: " + r.error);
    }
  } catch (error) {
    log("No se pudo guardar Kopia Desk portable en el disco: " + error.message);
  }
}

// --- Pestaña "Comparar": ejecutar la comparación de lo marcado -------------

async function compareSelected() {
  if (state.busy || !state.destination) {
    if (!state.destination) log("Selecciona un disco con backup para comparar.");
    return;
  }
  if (!requireOpenBackup()) return;

  const selected = state.compareSources
    .map((name) => ({ name, sel: state.compareSelection[name] }))
    .filter((x) => x.sel && x.sel.checked);

  if (!selected.length) {
    log("Marca al menos una carpeta para comparar.");
    return;
  }

  const missingLocal = selected.find((x) => !x.sel.localPath);
  if (missingLocal) {
    log("Elige la carpeta local de '" + missingLocal.name + "' antes de comparar.");
    return;
  }

  setBusy(true);
  els.compareResults.textContent = "";
  els.compareResults.className = "changes-view";

  try {
    for (const { name: sourceName, sel } of selected) {
      log("Comparando backup '" + sourceName + "' vs " + sel.localPath + "...");
      showProgress("Comparando...", 0, 1, sourceName);

      const result = await window.kopiaAPI.restoreScan(state.destination.root, sourceName, sel.localPath);
      await window.kopiaAPI.rememberSourcePath(state.destination.root, sourceName, sel.localPath).catch(() => {});
      if (result.warning) log("Atención: " + result.warning);

      // Archivos que figuran como respaldados pero ya no están en el disco de
      // backup (p. ej. borrados a mano de la copia). Se avisa y se ofrece
      // quitarlos del registro para que el próximo backup los vuelva a copiar.
      const lost = result.lostFromBackup || [];
      if (lost.length) {
        log(
          sourceName + ": atención, " + lost.length +
            " archivo(s) ya no están en el disco de backup aunque figuran como respaldados."
        );
        renderLostFilesCard(sourceName, lost);
      }

      if (!result.missing.length) {
        if (!lost.length) log(sourceName + ": todos los archivos están presentes en el PC.");
        const card = document.createElement("div");
        card.className = "restore-card";
        const header = document.createElement("header");
        const info = document.createElement("div");
        const h3 = document.createElement("h3");
        h3.textContent = sourceName;
        const p = document.createElement("p");
        p.textContent =
          result.totalChecked +
          " archivos verificados — todo presente en: " +
          sel.localPath;
        info.appendChild(h3);
        info.appendChild(p);
        header.appendChild(info);
        card.appendChild(header);
        els.compareResults.appendChild(card);
        continue;
      }

      log(
        sourceName +
          ": " +
          result.missing.length +
          " archivos no encontrados en el PC."
      );

      renderMissingFilesCard(sourceName, sel.localPath, result.missing);
    }
  } catch (error) {
    log("Error en comparación: " + error.message);
  } finally {
    setBusy(false);
    hideProgress();
  }
}

// Tarjeta para archivos que el registro da por respaldados pero ya no existen
// en el disco de backup. No se pueden restaurar desde aquí; la reparación es
// quitarlos del registro para que el próximo backup los detecte como nuevos.
function renderLostFilesCard(sourceName, lostFiles) {
  // Se fija el disco al momento de crear la tarjeta: si el usuario cambia el
  // destino después de comparar, el botón no debe escribir en el disco nuevo.
  const destRoot = state.destination.root;
  const card = document.createElement("div");
  card.className = "restore-card";

  const header = document.createElement("header");
  const info = document.createElement("div");
  const h3 = document.createElement("h3");
  h3.textContent = sourceName;
  const p = document.createElement("p");
  p.textContent =
    lostFiles.length +
    " archivo(s) figuran como respaldados pero ya no están en el disco de backup " +
    "(¿se borraron de la copia?). Los que sigan en tu carpeta original se pueden recopiar.";
  info.appendChild(h3);
  info.appendChild(p);
  const badge = document.createElement("span");
  badge.className = "badge changed";
  badge.textContent = lostFiles.length + " faltan en backup";
  badge.title = "Archivos que ya no están en el disco de backup aunque el registro dice que se copiaron";
  header.appendChild(info);
  header.appendChild(badge);
  card.appendChild(header);

  const actions = document.createElement("div");
  actions.className = "restore-actions";
  const repairBtn = document.createElement("button");
  repairBtn.className = "primary";
  repairBtn.textContent = "Recopiar en el próximo backup";
  repairBtn.title =
    "Los quita del registro para que el próximo escaneo de Backup los detecte como nuevos y los vuelva a copiar";
  repairBtn.style.width = "auto";
  repairBtn.style.padding = "0 20px";
  actions.appendChild(repairBtn);
  card.appendChild(actions);

  const fileList = document.createElement("div");
  fileList.className = "file-list";
  lostFiles.slice(0, MAX_RENDERED_FILES).forEach((file) => {
    const row = document.createElement("div");
    row.className = "file-row";
    const nameEl = document.createElement("strong");
    nameEl.textContent = file.path;
    nameEl.title = file.path;
    const sizeEl = document.createElement("span");
    sizeEl.textContent = formatBytes(file.size);
    const dateEl = document.createElement("span");
    dateEl.textContent = file.lastModified ? new Date(file.lastModified).toLocaleString() : "";
    row.appendChild(nameEl);
    row.appendChild(sizeEl);
    row.appendChild(dateEl);
    fileList.appendChild(row);
  });
  if (lostFiles.length > MAX_RENDERED_FILES) {
    const row = document.createElement("div");
    row.className = "file-row";
    const more = document.createElement("strong");
    more.textContent = "+ " + (lostFiles.length - MAX_RENDERED_FILES) + " más";
    row.appendChild(more);
    row.appendChild(document.createElement("span"));
    row.appendChild(document.createElement("span"));
    fileList.appendChild(row);
  }
  card.appendChild(fileList);
  els.compareResults.appendChild(card);

  repairBtn.addEventListener("click", async () => {
    if (state.busy) return;
    setBusy(true);
    repairBtn.disabled = true;
    try {
      const { manifest } = await window.kopiaAPI.loadManifest(destRoot, sourceName);
      lostFiles.forEach((file) => delete manifest[file.path]);
      await window.kopiaAPI.saveManifest(destRoot, sourceName, manifest);
      repairBtn.textContent = "Listos para recopiar";
      log(
        sourceName + ": " + lostFiles.length +
          " archivo(s) quitados del registro. Ve a la pestaña Backup, escanea y copia para recopiarlos."
      );
    } catch (error) {
      // Falló la reparación: se rehabilita para que el usuario pueda reintentar.
      repairBtn.disabled = false;
      log("No se pudo actualizar el registro: " + error.message);
    } finally {
      setBusy(false);
    }
  });
}

function renderMissingFilesCard(sourceName, localPath, missingFiles) {
  const destRoot = state.destination.root;
  const card = document.createElement("div");
  card.className = "restore-card";

  const header = document.createElement("header");
  const info = document.createElement("div");
  const h3 = document.createElement("h3");
  h3.textContent = sourceName;
  const p = document.createElement("p");
  p.textContent = missingFiles.length + " archivos no encontrados en: " + localPath;
  info.appendChild(h3);
  info.appendChild(p);
  const badge = document.createElement("span");
  badge.className = "badge missing";
  badge.textContent = missingFiles.length + " faltantes";
  header.appendChild(info);
  header.appendChild(badge);
  card.appendChild(header);

  const actions = document.createElement("div");
  actions.className = "restore-actions";

  const selectAllLabel = document.createElement("label");
  selectAllLabel.className = "restore-select-all";
  const selectAllCb = document.createElement("input");
  selectAllCb.type = "checkbox";
  selectAllCb.checked = true;
  const selectAllText = document.createElement("span");
  selectAllText.textContent = "Seleccionar todos";
  selectAllLabel.appendChild(selectAllCb);
  selectAllLabel.appendChild(selectAllText);

  const restoreSelectedBtn = document.createElement("button");
  restoreSelectedBtn.className = "primary";
  restoreSelectedBtn.textContent = "Restaurar seleccionados";
  restoreSelectedBtn.style.width = "auto";
  restoreSelectedBtn.style.padding = "0 20px";

  actions.appendChild(selectAllLabel);
  actions.appendChild(restoreSelectedBtn);
  card.appendChild(actions);

  const fileList = document.createElement("div");
  fileList.className = "file-list";

  // Selección por archivo sobre la lista COMPLETA de faltantes, no sólo los
  // renderizados: los que exceden MAX_RENDERED_FILES no tienen fila propia,
  // pero arrancan seleccionados y "Seleccionar todos" también los gobierna.
  // Antes sólo se restauraban los primeros 50 y el resto se omitía en silencio.
  const selection = new Map(missingFiles.map((file) => [file.path, true]));
  const checkboxes = [];

  missingFiles.slice(0, MAX_RENDERED_FILES).forEach((file) => {
    const row = document.createElement("div");
    row.className = "restore-file-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    checkboxes.push(cb);
    cb.addEventListener("change", () => selection.set(file.path, cb.checked));

    const nameEl = document.createElement("strong");
    nameEl.textContent = file.path;
    nameEl.title = file.path;
    const sizeEl = document.createElement("span");
    sizeEl.textContent = formatBytes(file.size);
    const dateEl = document.createElement("span");
    dateEl.textContent = new Date(file.lastModified).toLocaleString();

    row.appendChild(cb);
    row.appendChild(nameEl);
    row.appendChild(sizeEl);
    row.appendChild(dateEl);
    fileList.appendChild(row);
  });

  if (missingFiles.length > MAX_RENDERED_FILES) {
    const row = document.createElement("div");
    row.className = "restore-file-row";
    const spacer = document.createElement("span");
    const more = document.createElement("strong");
    more.textContent = "+ " + (missingFiles.length - MAX_RENDERED_FILES) + " más";
    const note = document.createElement("span");
    note.textContent = "También se restaurarán aunque no se listen aquí.";
    row.appendChild(spacer);
    row.appendChild(more);
    row.appendChild(note);
    fileList.appendChild(row);
  }

  card.appendChild(fileList);
  els.compareResults.appendChild(card);

  selectAllCb.addEventListener("change", () => {
    checkboxes.forEach((cb) => (cb.checked = selectAllCb.checked));
    for (const key of selection.keys()) selection.set(key, selectAllCb.checked);
  });

  restoreSelectedBtn.addEventListener("click", async () => {
    if (state.busy) return;
    const toRestore = missingFiles.filter((file) => selection.get(file.path));

    if (!toRestore.length) {
      log("No hay archivos seleccionados para restaurar.");
      return;
    }

    const targetDir = await window.kopiaAPI.selectRestoreTarget();
    if (!targetDir) return;

    setBusy(true);
    restoreSelectedBtn.disabled = true;
    try {
      const avgSize = toRestore.reduce((t, f) => t + (f.size || 0), 0) / toRestore.length;
      let concurrency = 3;
      try {
        const plan = await window.kopiaAPI.planConcurrency(destRoot, avgSize);
        concurrency = plan.concurrency;
      } catch {
        // se usa el valor por defecto
      }

      beginTiming(toRestore.reduce((t, f) => t + (Number(f.size) || 0), 0));
      const op = startStoppable();
      const result = await window.kopiaAPI
        .restoreCopyFiles(toRestore, targetDir, { concurrency, opId: op.id })
        .finally(endStoppable);
      endTiming();
      log((result.stopped ? "Restauración detenida. " : "") + "Restaurados: " + result.copied + " archivos a " + targetDir);
      if (result.errors.length) {
        result.errors.forEach((e) => log("Error restaurando: " + e.file + " — " + e.error));
      }
    } catch (error) {
      log("Error en restauración: " + error.message);
    } finally {
      setBusy(false);
      restoreSelectedBtn.disabled = false;
      hideProgress();
    }
  });
}

// --- Pestaña "Restaurar": traer una carpeta completa del backup a donde sea ---

// No depende de comparar contra una carpeta local: sirve justo cuando esa
// carpeta (o el usuario de Windows) ya no existe, por ejemplo tras formatear.
async function loadFullRestoreList() {
  els.restoreFullList.textContent = "";

  if (!state.destination) {
    els.restoreFullList.classList.add("empty");
    els.restoreFullList.textContent = "Selecciona un disco con backup.";
    return;
  }

  if (encryptionState(state.encryption) === "locked") {
    els.restoreFullList.classList.add("empty");
    els.restoreFullList.textContent = lockedBackupText();
    return;
  }

  try {
    const sources = await window.kopiaAPI.restoreListSources(state.destination.root);
    if (!sources.length) {
      els.restoreFullList.classList.add("empty");
      els.restoreFullList.textContent = "No se encontraron backups en " + state.destination.root;
      return;
    }

    els.restoreFullList.classList.remove("empty");
    sources.forEach((sourceName) => renderFullRestoreRow(sourceName));
  } catch (error) {
    els.restoreFullList.classList.add("empty");
    els.restoreFullList.textContent = lockedBackupText(error) || "Error al leer el backup: " + error.message;
  }
}

// Cada carpeta respaldada: elegir qué subcarpetas restaurar (árbol con
// casillas, ver restore-tree.js) y restaurarlas DENTRO de una carpeta con su
// nombre: "Capturas" vuelve como <destino>\Capturas\..., con sus subcarpetas.
function renderFullRestoreRow(sourceName) {
  const block = document.createElement("div");
  block.className = "restore-source";

  const row = document.createElement("div");
  row.className = "source-pill";

  const label = document.createElement("strong");
  label.textContent = sourceName;
  row.appendChild(label);

  const hintSpan = document.createElement("span");
  hintSpan.className = "pill-path";
  hintSpan.textContent = "Vuelve como la carpeta «" + restoreFolderName(sourceName) + "» donde elijas";
  row.appendChild(hintSpan);

  const pickBtn = document.createElement("button");
  pickBtn.type = "button";
  pickBtn.className = "ghost restore-pick-btn";
  pickBtn.textContent = "Elegir carpetas";
  pickBtn.setAttribute("aria-expanded", "false");
  row.appendChild(pickBtn);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "primary restore-go-btn";
  btn.textContent = "Restaurar todo a...";
  row.appendChild(btn);
  block.appendChild(row);

  const panel = document.createElement("div");
  panel.className = "restore-tree";
  panel.hidden = true;
  const summary = document.createElement("p");
  summary.className = "restore-tree-summary";
  const treeList = document.createElement("div");
  treeList.className = "restore-tree-list";
  treeList.setAttribute("role", "tree");
  panel.appendChild(summary);
  panel.appendChild(treeList);
  block.appendChild(panel);

  let tree = null;
  let selected = null;
  const shown = []; // [{ node, cb }] casillas dibujadas, para refrescarlas

  async function loadTree() {
    if (tree) return tree;
    const files = await window.kopiaAPI.restoreFullList(state.destination.root, sourceName);
    tree = buildFolderTree(sourceName, files);
    selected = allFolderPaths(tree);
    return tree;
  }

  function refreshChecks() {
    for (const { node, cb } of shown) {
      const st = folderState(selected, node);
      cb.checked = st === "all";
      cb.indeterminate = st === "some";
    }
    const chosen = filesForSelection(tree, selected);
    const bytes = chosen.reduce((t, file) => t + (Number(file.size) || 0), 0);
    const all = chosen.length === tree.fileCount;
    summary.textContent =
      (all ? "Se restaura todo: " : "Se restauran ") +
      formatCount(chosen.length, "archivo", "archivos") + (all ? "" : " de " + tree.fileCount.toLocaleString("es-ES")) +
      " (" + formatBytes(bytes) + "), dentro de la carpeta «" + restoreFolderName(sourceName) + "».";
    btn.textContent = all ? "Restaurar todo a..." : "Restaurar marcadas a...";
    btn.disabled = chosen.length === 0 || state.busy;
  }

  // Una fila del árbol; sus subcarpetas se dibujan al abrirla (carpetas con
  // miles de subcarpetas no se dibujan enteras de golpe).
  function renderNode(node, depth, container, open) {
    const item = document.createElement("div");
    item.className = "tree-item";
    item.setAttribute("role", "treeitem");

    const line = document.createElement("div");
    line.className = "tree-row";
    line.style.setProperty("--depth", String(depth));

    const kids = sortedChildren(node);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tree-toggle";
    if (!kids.length) toggle.classList.add("is-leaf");
    toggle.tabIndex = kids.length ? 0 : -1;
    toggle.setAttribute("aria-label", "Abrir " + (node.name || sourceName));

    const cbLabel = document.createElement("label");
    cbLabel.className = "tree-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = node.name || sourceName;
    cbLabel.appendChild(cb);
    cbLabel.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "tree-meta";
    meta.textContent = formatCount(node.fileCount, "archivo", "archivos") + " · " + formatBytes(node.bytes);

    line.appendChild(toggle);
    line.appendChild(cbLabel);
    line.appendChild(meta);
    item.appendChild(line);

    const childBox = document.createElement("div");
    childBox.setAttribute("role", "group");
    childBox.hidden = true;
    item.appendChild(childBox);
    container.appendChild(item);
    shown.push({ node, cb });

    cb.addEventListener("change", () => {
      setFolderSelected(selected, node, cb.checked);
      refreshChecks();
    });

    let drawn = false;
    const setOpen = (on) => {
      if (on && !drawn) {
        kids.forEach((child) => renderNode(child, depth + 1, childBox, false));
        drawn = true;
        refreshChecks();
      }
      childBox.hidden = !on;
      toggle.textContent = on ? "▾" : "▸";
      item.setAttribute("aria-expanded", on ? "true" : "false");
    };
    toggle.addEventListener("click", () => setOpen(childBox.hidden));
    setOpen(open);
  }

  pickBtn.addEventListener("click", async () => {
    const open = panel.hidden;
    panel.hidden = !open;
    pickBtn.setAttribute("aria-expanded", open ? "true" : "false");
    pickBtn.textContent = open ? "Ocultar carpetas" : "Elegir carpetas";
    if (!open || shown.length) return;
    summary.textContent = "Leyendo el backup…";
    try {
      await loadTree();
      if (!tree.fileCount) {
        summary.textContent = "El backup de esta carpeta no tiene archivos.";
        return;
      }
      renderNode(tree, 0, treeList, true);
      refreshChecks();
    } catch (error) {
      summary.textContent = "No se pudo leer el backup: " + error.message;
    }
  });

  btn.addEventListener("click", async () => {
    if (state.busy) return;
    let files;
    try {
      await loadTree();
      files = filesForSelection(tree, selected);
    } catch (error) {
      log("Error al leer el backup de '" + sourceName + "': " + error.message);
      return;
    }
    if (!files.length) {
      log(sourceName + ": no hay nada marcado para restaurar.");
      return;
    }

    const targetDir = await window.kopiaAPI.selectRestoreTarget();
    if (!targetDir) return;
    const folder = restoreFolderName(sourceName);
    const shownTarget = targetDir.replace(/[\\/]+$/, "") + "\\" + folder;

    setBusy(true);
    btn.disabled = true;
    try {
      log(sourceName + ": restaurando " + formatCount(files.length, "archivo", "archivos") + " en " + shownTarget + "...");

      const avgSize = files.reduce((t, file) => t + (file.size || 0), 0) / files.length;
      let concurrency = 3;
      try {
        const plan = await window.kopiaAPI.planConcurrency(state.destination.root, avgSize);
        concurrency = plan.concurrency;
      } catch {
        // se usa el valor por defecto
      }

      beginTiming(files.reduce((t, file) => t + (Number(file.size) || 0), 0));
      const op = startStoppable();
      const result = await window.kopiaAPI
        .restoreCopyFiles(withRestoreFolder(sourceName, files), targetDir, { concurrency, opId: op.id })
        .finally(endStoppable);
      endTiming();
      log(
        (result.stopped ? "Restauración detenida. " : "") +
          sourceName + ": restaurados " + result.copied + " de " + files.length + " archivo(s) en " + shownTarget
      );
      if (result.errors.length) {
        result.errors.forEach((e) => log("Error restaurando: " + e.file + " — " + e.error));
      }
    } catch (error) {
      log("Error al restaurar '" + sourceName + "': " + error.message);
    } finally {
      setBusy(false);
      btn.disabled = false;
      if (tree) refreshChecks();
      hideProgress();
    }
  });

  els.restoreFullList.appendChild(block);
}

async function saveState() {
  try {
    await window.kopiaAPI.saveSettings({
      sources: state.sources.map((s) => ({ name: s.name, path: s.path })),
      destinationRoot: state.destination?.root || state.lostDestination?.root || null,
      // Identidad del disco: al abrir la app se busca ese disco aunque cambie de letra.
      destinationVolumeId: state.destination?.volumeId || state.lostDestination?.volumeId || null,
      versioning: els.versioningToggle.checked,
      hash: els.hashToggle.checked,
      dedup: els.dedupToggle.checked,
      excludePatterns: getCustomExcludePatterns(),
      excludePaths: state.excludePaths,
      encryptionSkipped: state.encryptionSkipped,
      defaultExcludesOff: state.defaultExcludesOff,
      diskSpeeds: state.diskSpeeds,
      lockAfterBackup: els.lockAfterToggle.checked,
      tutorialDone: state.tutorialDone,
    });
  } catch {
    // non-critical
  }
}

async function loadState() {
  try {
    state.excludePatterns = await window.kopiaAPI.defaultExcludePatterns().catch(() => []);

    const settings = await window.kopiaAPI.loadSettings();
    if (!settings) return;
    state.tutorialDone = settings.tutorialDone === true || (settings.tutorialDone === undefined && Array.isArray(settings.sources) && settings.sources.length > 0);
    if (settings.__corrupt) {
      log("Atención: la configuración guardada (kopia-desk-settings.json) estaba dañada; " +
        "se restablecieron los valores por defecto (orígenes recordados, exclusiones, etc.).");
    }

    if (settings.sources && settings.sources.length) {
      for (const s of settings.sources) {
        if (!state.sources.some((x) => x.path === s.path)) {
          const name = uniqueSourceName(s.name, s.path);
          state.sources.push({ name, path: s.path });
        }
      }
      renderSources();
    }

    if (typeof settings.versioning === "boolean") {
      els.versioningToggle.checked = settings.versioning;
    }
    if (typeof settings.hash === "boolean") {
      els.hashToggle.checked = settings.hash;
    }
    if (typeof settings.dedup === "boolean") {
      els.dedupToggle.checked = settings.dedup;
    }
    if (typeof settings.lockAfterBackup === "boolean") {
      els.lockAfterToggle.checked = settings.lockAfterBackup;
    }
    if (Array.isArray(settings.excludePatterns) && settings.excludePatterns.length) {
      els.excludeInput.value = settings.excludePatterns.join("\n");
    }
    if (Array.isArray(settings.excludePaths)) {
      state.excludePaths = settings.excludePaths.filter((p) => typeof p === "string" && p);
    }
    if (settings.encryptionSkipped && typeof settings.encryptionSkipped === "object") {
      state.encryptionSkipped = { ...settings.encryptionSkipped };
    }
    if (Array.isArray(settings.defaultExcludesOff)) {
      const keys = DEFAULT_RULE_GROUPS.map((g) => g.key);
      state.defaultExcludesOff = settings.defaultExcludesOff.filter((k) => keys.includes(k));
    }
    if (settings.diskSpeeds && typeof settings.diskSpeeds === "object") {
      for (const [id, bps] of Object.entries(settings.diskSpeeds)) {
        if (Number.isFinite(bps) && bps > 0) state.diskSpeeds[id] = bps;
      }
    }
    renderExcludes();

    // Restore destination after drives load
    if (typeof settings.destinationVolumeId === "string" && settings.destinationVolumeId) {
      state._pendingVolumeId = settings.destinationVolumeId;
    }
    if (settings.destinationRoot) {
      state._pendingDestination = settings.destinationRoot;
    }
  } catch {
    // non-critical
  }
  // Con las exclusiones ya cargadas, se mide el peso de las carpetas recordadas.
  if (state.sources.length) measureAllSources();
}

function applyPendingDestination() {
  const root = state._pendingDestination;
  const volumeId = state._pendingVolumeId;
  delete state._pendingDestination;
  delete state._pendingVolumeId;
  if (!root && !volumeId) return;
  // Con la identidad guardada se busca ESE disco, esté en la letra que esté;
  // otro disco que ahora tenga la misma letra no se elige.
  let option = volumeId ? optionByVolumeId(volumeId) : null;
  if (!option && root) {
    const byRoot = [...els.destinationSelect.options].find((o) => o.value === root);
    if (byRoot && (!volumeId || !byRoot.dataset.volumeId || sameVolumeId(byRoot.dataset.volumeId, volumeId))) option = byRoot;
  }
  if (option) {
    els.destinationSelect.value = option.value;
    selectDestination();
    return;
  }
  if (volumeId) {
    state.lostDestination = { volumeId, root, label: "" };
    log("Tu disco de backup" + (root ? " (" + root + ")" : "") + " no está conectado: se elegirá solo al conectarlo.");
  }
}

// --- El disco de backup vuelve a elegirse solo ---------------------------------

function sameVolumeId(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function optionByVolumeId(volumeId) {
  if (!volumeId) return null;
  return [...els.destinationSelect.options].find((o) => sameVolumeId(o.dataset.volumeId, volumeId)) || null;
}

function rememberLostDestination(dest) {
  if (dest && dest.volumeId) state.lostDestination = { volumeId: dest.volumeId, root: dest.root, label: dest.label || "" };
}

// Si no hay destino y el disco que se desconectó volvió a aparecer, se elige.
async function reselectLostDestination() {
  const lost = state.lostDestination;
  if (!lost || state.destination) return false;
  const option = optionByVolumeId(lost.volumeId);
  if (!option) return false;
  els.destinationSelect.value = option.value;
  state.lostDestination = null;
  await selectDestination();
  saveState();
  log(
    "Se volvió a conectar tu disco de backup" + (lost.label ? " «" + lost.label + "»" : "") +
      (option.value !== lost.root ? " (ahora en " + option.value + ")" : "") + ": elegido otra vez como destino."
  );
  return true;
}

function clearHistory() {
  if (state.busy) return;
  els.logList.textContent = "";
}

els.addSourceBtn.addEventListener("click", () => addSource().catch((e) => log(e.message)));
els.destinationSelect.addEventListener("change", () => {
  state.lostDestination = null;
  selectDestination().then(saveState);
});
// Relee los discos conservando el elegido, y cuenta en el registro qué se
// conectó o se quitó. La usan el botón ↻ y el aviso de Windows al conectar o
// quitar una USB. Durante una copia, al cifrar o abrir las copias o al expulsar
// no se toca la lista: se deja pendiente y se actualiza al terminar.
let drivesRefreshRunning = false;

function driveOptions() {
  return new Map([...els.destinationSelect.options].filter((o) => o.value).map((o) => [o.value, o.textContent]));
}

async function refreshDrivesKeepingSelection() {
  if (state.busy || state.encryptionJob || state.ejecting || drivesRefreshRunning || drivesLoading) {
    state.drivesChangedPending = true;
    return;
  }
  drivesRefreshRunning = true;
  state.drivesChangedPending = false;
  els.refreshDrivesBtn.classList.add("spinning");
  try {
    const before = driveOptions();
    const kept = state.destination;
    const prevDest = kept && kept.root;
    await loadDrives();
    const after = driveOptions();
    for (const [root, text] of after) if (!before.has(root)) log("Se conectó " + text + ".");
    for (const root of before.keys()) if (!after.has(root)) log("Se desconectó " + root + ".");
    const option = prevDest ? [...els.destinationSelect.options].find((o) => o.value === prevDest) : null;
    if (option && option.dataset.volumeId && option.dataset.volumeId === kept.volumeId) {
      // El mismo volumen sigue ahí: se conserva la elección (y el estado de
      // cifrado, o la contraseña a medio escribir);
      // sólo se actualizan sus datos, como el espacio libre.
      els.destinationSelect.value = prevDest;
      state.destination = { ...destinationFromOption(option), busType: kept.busType };
      renderDestinationLabel();
      renderDestinationSpace();
      renderEncryptionPanel();
      updateCounts();
    } else if (kept && optionByVolumeId(kept.volumeId)) {
      // El mismo disco cambió de letra: se sigue con él.
      const moved = optionByVolumeId(kept.volumeId);
      els.destinationSelect.value = moved.value;
      await selectDestination();
      saveState();
      log("Tu disco de backup pasó de " + prevDest + " a " + moved.value + ": sigue elegido.");
    } else {
      // Se desconectó (o en su letra hay OTRO disco, que no se elige solo):
      // se recuerda para volver a elegirlo cuando se conecte.
      delete state._pendingDestination;
      rememberLostDestination(kept);
      els.destinationSelect.value = "";
      await selectDestination();
      if (prevDest) {
        log(
          (option ? "En " + prevDest + " ahora hay otro disco, que no se elige solo." : "El disco destino " + prevDest + " ya no está conectado.") +
            (state.lostDestination ? " Cuando vuelvas a conectar el tuyo se elegirá solo." : " Elige otro.")
        );
      }
    }
    if (!state.destination) await reselectLostDestination();
  } finally {
    els.refreshDrivesBtn.classList.remove("spinning");
    drivesRefreshRunning = false;
  }
  // Si llegó otro aviso mientras se actualizaba, se repite una vez.
  if (state.drivesChangedPending && !state.busy && !state.encryptionJob && !state.ejecting) {
    await refreshDrivesKeepingSelection();
  }
}

els.refreshDrivesBtn.addEventListener("click", () => refreshDrivesKeepingSelection().catch((e) => log(e.message)));
window.kopiaAPI.onDrivesChanged(() => refreshDrivesKeepingSelection().catch((e) => log(e.message)));

els.sumDetailsBtn.addEventListener("click", () => {
  els.changesView.scrollIntoView({ behavior: "smooth", block: "start" });
});
els.scanBtn.addEventListener("click", () => scanAll().catch((e) => log(e.message)));
els.backupBtn.addEventListener("click", () => backupAll().catch((e) => log(e.message)));
els.clearHistoryBtn.addEventListener("click", clearHistory);
els.compareBtn.addEventListener("click", () => compareSelected().catch((e) => log(e.message)));
els.versioningToggle.addEventListener("change", () => {
  // El versionado duplica el espacio estimado de los cambiados: recalcular aviso
  updateCounts();
  saveState();
});
els.hashToggle.addEventListener("change", saveState);
els.dedupToggle.addEventListener("change", saveState);
els.excludeInput.addEventListener("change", () => {
  renderExcludes();
  exclusionsChanged();
});
// "Al cerrar la ventana (X)": se guarda en el proceso principal.
window.kopiaAPI
  .getCloseAction()
  .then((action) => (els.closeActionSelect.value = action))
  .catch(() => {});
els.closeActionSelect.addEventListener("change", () => {
  window.kopiaAPI.setCloseAction(els.closeActionSelect.value).catch(() => {});
});
window.kopiaAPI.onCloseActionChanged((action) => (els.closeActionSelect.value = action));

els.excludeFolderBtn.addEventListener("click", () => pickExcludes("folder").catch((e) => log(e.message)));
els.excludeFileBtn.addEventListener("click", () => pickExcludes("file").catch((e) => log(e.message)));
els.openBackupBtn.addEventListener("click", async () => {
  if (!state.destination) return;
  const r = await window.kopiaAPI.openBackupFolder(state.destination.root).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) log("No se pudo abrir la carpeta del backup: " + r.error);
});
document.querySelectorAll(".pw-eye").forEach((btn) => {
  btn.addEventListener("click", () => setPasswordVisible(btn, btn.getAttribute("aria-pressed") !== "true"));
});
els.suspiciousAckCheckbox.addEventListener("change", () => {
  state.suspiciousAcknowledged = els.suspiciousAckCheckbox.checked;
  updateCounts();
});

// --- Ventana sin marco: controles propios de minimizar/maximizar/cerrar ---

function setMaximizedIcon(maximized) {
  els.winMaxIcon.hidden = maximized;
  els.winRestoreIcon.hidden = !maximized;
  els.winMax.title = maximized ? "Restaurar" : "Maximizar";
}

els.winMin.addEventListener("click", () => window.kopiaAPI.windowMinimize());
els.winMax.addEventListener("click", () =>
  window.kopiaAPI.windowToggleMaximize().then((maximized) => setMaximizedIcon(!!maximized))
);
els.winClose.addEventListener("click", () => window.kopiaAPI.windowClose());
window.kopiaAPI.windowIsMaximized().then(setMaximizedIcon).catch(() => {});
window.kopiaAPI.onWindowStateChange((data) => setMaximizedIcon(!!data.maximized));

initTheme();
renderSources();
renderComparisons();
loadQuickFolders();
loadState().then(() => {
  loadDrives().then(applyPendingDestination).catch((e) => log(e.message));
  // Primera vez: el tutorial, con la ventana ya dibujada.
  if (!state.tutorialDone) setTimeout(startTutorial, 600);
});
log("Kopia Desk v3 iniciado.");
