"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kopiaAPI", {
  listDrives: () => ipcRenderer.invoke("drives:list"),
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder"),
  selectRestoreTarget: () => ipcRenderer.invoke("dialog:select-restore-target"),
  quickFolders: () => ipcRenderer.invoke("folders:quick-list"),

  scanDirectory: (dirPath, excludePatterns, excludePaths) =>
    ipcRenderer.invoke("fs:scan-directory", dirPath, excludePatterns, excludePaths),
  measureDirectory: (dirPath, excludePatterns, excludePaths) =>
    ipcRenderer.invoke("fs:measure-directory", dirPath, excludePatterns, excludePaths),
  selectExclude: (kind, startPath) => ipcRenderer.invoke("dialog:select-exclude", kind, startPath),
  onDrivesChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("drives:changed", handler);
    return () => ipcRenderer.removeListener("drives:changed", handler);
  },
  defaultExcludePatterns: () => ipcRenderer.invoke("config:default-excludes"),
  hashFile: (filePath) => ipcRenderer.invoke("fs:hash-file", filePath),
  hashConcurrency: (sourcePath) => ipcRenderer.invoke("fs:hash-concurrency", sourcePath),
  quickHashFile: (filePath, size) => ipcRenderer.invoke("fs:quick-hash", filePath, size),

  loadManifest: (destRoot, sourceName) => ipcRenderer.invoke("manifest:load", destRoot, sourceName),
  saveManifest: (destRoot, sourceName, manifest) => ipcRenderer.invoke("manifest:save", destRoot, sourceName, manifest),

  rememberSourcePath: (destRoot, sourceName, sourcePath) =>
    ipcRenderer.invoke("sources:remember", destRoot, sourceName, sourcePath),
  knownSourcePaths: (destRoot) => ipcRenderer.invoke("sources:known-paths", destRoot),

  planConcurrency: (driveRoot, avgFileSize) => ipcRenderer.invoke("backup:plan-concurrency", driveRoot, avgFileSize),

  encryptionStatus: (driveRoot) => ipcRenderer.invoke("encryption:status", driveRoot),
  openBitLockerPanel: () => ipcRenderer.invoke("encryption:open-panel"),
  encryptDrive: (driveRoot, options) => ipcRenderer.invoke("encryption:encrypt", driveRoot, options),
  lockDrive: (driveRoot, volumeId) => ipcRenderer.invoke("encryption:lock", driveRoot, volumeId),
  unlockDrive: (driveRoot) => ipcRenderer.invoke("encryption:unlock", driveRoot),
  encryptionJobStatus: (driveRoot, action) => ipcRenderer.invoke("encryption:job-status", driveRoot, action),
  ejectDrive: (driveRoot, volumeId) => ipcRenderer.invoke("drive:eject", driveRoot, volumeId),

  journalPeek: (destRoot) => ipcRenderer.invoke("journal:peek", destRoot),
  journalCheck: (destRoot) => ipcRenderer.invoke("journal:check", destRoot),

  backupCopyFiles: (tasks, options) => ipcRenderer.invoke("backup:copy-files", tasks, options),
  backupCopyVersions: (tasks, options) => ipcRenderer.invoke("backup:copy-versions", tasks, options),
  logSave: (destRoot, sourceName, report) => ipcRenderer.invoke("log:save", destRoot, sourceName, report),
  lastBackup: (destRoot) => ipcRenderer.invoke("backup:last-run", destRoot),
  cancelCopy: (opId) => ipcRenderer.invoke("copy:cancel", opId),
  setBusy: (busy) => ipcRenderer.invoke("app:busy", busy),
  onStoppingForQuit: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("app:stopping-for-quit", handler);
    return () => ipcRenderer.removeListener("app:stopping-for-quit", handler);
  },
  notify: (title, body) => ipcRenderer.invoke("app:notify", title, body),
  getCloseAction: () => ipcRenderer.invoke("app:get-close-action"),
  setCloseAction: (action) => ipcRenderer.invoke("app:set-close-action", action),
  onCloseActionChanged: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("window:close-action", handler);
    return () => ipcRenderer.removeListener("window:close-action", handler);
  },
  openBackupFolder: (destRoot) => ipcRenderer.invoke("backup:open-folder", destRoot),

  restoreListSources: (backupDrive) => ipcRenderer.invoke("restore:list-sources", backupDrive),
  restoreFullList: (backupDrive, sourceName) => ipcRenderer.invoke("restore:full-list", backupDrive, sourceName),
  restoreScan: (backupDrive, sourceName, localPath) => ipcRenderer.invoke("restore:scan", backupDrive, sourceName, localPath),
  restoreCopyFiles: (files, targetDir, options) => ipcRenderer.invoke("restore:copy-files", files, targetDir, options),

  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),

  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("progress", handler);
    return () => ipcRenderer.removeListener("progress", handler);
  },

  // Ventana sin marco: controles propios en la barra de título.
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onWindowStateChange: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("window:state", handler);
    return () => ipcRenderer.removeListener("window:state", handler);
  },
});
