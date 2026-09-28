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
  compareSources: [],
  compareSelection: {},
  journalPending: false,
  suspiciousAcknowledged: false,
  // Estado de cifrado del destino: null mientras se consulta o sin destino.
  encryption: null,
  // "Continuar sin cifrar" confirmado para el destino elegido.
  encryptionAck: false,
  // Operación de BitLocker en curso: { root, action: "Encrypt"|"Lock", phase, percent, startedAt }.
  encryptionJob: null,
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
  sourceCount: document.querySelector("#sourceCount"),
  changeCount: document.querySelector("#changeCount"),
  copiedCount: document.querySelector("#copiedCount"),
  dedupedCount: document.querySelector("#dedupedCount"),
  logList: document.querySelector("#logList"),
  spaceInfo: document.querySelector("#spaceInfo"),
  driveInfo: document.querySelector("#driveInfo"),
  usageFill: document.querySelector("#usageFill"),
  repoPathHint: document.querySelector("#repoPathHint"),
  spaceWarning: document.querySelector("#spaceWarning"),
  fsWarning: document.querySelector("#fsWarning"),
  encryptionPanel: document.querySelector("#encryptionPanel"),
  encryptionStatus: document.querySelector("#encryptionStatus"),
  encryptionOpenBtn: document.querySelector("#encryptionOpenBtn"),
  encryptionRecheckBtn: document.querySelector("#encryptionRecheckBtn"),
  encryptionAckLabel: document.querySelector("#encryptionAckLabel"),
  encryptionAck: document.querySelector("#encryptionAck"),
  encryptionProgress: document.querySelector("#encryptionProgress"),
  encryptionProgressFill: document.querySelector("#encryptionProgressFill"),
  encryptBtn: document.querySelector("#encryptBtn"),
  unlockBtn: document.querySelector("#unlockBtn"),
  lockBtn: document.querySelector("#lockBtn"),
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
  advancedToggle: document.querySelector("#advancedToggle"),
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
}

window.kopiaAPI.onProgress((data) => {
  const labels = {
    backup: "Copiando archivos...",
    "restore-scan": "Comparando backup vs PC...",
    restore: "Restaurando archivos...",
  };
  showProgress(labels[data.phase] || data.phase, data.current, data.total, data.file);
});

