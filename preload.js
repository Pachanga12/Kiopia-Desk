"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kopiaAPI", {
  listDrives: () => ipcRenderer.invoke("drives:list"),
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder"),
  selectRestoreTarget: () => ipcRenderer.invoke("dialog:select-restore-target"),
  quickFolders: () => ipcRenderer.invoke("folders:quick-list"),

  scanDirectory: (dirPath, excludePatterns) => ipcRenderer.invoke("fs:scan-directory", dirPath, excludePatterns),
  defaultExcludePatterns: () => ipcRenderer.invoke("config:default-excludes"),
  hashFile: (filePath) => ipcRenderer.invoke("fs:hash-file", filePath),
  quickHashFile: (filePath, size) => ipcRenderer.invoke("fs:quick-hash", filePath, size),

  loadManifest: (destRoot, sourceName) => ipcRenderer.invoke("manifest:load", destRoot, sourceName),
  saveManifest: (destRoot, sourceName, manifest) => ipcRenderer.invoke("manifest:save", destRoot, sourceName, manifest),

  rememberSourcePath: (destRoot, sourceName, sourcePath) =>
    ipcRenderer.invoke("sources:remember", destRoot, sourceName, sourcePath),
  knownSourcePaths: (destRoot) => ipcRenderer.invoke("sources:known-paths", destRoot),

  planConcurrency: (driveRoot, avgFileSize) => ipcRenderer.invoke("backup:plan-concurrency", driveRoot, avgFileSize),

  journalPeek: (destRoot) => ipcRenderer.invoke("journal:peek", destRoot),
  journalCheck: (destRoot) => ipcRenderer.invoke("journal:check", destRoot),

  backupCopyFiles: (tasks, options) => ipcRenderer.invoke("backup:copy-files", tasks, options),
  backupCopyVersions: (tasks) => ipcRenderer.invoke("backup:copy-versions", tasks),
  logSave: (destRoot, sourceName, report) => ipcRenderer.invoke("log:save", destRoot, sourceName, report),

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
});
