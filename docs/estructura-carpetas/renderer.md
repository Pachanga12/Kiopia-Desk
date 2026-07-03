# Carpeta `renderer/` — la interfaz

Todo lo que corre dentro de la ventana. No tiene acceso a Node.js ni al sistema
de archivos: todo pasa por `window.kopiaAPI` (definido en `preload.js`).

## `index.html` — estructura de la pantalla

Tres zonas principales:

- **Barra superior**: título, contadores (carpetas, cambios, copiados) y el
  botón de tema claro/oscuro (`#themeToggle`).
- **Barra lateral** (`sidebar`): añadir carpetas de origen (por diálogo o con
  los accesos rápidos de `#quickFolders`), elegir disco destino, y el bloque de
  **Opciones** (versionado, verificación profunda, deduplicación y "Mostrar
  detalles técnicos"). Cada opción, pestaña y categoría de archivos tiene un
  tooltip (`title`) que explica en lenguaje simple qué hace al pasar el mouse.
- **Panel principal**: tres pestañas — **Backup**, **Comparar** y
  **Restaurar** — barra de progreso, el aviso de espacio insuficiente
  (`#spaceWarning`, oculto hasta que hace falta), el aviso de backup
  interrumpido (`#journalNotice`, con botones "Continuar y limpiar" / "Ahora
  no"), y la lista de carpetas escaneadas con sus archivos
  nuevos/cambiados/eliminados.

Hay un `<template>` (`folderTemplate`) que `app.js` clona por cada carpeta
escaneada, para no repetir HTML a mano.

## `app.js` — la lógica de la interfaz

Todo gira en torno a un objeto `state` en memoria (no hay framework, es JS
plano). Los flujos principales:

### Tema claro/oscuro (`initTheme` / `applyTheme`)
Al iniciar, lee la preferencia guardada en `localStorage` (o el tema del
sistema operativo si nunca se eligió uno) y la aplica como atributo
`data-theme` en `<html>`. El botón de la barra superior alterna entre ambos y
guarda la elección — es puramente visual, no pasa por `main.js`.

### Carpetas rápidas (`loadQuickFolders` / `addFolderToSources`)
Al arrancar, pide a `main.js` la lista de carpetas típicas del usuario que
existan en este equipo (Imágenes, Documentos, Descargas, Música, Videos,
Escritorio) y dibuja un botón por cada una en `#quickFolders`. Un clic la
agrega directo a `state.sources`, sin pasar por el diálogo nativo.

### Escanear (`scanAll`)
Por cada carpeta de origen: pide el manifiesto anterior a `main.js`, escanea la
carpeta actual (aplicando las exclusiones del cuadro de texto), y llama a
`compareManifests()` para clasificar cada archivo en nuevo / cambiado /
eliminado. Esta función es la que decide, usando el hash rápido, si un archivo
con fecha distinta pero mismo tamaño realmente cambió de contenido.

### Elegir destino (`selectDestination`)
Al elegir un disco: se calcula el espacio libre y se le pregunta a `main.js`
qué tipo de disco es para sugerir la concurrencia de copia (`driveInfo`, sólo
visible con "Mostrar detalles técnicos" activado). Después se ejecuta
`journalPeek()`: si el backup anterior quedó interrumpido, se muestra
`#journalNotice` explicando qué pasó y cuántos archivos parciales quedaron, y
sólo si el usuario confirma se llama a `journalCheck()` para limpiarlos. Si
elige "Ahora no", la limpieza queda pendiente (`state.journalPending`) y se
hace automáticamente antes del próximo backup a ese disco.

### Copiar (`backupAll`)
1. El espacio se controla **en vivo** (`updateSpaceStatus`, llamado desde
   `updateCounts`): si lo seleccionado no entra en el destino, el aviso
   amarillo explica cuánto falta y el botón "Copiar aceptados" queda
   deshabilitado. `backupAll` lo vuelve a validar al arrancar por si el disco
   se llenó entre el escaneo y el clic.
2. Calcula la concurrencia recomendada **una sola vez para toda la corrida**
   (según el disco destino y el tamaño promedio de todos los archivos
   seleccionados) — evita lanzar PowerShell de más por cada carpeta cuando
   hay varias carpetas de origen.
3. Por cada carpeta: arma la lista de tareas de copia y llama a
   `backupCopyFiles` (con la opción de deduplicación y la concurrencia ya
   calculada) y, si hay versionado, a `backupCopyVersions`.
4. Guarda el nuevo manifiesto, recuerda la ruta de origen
   (`rememberSourcePath`) para que restaurar no vuelva a preguntar, y guarda un
   registro de la operación.

### Comparar (`loadComparePreview` / `compareSelected`)
Al entrar a esta pestaña se listan las carpetas que hay en el backup, cada una
con un checkbox y su carpeta local conocida (si existe) o un botón para
elegirla. **No se compara nada automáticamente**: hay que marcar las carpetas,
confirmar su ubicación local y apretar "Comparar seleccionados". Por cada una
se llama a `restoreScan`, se muestra una tarjeta con los archivos faltantes
(`renderMissingFilesCard`) y se puede restaurar sólo esos, y se actualiza la
ruta local recordada (`rememberSourcePath`) con la que se usó, por si había
cambiado. Si el escaneo detecta archivos que figuran como respaldados pero ya
no están en el disco de backup (`lostFromBackup`), se muestra otra tarjeta
(`renderLostFilesCard`) con un botón que los quita del manifiesto para que el
próximo backup los detecte como nuevos y los recopie.

### Restaurar (`loadFullRestoreList` / `renderFullRestoreRow`)
Lista las carpetas del backup sin compararlas contra nada: cada fila tiene un
botón "Restaurar a..." que pide una carpeta destino (puede ser cualquiera, de
cualquier usuario) y copia **todo** el contenido de esa carpeta del backup ahí
(`restoreFullList` + `restoreCopyFiles`). Pensada para cuando la carpeta o el
usuario de Windows originales ya no existen — por ejemplo, después de
formatear el PC.

### Persistencia (`saveState` / `loadState`)
Guarda en la configuración del usuario (no en el proyecto) qué carpetas había
elegidas, qué disco, y el estado de los interruptores. El tema claro/oscuro se
guarda aparte, en `localStorage` del navegador embebido.

## `styles.css`

Hoja de estilos vanilla, sin preprocesador. Casi todos los colores están en
variables CSS definidas en `:root`, con una segunda definición en
`:root[data-theme="dark"]` que las sobreescribe para el tema oscuro — por eso
cambiar de tema no necesita tocar el resto de las reglas. Componentes
reutilizables: botones, tarjetas, badges, barra de progreso animada, los chips
de `.quick-folder-chip` (carpetas rápidas) y breakpoints para pantallas angostas.