function setBusy(busy) {
  state.busy = busy;
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
function updateSpaceStatus() {
  if (!state.destination) {
    els.spaceWarning.hidden = true;
    return true;
  }
  const planned = computePlannedBytes();
  const enough = planned === 0 || planned * SPACE_SAFETY_MARGIN <= state.destination.free;
  if (enough) {
    els.spaceWarning.hidden = true;
  } else {
    els.spaceWarning.hidden = false;
    els.spaceWarning.textContent =
      "No hay espacio suficiente en el disco destino: se necesitan aprox. " +
      formatBytes(planned) + " y hay " + formatBytes(state.destination.free) +
      " libres. Libera espacio, elige otro disco o desmarca archivos. El botón \"Copiar aceptados\" se habilitará cuando alcance.";
  }
  return enough;
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

// Cifrado: un disco sin cifrar exige confirmar "Continuar sin cifrar"; uno
// bloqueado no se puede usar hasta desbloquearlo desde el Explorador.
// ¿El destino elegido es del disco del sistema (o de un disco no identificado)?
// Se sabe por la lista de discos o, si no, por la respuesta del proceso principal.
function isSystemProtectedDestination() {
  const d = state.destination;
  if (!d) return false;
  if (d.isSystemDrive || d.onSystemDisk !== false) return true;
  return !!(state.encryption && state.encryption.systemProtected === true);
}

function encryptionAllowsBackup() {
  const enc = state.encryption;
  const job = currentEncryptionJob();
  if (job && job.action === "Lock") return false; // se está bloqueando: no copiar
  // En el disco del sistema no hay opción de cifrar, así que tampoco se pide
  // confirmar "continuar sin cifrar" (ya se avisa que no es buen destino).
  if (isSystemProtectedDestination()) return true;
  if (!enc) return true; // consultando o sin datos: no se bloquea
  if (enc.state === "locked") return false;
  if (enc.state === "off" || enc.state === "waiting") return state.encryptionAck;
  return true;
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

function getExcludePatterns() {
  return state.excludePatterns.concat(getCustomExcludePatterns());
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
    els.comparePreview.textContent = "Error al leer el backup: " + error.message;
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

function renderSources() {
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

    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Quitar carpeta";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.sources.splice(index, 1);
      state.comparisons = state.comparisons.filter((c) => c.sourceName !== source.name);
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

  state.sources.push({ name, path: folderPath });
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

async function loadDrives() {
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

async function selectDestination() {
  const option = els.destinationSelect.selectedOptions[0];

  if (!option || !option.value) {
    state.destination = null;
    els.destinationLabel.textContent = "Selecciona donde guardar";
    els.spaceInfo.textContent = "";
    els.driveInfo.textContent = "";
    els.usageFill.style.width = "0%";
    els.repoPathHint.textContent = "";
    els.journalNotice.hidden = true;
    state.journalPending = false;
    resetEncryptionPanel();
    updateCounts();
    refreshActiveExtraTab();
    return;
  }

  state.destination = {
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
  };
  els.destinationLabel.textContent =
    state.destination.root + " seleccionado — " + formatBytes(state.destination.free) + " libres" +
    (state.destination.fileSystem ? " · " + state.destination.fileSystem : "") +
    (state.destination.isSystemDrive ? " (disco del sistema)" : "");

  if (state.destination.fileSystem && !state.destination.journaled) {
    log(
      "El disco " + state.destination.root + " usa " + state.destination.fileSystem +
        ": no admite hardlinks (la deduplicación copiará normal) y es más sensible a desconexiones " +
        "sin expulsar. " + (state.destination.maxFileSize ? "Además, no admite archivos de 4 GB o más. " : "") +
        "Para backups se recomienda NTFS."
    );
  }

  checkEncryption();

  const usedPct =
    state.destination.total > 0
      ? Math.round(((state.destination.total - state.destination.free) / state.destination.total) * 100)
      : 0;
  const freeText = formatBytes(state.destination.free) + " libres de " + formatBytes(state.destination.total);
  els.spaceInfo.textContent = "Disco: " + freeText + " (" + usedPct + "% usado)";
  els.usageFill.style.width = usedPct + "%";
  els.repoPathHint.textContent = "Se guarda en: " + joinDestPath(state.destination.root, BACKUP_ROOT);

  log("Destino elegido: " + state.destination.root);
  if (state.destination.isSystemDrive) {
    log(
      "Atención: " + state.destination.root + " es el disco donde está instalado Windows. " +
        "No se recomienda usarlo como destino de backup — elegí un disco externo o USB."
    );
  }

  // Concurrencia/tipo de disco orientativos (se recalcula con datos reales al copiar)
  window.kopiaAPI
    .planConcurrency(state.destination.root, 1024 * 1024)
    .then((plan) => {
      els.driveInfo.textContent =
        "Disco " + (plan.driveInfo.mediaType || "desconocido") +
        " (" + (plan.driveInfo.busType || "?") + ") — concurrencia sugerida: " + plan.concurrency;
    })
    .catch(() => {
      els.driveInfo.textContent = "";
    });

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

// --- Cifrado del disco destino (BitLocker) -------------------------------------
// El estado se consulta sin permisos de administrador. Cifrar y bloquear piden
// el permiso de Windows (UAC) y los hace el ayudante elevado: la contraseña y
// la clave de recuperación se manejan en SUS ventanas, nunca en esta interfaz.
// Desbloquear usa el cuadro de contraseña del propio Windows, sin UAC.

const ENCRYPTION_TEXT = {
  on: "Cifrado con BitLocker y desbloqueado.",
  encrypting: "Cifrándose con BitLocker. Puedes copiar, pero irá más lento hasta que termine. No desconectes el disco.",
  decrypting: "BitLocker se está desactivando en este disco: pronto quedará sin cifrar.",
  suspended: "BitLocker está suspendido: el disco está cifrado pero sin protección activa. Reanúdalo desde el panel de BitLocker.",
  locked: "Disco cifrado y bloqueado. Desbloquéalo para poder copiar.",
  off: "Este disco NO está cifrado: si se pierde, cualquiera puede leer tus archivos y sus rutas.",
  waiting: "BitLocker está a medio configurar (sin protector activo): el disco no está protegido.",
  unsupported: "Este disco no admite BitLocker.",
  unknown: "No se pudo determinar si el disco está cifrado.",
};

const JOB_TEXT = {
  launching: "Esperando el permiso de administrador de Windows...",
  "waiting-password": "Escribe la contraseña en la ventana de Kopia Desk.",
  "waiting-recovery": "Guarda la clave de recuperación en la ventana de Kopia Desk (fuera de este disco).",
  enabling: "Activando BitLocker...",
  encrypting: "Cifrando el disco. Puedes seguir usándolo; no lo desconectes.",
  locking: "Bloqueando el disco...",
  unlocking: "Escribe la contraseña en el cuadro de Windows para desbloquear el disco.",
};

const JOB_POLL_MS = 1500;
// Si el ayudante arrancó pero no informa nada en este tiempo, algo falló.
const JOB_SILENCE_TIMEOUT_MS = 3 * 60 * 1000;

// La operación en curso, sólo si es del disco elegido ahora.
function currentEncryptionJob() {
  const job = state.encryptionJob;
  return job && state.destination && job.root === state.destination.root ? job : null;
}

function resetEncryptionPanel() {
  state.encryption = null;
  state.encryptionAck = false;
  els.encryptionAck.checked = false;
  els.encryptionPanel.hidden = true;
}

function renderEncryptionPanel() {
  const enc = state.encryption;
  els.encryptionPanel.hidden = !state.destination;
  if (!state.destination) return;

  const buttons = [els.encryptBtn, els.unlockBtn, els.lockBtn, els.encryptionOpenBtn];
  buttons.forEach((b) => (b.hidden = true));
  els.encryptionProgress.hidden = true;
  els.lockAfterLabel.hidden = true;
  els.encryptionAckLabel.hidden = true;
  els.encryptionRecheckBtn.hidden = false;

  const job = currentEncryptionJob();
  if (job) {
    els.encryptionPanel.dataset.state = "job";
    let text = JOB_TEXT[job.phase] || "Trabajando con BitLocker...";
    if (job.phase === "encrypting" && typeof job.percent === "number") {
      text = "Cifrando el disco: " + job.percent.toFixed(1) + "%. Puedes seguir usándolo; no lo desconectes.";
      els.encryptionProgress.hidden = false;
      els.encryptionProgressFill.style.width = Math.min(100, job.percent) + "%";
    }
    els.encryptionStatus.textContent = text;
    els.encryptionRecheckBtn.hidden = true;
    return;
  }

  // Disco del sistema (o disco no identificado): ninguna opción de cifrado,
  // ni botones ni la casilla de "continuar sin cifrar"; sólo una nota neutra.
  // No depende de la consulta de cifrado: se sabe desde la lista de discos.
  if (isSystemProtectedDestination()) {
    els.encryptionPanel.dataset.state = "system";
    els.encryptionStatus.textContent =
      state.destination.isSystemDrive || state.destination.onSystemDisk === true
        ? "Disco del sistema (donde está instalado Windows): Kopia Desk no ofrece cifrarlo ni bloquearlo. " +
          "Tampoco se recomienda como destino de backup: usa un disco externo o USB."
        : "No se pudo identificar en qué disco físico está esta unidad: por seguridad Kopia Desk no ofrece cifrarla ni bloquearla.";
    els.encryptionRecheckBtn.hidden = true;
    return;
  }

  if (!enc) {
    els.encryptionPanel.dataset.state = "checking";
    els.encryptionStatus.textContent = "Comprobando cifrado del disco...";
    els.encryptionRecheckBtn.hidden = true;
    return;
  }

  els.encryptionPanel.dataset.state = enc.state;
  let text = ENCRYPTION_TEXT[enc.state] || ENCRYPTION_TEXT.unknown;
  const unprotected = enc.state === "off" || enc.state === "waiting";
  if (unprotected && !enc.canEncrypt) {
    text +=
      " Tu edición de Windows (Home) no puede cifrar discos con BitLocker, aunque sí abrir los ya cifrados. " +
      "Alternativas: cifrarlo desde un equipo con Windows Pro, actualizar a Pro o usar VeraCrypt.";
  }
  els.encryptionStatus.textContent = text;

  // "waiting" (a medio configurar) se resuelve mejor en el panel de Windows.
  els.encryptBtn.hidden = !(enc.state === "off" && enc.canEncrypt);
  els.unlockBtn.hidden = enc.state !== "locked";
  els.lockBtn.hidden = enc.state !== "on";
  els.lockAfterLabel.hidden = !(enc.state === "on" || enc.state === "encrypting");
  els.encryptionOpenBtn.hidden = !(enc.canEncrypt && (enc.state === "suspended" || enc.state === "waiting"));
  els.encryptionAckLabel.hidden = !unprotected;

  // Durante un backup no se cifra ni se bloquea el disco que se está usando.
  [els.encryptBtn, els.unlockBtn, els.lockBtn].forEach((b) => (b.disabled = state.busy));
}

async function checkEncryption() {
  if (!state.destination) return;
  const root = state.destination.root;
  state.encryption = null;
  state.encryptionAck = false;
  els.encryptionAck.checked = false;
  renderEncryptionPanel();
  updateCounts();
  let status;
  try {
    status = await window.kopiaAPI.encryptionStatus(root);
  } catch {
    status = { state: "unknown", canEncrypt: false };
  }
  // El usuario pudo cambiar de disco mientras se consultaba.
  if (!state.destination || state.destination.root !== root) return;
  state.encryption = status;
  renderEncryptionPanel();
  updateCounts();
}

// Tras bloquear o desbloquear cambian el espacio y el sistema de archivos
// visibles: se releen los discos y se vuelve a elegir el mismo.
async function reloadDrivesKeeping(root) {
  state._pendingDestination = root;
  await loadDrives();
  applyPendingDestination();
}

function setEncryptionJob(job) {
  state.encryptionJob = job;
  renderEncryptionPanel();
  updateCounts();
}

// Sigue el archivo de estado del ayudante hasta que termine. Devuelve la fase
// final ("done", "cancelled", "error", "disconnected" o "timeout").
async function followEncryptionJob(job) {
  let lastSignal = Date.now();
  let lastTs = null;
  let deadPolls = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    let status = null;
    let alive = null;
    try {
      const res = await window.kopiaAPI.encryptionJobStatus(job.root, job.action);
      status = res.status;
      alive = res.alive;
    } catch {
      // disco no disponible un momento: se reintenta
    }
    if (status && status.ts !== lastTs) {
      lastTs = status.ts;
      lastSignal = Date.now();
      job.phase = status.phase;
      job.percent = typeof status.percent === "number" ? status.percent : job.percent;
      job.error = status.error;
      job.code = status.code;
      if (state.encryptionJob === job) renderEncryptionPanel();
    }
    if (["done", "cancelled", "error", "disconnected"].includes(job.phase)) return job.phase;
    // El ayudante se cerró sin informar un final (cerrado a la fuerza, fallo).
    // Se espera una lectura más por si escribió su último estado al salir.
    if (alive === false && ++deadPolls >= 2) {
      job.phase = "error";
      job.error = "La ventana de BitLocker se cerró antes de terminar. Pulsa \"Comprobar de nuevo\" para ver el estado del disco.";
      return "error";
    }
    // Mientras hay una ventana abierta esperando al usuario no hay límite.
    const waitingUser = job.phase === "waiting-password" || job.phase === "waiting-recovery";
    if (!waitingUser && Date.now() - lastSignal > JOB_SILENCE_TIMEOUT_MS) return "timeout";
  }
}

async function runHelperJob(action, start) {
  const root = state.destination.root;
  const job = { root, action, phase: "launching", percent: null };
  setEncryptionJob(job);
  try {
    const launched = await start(root);
    if (!launched.started) {
      log(
        launched.code === "uac-cancelled"
          ? "Operación cancelada: no se dio el permiso de administrador de Windows."
          : "No se pudo iniciar BitLocker: " + launched.error
      );
      return "not-started";
    }
    return await followEncryptionJob(job);
  } catch (error) {
    log("Error de BitLocker: " + error.message);
    return "error";
  } finally {
    if (state.encryptionJob === job) setEncryptionJob(null);
    if (job.phase === "error" && job.error) log("BitLocker: " + job.error);
  }
}

async function startEncryption(fullDisk) {
  if (!state.destination) return;
  const root = state.destination.root;
  log("Cifrado de " + root + ": acepta el permiso de administrador de Windows para continuar.");
  const volumeId = state.destination.volumeId;
  const result = await runHelperJob("Encrypt", (r) => window.kopiaAPI.encryptDrive(r, { fullDisk, volumeId }));
  if (result === "done") {
    log("Disco " + root + " cifrado con BitLocker. Guarda bien la clave de recuperación.");
  } else if (result === "cancelled") {
    log("Cifrado cancelado. El disco no se modificó.");
  } else if (result === "disconnected") {
    log("El disco " + root + " se desconectó. BitLocker seguirá cifrando cuando lo vuelvas a conectar.");
  } else if (result === "timeout") {
    log("No hay noticias del cifrado de " + root + ". Pulsa \"Comprobar de nuevo\" para ver su estado.");
  }
  if (state.destination && state.destination.root === root) await reloadDrivesKeeping(root);
}

async function lockCurrentDrive() {
  if (!state.destination) return false;
  const root = state.destination.root;
  const volumeId = state.destination.volumeId;
  const result = await runHelperJob("Lock", (r) => window.kopiaAPI.lockDrive(r, volumeId));
  if (result === "done") {
    log("Disco " + root + " bloqueado. Para volver a usarlo, pulsa \"Desbloquear\" o reconéctalo.");
  }
  if (state.destination && state.destination.root === root) await reloadDrivesKeeping(root);
  return result === "done";
}

async function unlockCurrentDrive() {
  if (!state.destination) return;
  const root = state.destination.root;
  const job = { root, action: "Unlock", phase: "unlocking" };
  setEncryptionJob(job);
  try {
    const status = await window.kopiaAPI.unlockDrive(root);
    log(status.state === "locked" ? "El disco sigue bloqueado." : "Disco " + root + " desbloqueado.");
  } catch (error) {
    log("No se pudo desbloquear: " + error.message);
  } finally {
    if (state.encryptionJob === job) setEncryptionJob(null);
  }
  if (state.destination && state.destination.root === root) await reloadDrivesKeeping(root);
}

els.encryptBtn.addEventListener("click", () => {
  if (!state.destination || state.busy || isSystemProtectedDestination()) return;
  els.encryptDialogDrive.textContent = state.destination.root;
  els.encryptDialog.querySelector('input[name="encryptScope"][value="used"]').checked = true;
  els.encryptDialog.showModal();
});

els.encryptDialogCancel.addEventListener("click", () => els.encryptDialog.close());

els.encryptDialogConfirm.addEventListener("click", () => {
  if (isSystemProtectedDestination()) {
    els.encryptDialog.close();
    return;
  }
  const fullDisk = els.encryptDialog.querySelector('input[name="encryptScope"]:checked').value === "full";
  els.encryptDialog.close();
  startEncryption(fullDisk).catch((e) => log(e.message));
});

els.unlockBtn.addEventListener("click", () => {
  if (state.busy) return;
  unlockCurrentDrive().catch((e) => log(e.message));
});

els.lockBtn.addEventListener("click", () => {
  if (state.busy || isSystemProtectedDestination()) return;
  lockCurrentDrive().catch((e) => log(e.message));
});

els.lockAfterToggle.addEventListener("change", saveState);

els.encryptionOpenBtn.addEventListener("click", async () => {
  try {
    await window.kopiaAPI.openBitLockerPanel();
    log("Se abrió el panel de BitLocker de Windows. Al terminar, pulsa \"Comprobar de nuevo\".");
  } catch (error) {
    log("No se pudo abrir el panel de BitLocker: " + error.message);
  }
});

els.encryptionRecheckBtn.addEventListener("click", () => {
  checkEncryption().catch((e) => log(e.message));
});

els.encryptionAck.addEventListener("change", () => {
  state.encryptionAck = els.encryptionAck.checked;
  if (state.encryptionAck && state.destination) {
    log("Se continuará sin cifrar " + state.destination.root + " (confirmado por el usuario).");
  }
  updateCounts();
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

        const scan = await window.kopiaAPI.scanDirectory(source.path, excludePatterns);
        const current = scan.files;

        const diff = await compareManifests(
          current,
          previous,
          els.hashToggle.checked,
          window.kopiaAPI.hashFile,
          (checked, total, filePath) => showProgress("Comparando contenido...", checked, total, filePath)
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
    els.driveInfo.textContent =
      "Disco " + (plan.driveInfo.mediaType || "desconocido") +
      " (" + (plan.driveInfo.busType || "?") + ") — concurrencia: " + plan.concurrency;
  } catch {
    // se usa el valor por defecto
  }

  try {
    const maxFileSize = state.destination.maxFileSize || 0;
    for (const comparison of state.comparisons) {
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
          });
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

        const result = await window.kopiaAPI.backupCopyFiles(tasks, {
          dedup,
          concurrency,
          destVolumeId: state.destination.volumeId,
        });
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
          (notDone > 0 ? " " + notDone + " no se pudieron copiar (se reintentarán en el próximo backup)." : "") +
          (removingMissing ? " Eliminados registrados: " + comparison.missingFiles.length + "." : "")
      );
    }

    state.copied = totalCopied;
    state.deduped = totalDeduped;
    updateCounts();
    let summary = "Copia finalizada: " + totalCopied + " archivos.";
    if (totalDeduped > 0) summary += " (" + totalDeduped + " deduplicados sin copiar bytes nuevos)";
    log(summary);
    completed = true;
  } catch (error) {
    log("Error en backup: " + error.message);
  } finally {
    setBusy(false);
    hideProgress();
  }

  // Bloquear al terminar (pide el permiso de administrador de Windows).
  if (
    completed &&
    els.lockAfterToggle.checked &&
    state.encryption &&
    state.encryption.state === "on" &&
    !isSystemProtectedDestination()
  ) {
    log("Backup terminado: bloqueando " + state.destination.root + " como pediste...");
    await lockCurrentDrive();
  }
}

// --- Pestaña "Comparar": ejecutar la comparación de lo marcado -------------

async function compareSelected() {
  if (state.busy || !state.destination) {
    if (!state.destination) log("Selecciona un disco con backup para comparar.");
    return;
  }

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

      const result = await window.kopiaAPI.restoreCopyFiles(toRestore, targetDir, { concurrency });
      log("Restaurados: " + result.copied + " archivos a " + targetDir);
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
    els.restoreFullList.textContent = "Error al leer el backup: " + error.message;
  }
}

function renderFullRestoreRow(sourceName) {
  const row = document.createElement("div");
  row.className = "source-pill";

  const label = document.createElement("strong");
  label.textContent = sourceName;
  row.appendChild(label);

  const hintSpan = document.createElement("span");
  hintSpan.className = "pill-path";
  hintSpan.textContent = "Restaura todo el contenido a la carpeta que elijas";
  row.appendChild(hintSpan);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "primary";
  btn.style.width = "auto";
  btn.style.padding = "0 16px";
  btn.textContent = "Restaurar a...";
  row.appendChild(btn);

  btn.addEventListener("click", async () => {
    if (state.busy) return;

    const targetDir = await window.kopiaAPI.selectRestoreTarget();
    if (!targetDir) return;

    setBusy(true);
    btn.disabled = true;
    try {
      const files = await window.kopiaAPI.restoreFullList(state.destination.root, sourceName);
      if (!files.length) {
        log(sourceName + ": el backup no tiene archivos para restaurar.");
        return;
      }
      log(sourceName + ": restaurando " + files.length + " archivo(s) en " + targetDir + "...");

      const avgSize = files.reduce((t, f) => t + (f.size || 0), 0) / files.length;
      let concurrency = 3;
      try {
        const plan = await window.kopiaAPI.planConcurrency(state.destination.root, avgSize);
        concurrency = plan.concurrency;
      } catch {
        // se usa el valor por defecto
      }

      const result = await window.kopiaAPI.restoreCopyFiles(files, targetDir, { concurrency });
      log(sourceName + ": restaurados " + result.copied + " de " + files.length + " archivo(s) en " + targetDir);
      if (result.errors.length) {
        result.errors.forEach((e) => log("Error restaurando: " + e.file + " — " + e.error));
      }
    } catch (error) {
      log("Error al restaurar '" + sourceName + "': " + error.message);
    } finally {
      setBusy(false);
      btn.disabled = false;
      hideProgress();
    }
  });

  els.restoreFullList.appendChild(row);
}

async function saveState() {
  try {
    await window.kopiaAPI.saveSettings({
      sources: state.sources.map((s) => ({ name: s.name, path: s.path })),
      destinationRoot: state.destination?.root || null,
      versioning: els.versioningToggle.checked,
      hash: els.hashToggle.checked,
      dedup: els.dedupToggle.checked,
      advanced: els.advancedToggle.checked,
      excludePatterns: getCustomExcludePatterns(),
      lockAfterBackup: els.lockAfterToggle.checked,
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
    if (typeof settings.advanced === "boolean") {
      els.advancedToggle.checked = settings.advanced;
      els.driveInfo.hidden = !settings.advanced;
    }
    if (typeof settings.lockAfterBackup === "boolean") {
      els.lockAfterToggle.checked = settings.lockAfterBackup;
    }
    if (Array.isArray(settings.excludePatterns) && settings.excludePatterns.length) {
      els.excludeInput.value = settings.excludePatterns.join("\n");
    }

    // Restore destination after drives load
    if (settings.destinationRoot) {
      state._pendingDestination = settings.destinationRoot;
    }
  } catch {
    // non-critical
  }
}

function applyPendingDestination() {
  if (!state._pendingDestination) return;
  const options = els.destinationSelect.options;
  for (let i = 0; i < options.length; i++) {
    if (options[i].value === state._pendingDestination) {
      els.destinationSelect.selectedIndex = i;
      selectDestination();
      break;
    }
  }
  delete state._pendingDestination;
}

function clearHistory() {
  if (state.busy) return;
  els.logList.textContent = "";
}

els.addSourceBtn.addEventListener("click", () => addSource().catch((e) => log(e.message)));
els.destinationSelect.addEventListener("change", () => {
  selectDestination().then(saveState);
});
els.refreshDrivesBtn.addEventListener("click", () =>
  loadDrives()
    .then(applyPendingDestination)
    .catch((e) => log(e.message))
);
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
els.advancedToggle.addEventListener("change", () => {
  els.driveInfo.hidden = !els.advancedToggle.checked;
  saveState();
});
els.excludeInput.addEventListener("change", saveState);
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
});
log("Kopia Desk v2 iniciado.");
