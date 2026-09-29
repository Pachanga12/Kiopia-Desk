# Kopia Desk v2

[![CI](https://github.com/Pachanga12/Kopia-Desk/actions/workflows/ci.yml/badge.svg)](https://github.com/Pachanga12/Kopia-Desk/actions/workflows/ci.yml)
![Plataforma](https://img.shields.io/badge/plataforma-Windows%2010%2F11-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)
![Tests](https://img.shields.io/badge/tests-154-brightgreen?logo=nodedotjs&logoColor=white)
[![Licencia](https://img.shields.io/badge/licencia-MIT-blue)](LICENSE)

Aplicación de escritorio para copias de seguridad incrementales en Windows. Permite respaldar carpetas como Imágenes, Documentos o Descargas a discos externos o USB, y cifrar, desbloquear y bloquear el disco destino con BitLocker desde la propia app.

> **Estado: versión 2.0.** Este README documenta lo que la app hace hoy, los problemas detectados en revisión de código (y cuáles ya están corregidos), y el trabajo pendiente. Antes de confiarle datos que no puedas perder, lee las secciones [Problemas conocidos](#problemas-conocidos) y [Limitaciones](#limitaciones).

Kopia Desk es un proyecto independiente. No tiene relación con [Kopia](https://kopia.io) (la herramienta de backup en Go).

---

## Descargar

El instalador para Windows está en **[Releases](https://github.com/Pachanga12/Kopia-Desk/releases/latest)**: descarga `Kopia.Desk.v2.Setup.2.4.0.exe` y ejecútalo.

- El instalador **no está firmado**: Windows SmartScreen puede mostrar "Windows protegió su PC". Pulsa **Más información → Ejecutar de todas formas**.
- **Instalar** es un asistente en español: bienvenida, licencia (hay que marcar **"Acepto los términos de la licencia"** para seguir; se muestra la traducción al español y el original en inglés) y final con **"Abrir Kopia Desk ahora"** y **"Crear acceso directo en el escritorio"** (marcadas). Se instala solo para tu usuario, sin pedir permiso de administrador.
- **Desinstalar** (desde "Agregar o quitar programas") pide confirmación, recuerda que **los backups de tus discos no se borran**, ofrece **"Borrar también mi configuración"** (desmarcada) y termina con "Muchas gracias por usar Kopia Desk". También quita el acceso directo del escritorio.
- Cifrar o bloquear un disco con BitLocker pide el permiso de administrador de Windows en ese momento; el resto de la app no lo necesita.
- Para más detalle técnico del código, ver [docs/arquitectura.md](docs/arquitectura.md).

---

## Índice

1. [Descargar](#descargar)
1. [Cómo ejecutar](#cómo-ejecutar)
2. [Qué hace](#qué-hace)
3. [Estructura de backup en disco destino](#estructura-de-backup-en-disco-destino)
4. [Cifrado del disco destino (BitLocker)](#cifrado-del-disco-destino-bitlocker)
5. [Problemas conocidos](#problemas-conocidos)
6. [Limitaciones](#limitaciones)
7. [Consideraciones técnicas](#consideraciones-técnicas)
8. [Seguridad](#seguridad)
9. [Plan de pruebas](#plan-de-pruebas)
10. [Hoja de ruta](#hoja-de-ruta)
11. [Recomendaciones para quien usa la app](#recomendaciones-para-quien-usa-la-app)
12. [Stack](#stack)
13. [Licencia](#licencia)

---

## Cómo ejecutar

```bash
npm install
npm start
```

> Con npm 11 o posterior, si `npm start` dice que Electron no está instalado, ejecuta una vez `node node_modules/electron/install.js` (npm ya no corre automáticamente el script que descarga el binario).

### Tests

La lógica de escaneo, hashing, copia verificada, deduplicación, exclusiones, journal y rutas seguras vive en `lib/core.js` para poder testearla sin levantar Electron:

```bash
npm test
npm run lint   # comprobación de sintaxis de main, preload, core y renderer
```

`test/core.test.js` cubre la lógica base; `test/integridad.test.js` cubre los arreglos de integridad (problemas 1 a 5), el informe de escaneo y la detección de disco y cifrado; `test/bitlocker.test.js` cubre el lanzamiento del ayudante de BitLocker, la contraseña del panel (DPAPI de ida y vuelta, lectura y borrado del `.pw` en el ayudante) y expulsar; `test/disco-sistema.test.js` cubre la protección del disco del sistema y los cambios de disco; `test/excluir.test.js` cubre excluir carpetas o archivos concretos, la lista de excluidos con su regla, el resumen del último backup y detener una copia. El ayudante en sí (`lib/bitlocker-helper.ps1`) necesita administrador y se probó contra discos virtuales (ver [Plan de pruebas](#plan-de-pruebas)). Los tests y el lint corren en cada push en GitHub Actions (Windows y Ubuntu, Node 20 y 22); en Ubuntu se omiten los que dependen de Windows (letras de unidad, PowerShell, bloqueos de archivo reales).

### Empaquetar como instalador

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"   # sin certificado de firma
npm run build
```

Genera `dist/Kopia Desk v2 Setup 2.1.0.exe` (instalador NSIS). El instalador **no está firmado** todavía (ver [Seguridad](#seguridad)). Más detalles en [docs/arquitectura.md](docs/arquitectura.md#notas-de-desarrollo).

En GitHub, `.github/workflows/release.yml` compila y publica el instalador automáticamente al subir un tag de versión (por ejemplo `v2.1.1`), o a mano desde la pestaña *Actions*.

---

## Qué hace

- **Selección de carpetas origen** con el diálogo nativo de Windows o con accesos rápidos a Imágenes, Documentos, Descargas, Música, Videos y Escritorio (solo aparecen las que existen). Si dos carpetas terminan con el mismo nombre, la segunda se renombra (carpeta padre o número) para no compartir manifiesto.
- **Bienvenida** mientras no hay carpetas: "Tus archivos, resguardados" y tres pasos (elegir carpetas, elegir el disco, revisar y confirmar) que se marcan con ✔ al cumplirse; los dos primeros llevan directo a "Añadir carpeta" y al selector de disco.
- **Peso de cada carpeta** al agregarla ("12,4 GB · 3.210 archivos"), con las mismas exclusiones que el backup.
- **Resumen antes de copiar**, debajo de Origen: cuánto pesa lo seleccionado, cuánto se va a copiar de verdad tras escanear (en un backup incremental, solo lo nuevo y lo cambiado) y el espacio libre del destino, con **"Cabe" / "No cabe"** y los botones **Escanear** y **Copiar**. Si esos botones quedan fuera de la vista (muchas carpetas o pantalla baja), aparece una barra fija abajo con el mismo veredicto y los mismos botones.
- **Tiempo de la copia:** antes de copiar, el Resumen estima cuánto tardará con la velocidad medida en ese disco en backups anteriores (incluye guardar las versiones anteriores). Durante la copia: "Lleva 1:23 · quedan ~3 min · 25 MB/s"; al terminar, el registro dice cuánto tardó.
- **Detener:** un botón en la barra de progreso (backup y restauración). Deja de empezar archivos nuevos; el que está en curso termina y se verifica, así que nunca queda nada a medias. Lo copiado queda registrado y el resto sale como pendiente en el próximo escaneo.
- **Segundo plano:** al pulsar la X, la app pregunta si cerrar o seguir en segundo plano (con un icono junto al reloj de Windows para volver o salir y un aviso al terminar la copia); la elección se puede recordar y cambiar en Opciones. Si se cierra con una copia en curso, se detiene como con "Detener" antes de salir.
- **Último backup** en la tarjeta del disco destino: cuándo fue, cuántos archivos copió y un botón **Abrir carpeta** para verlo en el Explorador. Sale de los informes que la app ya deja en el disco en cada copia.
- **Detección de discos/USB** conectados con espacio disponible y sistema de archivos (NTFS, exFAT, FAT32). La lista **se actualiza sola al conectar o quitar una USB** (aviso `WM_DEVICECHANGE` de Windows, sin consultar a intervalos) y conserva el disco elegido; también hay un botón ↻ junto al selector.
- **Cifrado del destino con BitLocker desde la app:** muestra el estado al elegir el disco (sin permisos de administrador), cifra con la contraseña escrita en el propio panel y clave de recuperación obligatoria, desbloquea con el cuadro de Windows, bloquea al terminar el backup si se pide y expulsa el disco de forma segura. Ver [Cifrado](#cifrado-del-disco-destino-bitlocker).
- **Escaneo recursivo** asíncrono con barra de progreso.
- **Excluir lo que no quieres copiar**, en su propia tarjeta bajo el Resumen: con **Carpeta** y **Archivo** eliges con el explorador carpetas o archivos concretos dentro de tus carpetas de origen (se excluye esa ruta, no todo lo que se llame igual) y se quitan de la lista con ×. Plegado en **Por nombre o tipo** están las reglas por defecto como casillas (archivos de Windows `desktop.ini`/`Thumbs.db`, temporales `*.tmp`/`~$*`, `.git` y `node_modules`; desmarcar una hace que se copie) y los patrones propios (`*.iso`, `Backups_temp`). `$RECYCLE.BIN` y `System Volume Information` se ignoran siempre. Los resultados del escaneo muestran el grupo **Excluidos por filtros** con cada elemento y la regla que lo dejó fuera. Al cambiar las exclusiones se vuelve a medir el peso y hay que volver a escanear.
- **Informe de lo que queda fuera:** cada carpeta muestra un grupo "Omitidos" con enlaces/junctions (no se siguen), carpetas sin permiso y archivos ilegibles, más la cantidad de excluidos por filtros. Todo queda también en el log JSON del backup.
- **Comparación incremental** contra el último manifiesto. Si cambia el tamaño, el archivo cambió. Si solo cambió la fecha, se compara el **SHA-256 completo** contra el guardado en el manifiesto (el hash rápido de cabecera y cola ya no decide nada, ver [problema 3](#3-el-hash-rápido-decide-qué-no-se-copia)). Los archivos "tocados" sin cambios de contenido no se recopian y su fecha se actualiza en el manifiesto.
- **Detección de archivos nuevos, cambiados y eliminados.** Cada categoría se puede aceptar u omitir por carpeta. Los "eliminados" siguen guardados en el backup.
- **Aviso de cambios sospechosos:** si más de la mitad de lo respaldado cambió de golpe, o desaparecieron y aparecieron muchos archivos a la vez (patrón típico de ransomware o corrupción masiva), la copia se bloquea hasta que confirmes que lo revisaste.
- **Verificación de espacio libre en vivo.** Si lo que se va a copiar no entra, el Resumen dice cuánto falta y se deshabilita la copia.
- **Aviso de FAT32:** los archivos de 4 GB o más no caben en un disco FAT32; se avisan antes de copiar, se omiten y vuelven a aparecer en el próximo escaneo.
- **Copia a `<disco>\KopiaDesk_Backup\<carpeta>\`** con concurrencia adaptada al tipo de disco (SSD/HDD; los pendrives USB copian de a un archivo, que en pruebas resultó más rápido que en paralelo).
- **Copia atómica y verificada:** cada archivo se copia a un temporal `.kopia-tmp` junto al destino, se compara el SHA-256 del temporal contra el del origen, se comprueba que el origen no cambió durante la copia y recién entonces se renombra sobre el destino. Un corte a mitad nunca deja un archivo del backup truncado.
- **Reintentos ante bloqueos pasajeros:** si un archivo está bloqueado un instante (antivirus, indexador de búsqueda, OneDrive), la copia se reintenta hasta 3 veces con espera creciente (80, 160 y 320 ms), siempre sobre el temporal: el archivo que ya estaba en el backup no se toca mientras tanto ni si al final falla. Errores que no se arreglan esperando (sin permiso, archivo inexistente, disco lleno) fallan al primer intento.
- **El manifiesto solo registra lo que se copió y verificó**, con su SHA-256. Lo que falló (archivo en uso, disco lleno, etc.) vuelve a aparecer en el próximo escaneo.
- **Deduplicación por contenido** (SHA-256 completo): si el archivo ya existe en el backup, se crea un hardlink en vez de copiar. Antes de enlazar se verifica por hash que el archivo indexado siga teniendo ese contenido. En exFAT/FAT32 no hay hardlinks y se copia normal.
- **Versionado opcional:** antes de sobrescribir un archivo cambiado, guarda la versión anterior comprimida con gzip en `.kopia-data\versions\<fecha>\`.
- **Verificación profunda opcional:** revisa por SHA-256 completo también los archivos que conservan tamaño y fecha.
- **Journal de operaciones:** detecta backups interrumpidos (corte de luz, USB desconectado), explica qué pasó y pide confirmación antes de borrar los temporales que quedaron a medias. Nunca borra archivos del backup.
- **Pestaña Comparar:** compara carpetas del backup contra carpetas locales elegidas, detecta faltantes y permite restaurar solo esos. Detecta archivos que figuran como respaldados pero ya no están en el disco de backup.
- **Pestaña Restaurar:** trae una carpeta completa del backup a cualquier ubicación, útil tras formatear o con otro perfil de Windows. La restauración usa la misma copia verificada.
- **Tema claro/oscuro**, ventana sin marco con controles propios y persistencia de configuración.
- **Instancia única:** si Kopia Desk ya está abierta, abrirla de nuevo trae al frente la ventana existente en vez de abrir otra (dos instancias podrían pisarse los manifiestos y la configuración).

---

## Estructura de backup en disco destino

```
D:\KopiaDesk_Backup\
├── Fotos\                    archivos respaldados (visibles, usables sin la app)
├── Documentos\
└── .kopia-data\              oculta (atributos Hidden + System)
    ├── manifests\            estado de cada carpeta, con SHA-256 (+ .prev.json)
    ├── versions\             versiones anteriores (.gz)
    ├── journal\              registro de backups en curso
    ├── logs\                 registros JSON por ejecución (copiados, fallidos, omitidos)
    ├── content-index.json    índice hash -> ruta para dedup
    └── sources.json          ruta de origen recordada por carpeta
```

Los archivos respaldados son archivos normales. Si la app no está disponible, se pueden abrir y copiar directamente desde el Explorador. Las versiones anteriores se recuperan descomprimiendo el `.gz` con cualquier herramienta (7-Zip, por ejemplo).

Un archivo `*.kopia-tmp` dentro del backup es una copia que quedó a medias por un corte; se puede borrar sin perder nada (la app lo hace al confirmar la limpieza del journal).

---

## Cifrado del disco destino (BitLocker)

> **Estado: fases 1, 2 y 3 implementadas.** Desde la app se detecta el estado, se cifra, se desbloquea y se bloquea el disco destino, sin pasar por el panel de BitLocker de Windows.

### Por qué cifrar el disco y no los archivos

El backup se guarda en claro. Un USB perdido expone todo su contenido, incluidos `sources.json` y los logs, que contienen rutas completas con el nombre de usuario de Windows. Se evaluó cifrar archivo por archivo dentro de la app y se descartó: cifrar el volumen completo con BitLocker protege también los metadatos, no requiere reimplementar criptografía, y el disco sigue siendo legible en cualquier Windows con la contraseña, sin necesitar Kopia Desk para restaurar.

### Qué ediciones de Windows lo permiten

| Acción | Windows Pro / Enterprise / Education | Windows Home |
|---|---|---|
| Cifrar un USB/disco con BitLocker To Go | Sí | No |
| Desbloquear y usar un USB ya cifrado | Sí | Sí |

*A verificar en cada versión de Windows soportada antes del release; la disponibilidad de BitLocker por edición la define Microsoft y puede cambiar.*

En Windows Home la app detecta que no puede cifrar (por `EditionID`) y muestra alternativas (ver [Alternativas sin BitLocker](#alternativas-sin-bitlocker)) en lugar del botón de cifrar. Desbloquear sí funciona en Home.

### Qué ve el usuario

Al elegir el disco destino, la app consulta su estado **sin pedir permisos de administrador** y muestra un panel:

| Estado | Qué muestra | ¿Se puede copiar? |
|---|---|---|
| Sin cifrar | Aviso en rojo con **"Cifrar este disco"** y los campos de contraseña, para que siempre se vea dónde cifrar. Cifrarlo es opcional: **"Omitir por ahora"** lo pliega a una línea roja ("Disco sin cifrar" con **"Cifrar…"** para volver a abrirlo), y la app lo recuerda para ese disco | Sí |
| Cifrando | Porcentaje y barra de progreso; aviso de no desconectar | Sí, más lento |
| Cifrado y desbloqueado | **"Bloquear ahora"** y la casilla **"Bloquear el disco al terminar el backup"** (se recuerda) | Sí |
| Cifrado y bloqueado | **"Desbloquear"** | No, hasta desbloquearlo |
| Suspendido / a medio configurar | "Abrir panel de BitLocker" para resolverlo en Windows | Suspendido sí; a medio configurar pide confirmación |
| Desconocido | Se informa | Sí |
| **Disco del sistema** (o disco físico no identificado) | Solo una nota neutra: "Kopia Desk no ofrece cifrarlo ni bloquearlo". **Ninguna opción de cifrado**: ni botones ni la casilla de continuar sin cifrar | Sí, con aviso de que no es buen destino |

Nunca se ofrece cifrar ni bloquear el disco del sistema (ver [Protección del disco del sistema](#protección-del-disco-del-sistema-y-cambios-de-disco)).

**Cifrar este disco:**

1. La contraseña se escribe **en el propio panel del disco**, dos veces, con mínimo 8 caracteres (el mínimo de BitLocker) e indicador de fortaleza, que recomienda 12 o más. Un ojo en cada campo muestra u oculta lo escrito. "Cifrar este disco" no se habilita hasta que sea válida y coincida.
2. La app explica los pasos y pregunta el alcance: **"Solo el espacio usado"** (rápido, recomendado para discos nuevos) o **"Disco completo"** (recomendado si el disco tuvo datos antes: cifra también lo borrado). Al continuar, los campos de contraseña se vacían.
3. Windows pide permiso de administrador (UAC).
4. Una ventana de Kopia Desk muestra la **clave de recuperación** de 48 dígitos. Hay que guardarla en un archivo (se rechaza guardarla en el disco que se va a cifrar) o copiarla, y confirmar que se guardó fuera del disco. Sin eso, "Cifrar ahora" no se habilita.
5. Recién entonces se activa BitLocker (AES-256). La app muestra el progreso y, al terminar, confirma el estado real con BitLocker.

Si se cancela en cualquier paso, el disco no se modifica. Si la ventana del ayudante se cierra a la fuerza, la app lo detecta y lo informa. Si el disco se desconecta mientras se cifra, BitLocker continúa al reconectarlo.

**Desbloquear** abre el cuadro de contraseña del propio Windows, sin permiso de administrador. Es el mismo cuadro que aparece al conectar el disco en cualquier otro equipo, así que se practica lo mismo que se hará fuera. **Bloquear** (manual o al terminar el backup) pide el permiso de administrador y confirma con BitLocker que el disco quedó bloqueado.

**Expulsar** hace lo mismo que "Quitar hardware de forma segura" de Windows, sin permiso de administrador, para cualquier disco destino que no sea el del sistema (cifrado o no). Solo expulsa dispositivos que Windows marca como extraíbles, nunca una controladora interna. Si algún programa o ventana del Explorador está usando el disco, Windows lo impide y la app explica qué hacer.

### Cómo está hecho

- **Estado sin elevación.** `Get-BitLockerVolume` exige administrador, así que se lee la propiedad de shell `System.Volume.BitLockerProtection` (vía `Shell.Application`). Mapeo: 1 = cifrado, 2 = sin cifrar, 3 = cifrando, 4 = descifrando, 5 = suspendido, 6 = bloqueado, 8 = esperando activación, 0 = no admite BitLocker. Proviene de documentación de la comunidad, no de Microsoft. **Verificados en Windows 11 Pro 26200 los valores 1, 2, 3 y 6.** Pendientes: 4, 5, 8 y Windows 10.
- **Ayudante elevado** (`lib/bitlocker-helper.ps1`). La app no corre como administrador: para cifrar o bloquear lanza este script con `Start-Process -Verb RunAs`. Los argumentos solo llevan la acción, la letra de unidad (validada con `/^[A-Z]$/i`), la identidad del volumen y las rutas del archivo de estado y, al cifrar, del archivo de contraseña.
- **La contraseña del panel hasta el ayudante.** El proceso principal la valida y la protege con **DPAPI** (`ConvertFrom-SecureString`, ligada al usuario de Windows): la recibe PowerShell por la entrada estándar en base64, para que tildes y eñes lleguen intactas. El resultado cifrado va a `<userData>\bitlocker\<letra>-Encrypt-<aleatorio>.pw`, con un nombre nuevo en cada intento. El ayudante lo lee al arrancar, **lo borra en el acto** y obtiene un `SecureString`. Solo acepta un `.pw` de la misma carpeta que su archivo de estado, y fuera de ahí no lee ni borra nada. Si el permiso de administrador lo da otra cuenta de Windows, DPAPI no puede abrirlo y el ayudante pide la contraseña en su propia ventana; la app avisa del motivo. El proceso principal también borra el `.pw` si el ayudante no llega a arrancar, a los 2 minutos como máximo, y al abrir o cerrar la app.
- **Expulsar** (`lib/eject-drive.ps1`, sin elevar). Obtiene el número de disco del volumen (`IOCTL_STORAGE_GET_DEVICE_NUMBER`), busca ese disco entre los dispositivos de Windows y sube por sus padres hasta el primero marcado como extraíble (`CM_DEVCAP_REMOVABLE`); si no hay ninguno, no expulsa. Luego pide `CM_Request_Device_Eject` e informa el veto de Windows si lo hay. Se lanza como archivo: como `-EncodedCommand`, PowerShell tardaba unos 30 s preparando módulos. El ayudante informa su progreso escribiendo JSON en ese archivo (de forma atómica y sin secretos), y la app lo lee cada 1,5 s. En el instalador, el script se deja fuera del `.asar` (`asarUnpack`) para que PowerShell lo pueda leer.
- **Orden de protectores.** La clave de recuperación se genera en el ayudante con un generador criptográfico, en el formato de BitLocker (8 grupos de 6 dígitos múltiplos de 11), **antes** de cifrar. Así se puede obligar a guardarla antes de empezar. Luego se activa BitLocker con esa clave (`Enable-BitLocker -RecoveryPasswordProtector -RecoveryPassword`) y se agrega la contraseña (`Add-BitLockerKeyProtector -PasswordProtector`). Si agregar la contraseña fallara, el disco sigue siendo abrible con la clave que el usuario ya guardó.
- **Método de cifrado.** `Aes256`. Microsoft indica que para medios removibles que se vayan a leer en Windows 8.1 o Server 2012 R2 hay que usar AES (no XTS). No se usa `-HardwareEncryption` (Microsoft lo desaconseja, aviso ADV180028).
- **Desbloqueo** con `bdeunlock.exe <letra>:`, el cuadro nativo de Windows. No necesita administrador y la contraseña de desbloqueo nunca pasa por la app.

### Protección del disco del sistema y cambios de disco

Kopia Desk **nunca cifra ni bloquea el disco donde está instalado Windows**, ni ninguna de sus particiones (C:, la de arranque EFI, la de recuperación, u otra partición de ese mismo disco físico aunque tenga letra). Cifrar o bloquear cualquiera de ellas puede dejar el equipo sin arrancar.

- **Qué cuenta como disco del sistema:** el disco físico marcado por Windows como de arranque o de sistema (`Get-Disk` `IsBoot`/`IsSystem`) y el que contiene la unidad de Windows (`Win32_OperatingSystem.SystemDrive`, que no siempre es C:). No se decide por la letra.
- **Ante la duda, no:** si no se puede averiguar en qué disco físico está un volumen, se trata como disco del sistema.
- **La letra no alcanza.** Al elegir un disco, la app guarda su identidad de volumen (`\\?\Volume{GUID}\`). Antes de cifrar o bloquear se comprueba que la letra siga siendo **ese mismo volumen**: si el USB se cambió por otro que tomó la misma letra, se desconectó o cambió de letra, la operación se cancela sin tocar nada.
- **Tres capas independientes:**
  1. **La interfaz** no muestra los botones para el disco del sistema y explica por qué.
  2. **El proceso principal** relee la lista de discos en el momento (no usa la de la pantalla) y comprueba identidad y disco del sistema.
  3. **El ayudante elevado** repite ambas comprobaciones al arrancar y otra vez **justo antes** de `Enable-BitLocker` o `Lock-BitLocker`, porque entre medio el usuario pudo pasar minutos escribiendo la contraseña y cambiar el disco.

  La decisión del ayudante (`Test-KdTargetAllowed`) es una función pura que los tests ejecutan con los mismos escenarios que la de la app (`checkBitLockerTarget`), para garantizar que ambas coinciden.

### Reglas de seguridad (cómo se cumplen)

1. **La contraseña nunca va en la línea de comandos.** ✅ El ayudante recibe solo la ruta del archivo `.pw` (comprobado en la línea de comandos real del proceso elevado durante las pruebas).
2. **La contraseña nunca se guarda en claro.** ✅ En la app solo vive en los campos del panel, que se vacían al empezar, y en memoria durante el envío. No se escribe en `settings.json` ni en los logs. En disco solo existe unos segundos, cifrada con DPAPI, y el ayudante la borra al leerla. En el ayudante es un `SecureString` que se descarta al terminar.
3. **La clave de recuperación nunca se escribe en el disco que se cifra**, ni en `.kopia-data`. ✅ Se rechaza guardarla en ese disco; solo se escribe donde el usuario elige.
4. **Elevación mínima.** ✅ Solo el ayudante corre elevado, y solo para cifrar o bloquear.
5. **Validación de la letra de unidad** antes de interpolarla. ✅ En la app y en el `param()` del ayudante; las rutas con comillas dobles se rechazan.
6. **Nunca el disco del sistema.** ✅ Ninguna partición del disco físico de Windows, comprobado en la interfaz, en el proceso principal y dos veces en el ayudante (ver sección anterior).
7. **Confirmar el estado real** con `Get-BitLockerVolume` tras cada operación. ✅ Protectores tras cifrar, `LockStatus` tras bloquear.
8. **Mensajes de error claros.** ✅ Para edición sin BitLocker, UAC rechazado, disco ya cifrado, ayudante cerrado, disco desconectado y protegido contra escritura.

### Alternativas sin BitLocker

Para Windows Home o para discos que se usarán en macOS/Linux:

- **VeraCrypt** (externo, código abierto): la app puede detectar si está instalado y enlazar a una guía, pero no automatizarlo.
- **Actualizar a Windows Pro.**
- **Cifrado a nivel de archivo dentro de la app** (AES-256-GCM con clave derivada por scrypt o Argon2): descartado por ahora. Implica que sin la app no se puede leer el backup, y requiere manejar nonces, rotación y verificación de integridad con cuidado.

---

## Problemas conocidos

Detectados en revisión de `main.js` y `lib/core.js`. Ordenados por riesgo para datos ya respaldados. **Los seis están corregidos**; se conservan aquí con su arreglo porque explican decisiones del código.

### 1. Índice de dedup obsoleto puede enlazar contenido equivocado

**Riesgo: alto (corrupción silenciosa). Solo con dedup activado. ✅ Corregido.**

`content-index.json` guardaba `hash -> ruta` y nunca olvidaba entradas: si el archivo en esa ruta cambiaba, el hash viejo seguía apuntando ahí, y `linkTo()` solo comprobaba que la ruta existiera.

Escenario: A contiene X (índice: X -> A). A cambia a Y y se recopia (índice sigue con X -> A). Aparece B con contenido X: se enlazaba a A, que ahora contiene Y. B quedaba respaldado con contenido equivocado.

**Arreglo aplicado:** `ContentIndex` mantiene también el índice inverso ruta -> hashes; toda escritura sobre una ruta (copia o enlace, con o sin dedup activado) olvida los hashes que apuntaban a ella. Antes de enlazar se verifica el tamaño y el SHA-256 completo del archivo indexado; si no coincide, se descarta la entrada y se copia. Índices escritos por versiones anteriores (`hash -> "ruta"`) se siguen leyendo y quedan protegidos por esa verificación. Test: *"problema 1: A con X, A cambia a Y, aparece B con X"*.

### 2. Sobrescribir un archivo enlazado puede alterar sus copias

**Riesgo: alto. ✅ Corregido.**

`copyOneTask` hacía `copyFile` sobre un destino que podía ser un hardlink compartido, modificando el contenido de todos los enlaces a la vez. La v2 lo mitigó borrando antes de copiar (`copyFileReplacing`), pero un corte entre ambos pasos dejaba el destino borrado.

**Arreglo aplicado:** copia siempre a un temporal en la misma carpeta y `rename` sobre el destino (`copyFileVerified`). Eso rompe el enlace sin tocar el contenido compartido y además hace la escritura atómica. Test: *"problema 2: sobrescribir un archivo enlazado no cambia el contenido de sus enlaces"*.

### 3. El hash rápido decide qué no se copia

**Riesgo: medio-alto para ciertos tipos de archivo. ✅ Corregido.**

Si cambiaba la fecha pero el hash de cabecera+cola (64 KB + 64 KB + tamaño) coincidía, el archivo se consideraba sin cambios. Archivos editados en el medio conservando tamaño quedaban sin respaldar: bases de datos (SQLite, Access), `.pst`/`.ost` de Outlook, discos virtuales (`.vhdx`, `.vmdk`), contenedores cifrados, algunos formatos de Office.

**Arreglo aplicado:** si la fecha cambió y el tamaño no, se calcula el SHA-256 completo y se compara con el guardado en el manifiesto. El SHA-256 de cada archivo copiado lo calcula la propia copia verificada y se guarda en el manifiesto, así que no hay lecturas extra. Con manifiestos de versiones anteriores (sin SHA-256) esos archivos se recopian una sola vez. Verificado en la app con un archivo de 1 MB editado en el medio.

### 4. Escrituras no atómicas en archivos críticos

**Riesgo: medio. ✅ Corregido.**

`manifest:save`, `saveContentIndex`, `sources:remember` y `settings:save` usaban `writeFileSync` directo; un corte dejaba un JSON truncado y `manifest:load` devolvía `{}` en silencio.

**Arreglo aplicado:** todas esas escrituras (y los logs) pasan por `atomicWriteFileSync`: `archivo.kopia-tmp`, `fsync`, `rename`. Al cargar un manifiesto dañado se usa `.prev.json` y se avisa en el registro; si tampoco sirve, también se avisa. `.prev.json` solo se actualiza desde un manifiesto que se pudo leer, así un principal dañado nunca pisa el último respaldo bueno. Verificado en la app truncando un manifiesto en la USB.

### 5. La limpieza del journal puede borrar la única copia buena

**Riesgo: medio. ✅ Corregido.**

Si un archivo cambiado estaba a medio sobrescribir al cortarse, `checkJournals` lo borraba, y sin versionado no quedaba ni la versión anterior ni la nueva.

**Arreglo aplicado:** con la copia a temporal + `rename`, lo que queda a medias es el `.kopia-tmp`. Los journals nuevos (`version: 2`) solo borran esos temporales y nunca tocan el destino. Los journals de versiones anteriores mantienen el comportamiento viejo, porque ahí el destino sí podía estar truncado. Test: *"problema 5: la única copia buena no debe borrarse"*; verificado en la app matando el proceso a mitad de copia.

### 6. Los handlers IPC confían en rutas enviadas por el renderer

**Riesgo: bajo en la práctica, importante como principio. ✅ Corregido.**

**Arreglo aplicado:** el proceso principal lleva listas de rutas autorizadas y rechaza todo lo demás:

- Discos destino: solo los devueltos por `listDrives`.
- Orígenes (`fs:scan-directory`, `fs:hash-file`, tareas de copia): solo carpetas elegidas por diálogo, accesos rápidos, o guardadas en la configuración (que a su vez solo guarda orígenes autorizados).
- Destinos de copia: dentro de `KopiaDesk_Backup` y fuera de `.kopia-data`; versiones solo dentro de `.kopia-data\versions`.
- Restauración: `backupFullPath` dentro de `<disco>\KopiaDesk_Backup` y carpeta de destino elegida por diálogo.
- Las rutas de `sources.json` del disco solo sirven para listar nombres y tamaños en Comparar, no para leer contenido.

Verificado en la app: pedir el hash de `C:\Windows\win.ini`, escanear `C:\Windows`, usar un disco inexistente o restaurar a una carpeta no elegida se rechaza.

---

## Limitaciones

- **Sin cifrado propio del backup.** Depende de cifrar el disco (ver sección de cifrado).
- **Sin archivos en uso.** Los bloqueos de milisegundos se superan con reintentos, pero un archivo que sigue abierto (Outlook, bases de datos activas) falla con un mensaje claro ("Archivo en uso por otro programa"), conserva en el backup su versión anterior y se reintenta en el próximo backup. No se usa Volume Shadow Copy.
- **Sin programación.** Los backups son manuales.
- **Sin interfaz para restaurar versiones anteriores.** Existen como `.gz` en una carpeta oculta.
- **Sin retención.** Los archivos eliminados del origen y las versiones anteriores se acumulan para siempre.
- **Un solo destino por ejecución.** No cubre por sí sola la regla 3-2-1.
- **Solo Windows.** Usa PowerShell, `attrib` y rutas de Windows.
- **Sin auto-actualización.** Las correcciones de seguridad de Electron solo llegan reinstalando.
- **Rapidez de la interfaz.** Las consultas a Windows (lista de discos, tipo de disco, estado de cifrado) usan un PowerShell que queda abierto: detectar discos pasó de ~1,7 s a ~0,25 s, y elegir un disco muestra su cifrado y su tipo en 0,03–0,16 s. Al abrir la app, la lista de discos está lista a los ~1,75 s. Al escanear, los SHA-256 de archivos con la fecha cambiada se calculan varios a la vez en discos SSD (medido: de 119 a 182 MB/s); en discos mecánicos, de a uno.
- **Velocidad frente a Windows** (robocopy, con el mismo vaciado de caché al final), medida en dos USB reales (NTFS y exFAT) con 3 archivos de 256 MB y con 2.000 archivos de 4–64 KB:

  | | Archivos grandes | 2.000 pequeños |
  |---|---|---|
  | **Backup** | 94–100 % de la velocidad de Windows | 70–103 % |
  | **Restaurar** | 84 % | 115–145 % (más rápido que Windows) |

  La diferencia que queda es la verificación: cada archivo se fuerza a disco y se relee para comparar su SHA-256, cosa que Windows no hace. Con muchos archivos pequeños la app mide sola si le conviene copiar 1 o 2 a la vez en ese disco. Algunas USB tienen frenazos propios (de 7 a 22 s cada tanto, con cualquier programa), así que los tiempos varían de una corrida a otra.

---

## Consideraciones técnicas

### Integridad de datos

- ✅ **Verificación post-copia** por SHA-256, siempre activa. *Alcance real:* relee el temporal recién escrito, y Windows suele servir esa lectura desde su caché en memoria. Detecta errores de la copia (lectura del origen, escritura interrumpida, archivo cambiado a mitad), pero **no garantiza** que el medio físico haya guardado bien los datos: para eso hace falta la verificación periódica del punto siguiente, idealmente tras desconectar y reconectar el disco.
- **Verificación periódica del backup** contra el manifiesto por hash, no solo por existencia, para detectar degradación del medio. Pendiente (el manifiesto ya guarda el SHA-256 necesario).
- ✅ **Archivos modificados durante la copia:** si tamaño o fecha cambian mientras se copia, la copia se descarta y el archivo queda para el próximo backup.
- ✅ **Reporte de lo que quedó fuera:** bloqueados, excluidos, enlaces simbólicos, errores de permisos, demasiado grandes para FAT32.

### Windows y sistemas de archivos (a probar)

- ✅ **FAT32:** límite de 4 GB por archivo. Se detecta el sistema de archivos del destino y se avisa antes de copiar.
- ✅ **exFAT y FAT32:** sin hardlinks (el dedup cae a copia normal, verificado en un USB exFAT) y sin journaling (se avisa al elegir el disco).
- **Resolución de fecha en FAT:** 2 segundos. Puede generar falsos "cambiados" (ahora se resuelven por SHA-256 sin recopiar) o no detectar cambios rápidos (la verificación profunda los detecta).
- **NTFS:** límite de 1023 hardlinks por archivo. El fallback a copia ya lo cubre.
- **BitLocker To Go** funciona con NTFS, exFAT y FAT32 (verificar).
- **Rutas mayores a 260 caracteres.**
- **Nombres problemáticos:** Unicode, emojis, espacios o puntos al final, nombres reservados (`CON`, `NUL`, `COM1`).
- **OneDrive "archivos a petición":** hashear o copiar un marcador fuerza la descarga desde la nube. En una carpeta Documentos sincronizada puede significar gigas descargados sin aviso. Detectar el atributo de marcador y advertir.
- ✅ **Junctions y enlaces simbólicos:** el escaneo los ignora (evita bucles) y ahora se informan como "Omitidos".
- ✅ **Archivos `.asar`:** Electron trata los `.asar` como carpetas en su `fs`; la app usa `original-fs` para poder respaldarlos (encontrado al respaldar una carpeta con otra app Electron dentro).
- **Cambio de letra de unidad del USB:** los manifiestos son relativos al destino; verificar que `sources.json` siga funcionando.
- **Renombrado automático de carpetas con el mismo nombre:** verificar qué pasa si cambia el orden o se quita una.
- **Metadatos no copiados:** ACLs, flujos de datos alternos (ADS), atributos (incluido sólo lectura).
- ✅ **Preservación de fechas** al copiar y al restaurar.
- **Suspensión o hibernación** del equipo durante un backup largo.
- ✅ **Dos instancias de la app en el mismo equipo:** resuelto con instancia única (`requestSingleInstanceLock`). Pendiente: dos equipos usando el mismo disco a la vez (un archivo lock en `.kopia-data`).

### Restauración

- **Conflictos:** en la restauración completa, un archivo existente en el destino se reemplaza (de forma atómica). Definir si sobrescribe, omite o pregunta.
- ✅ **Verificación de hash** tras restaurar.
- **Interfaz para versiones anteriores**, con lista por fecha y restauración a una carpeta elegida.
- **Restauración sin la app** documentada para el usuario final.

### Retención y espacio

- Política de purga configurable para eliminados y versiones (por antigüedad o cantidad).
- Mostrar cuánto ocupan versiones y eliminados.
- El cálculo de espacio libre debe incluir versiones comprimidas y margen para temporales (mientras se copia un archivo cambiado conviven el temporal y la versión anterior).
- Rotación de logs y journals viejos.

### Operación

- Recordatorio "último backup hace X días" o integración con el Programador de tareas de Windows.
- Soporte para un segundo destino o recordatorio de la regla 3-2-1.
- Manejo claro de la desconexión del USB a mitad de backup (interfaz, no solo journal).
- Sugerir expulsar el disco al terminar.

---

## Seguridad

### Estado actual (verificado en el código)

- `contextIsolation: true`, `nodeIntegration: false` y **`sandbox: true` explícito**. El preload expone solo funciones puntuales vía `contextBridge`.
- **Content Security Policy** en `renderer/index.html`:
  ```html
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'">
  ```
- **Navegación y ventanas nuevas bloqueadas:** `setWindowOpenHandler(() => ({ action: "deny" }))` y `will-navigate` cancelado.
- **Rutas validadas en el proceso principal** (problema 6).
- `safePath()` y `safeBackupPath()` impiden escribir fuera del destino y de `KopiaDesk_Backup`; `safeName()` sanitiza nombres.
- `execFile` en vez de `exec`, sin shell. La letra de unidad se valida antes de interpolarla en PowerShell.
- Límite de tamaño y validación de tipo al leer manifiestos para restaurar.
- Los nombres de archivo se muestran con `textContent`, nunca con `innerHTML`.

### Pendiente

- **`npm audit`** antes de cada release. Hoy informa 6 vulnerabilidades altas (`@xmldom/xmldom`, `brace-expansion`, `fast-uri`, `js-yaml`, `tar`, `undici`), todas dentro de `electron-builder`: afectan a la máquina que compila el instalador, no a la app instalada, que no tiene dependencias en tiempo de ejecución. Actualizar `electron-builder` cuando haya versión corregida.
- **Firma de código** del instalador NSIS, para evitar SmartScreen y garantizar integridad.
- **Canal de actualización** definido (releases de GitHub firmados como mínimo).
- **Privacidad de metadatos:** `sources.json` y logs contienen rutas completas con nombre de usuario. Quedan expuestos si el disco no está cifrado (la app lo advierte y permite cifrarlo).
- **Ransomware:** un USB conectado siempre se cifra junto con el equipo. La app debería sugerir desconectarlo al terminar.

---

## Plan de pruebas

Además de los tests de `lib/core.js`. ✅ = automatizado en `npm test`; 🔌 = verificado en la app real contra un USB exFAT (Windows 11 Pro).

**Integridad**
- ✅ Escenario del problema 1: A con X, A cambia a Y, aparece B con X. B debe terminar con X.
- ✅ Escenario del problema 2: sobrescribir un archivo que es hardlink y verificar que sus enlaces no cambien.
- 🔌 Archivo editado en el medio con mismo tamaño y fecha nueva (problema 3).
- 🔌 Corte simulado (matar el proceso) durante la copia. Pendiente: durante `manifest:save` y `saveContentIndex` (cubiertos por la escritura atómica, ✅ test de `.prev.json`).
- Desconexión del USB a mitad de copia.

**Sistemas de archivos**
- Destino FAT32 con archivo de 5 GB (✅ lógica del límite; falta la prueba con disco real).
- 🔌 Destino exFAT con dedup activado.
- Rutas de más de 260 caracteres y nombres con Unicode.
- Carpeta de OneDrive con archivos solo en la nube.

**Restauración**
- 🔌 Restauración completa y comparación de hashes contra el origen (en el mismo perfil; falta en otro perfil de Windows).
- Restauración de un archivo eliminado hace varios backups.
- Recuperación manual de una versión `.gz`.

**Rendimiento**
- 100.000 archivos pequeños (tiempo y memoria del manifiesto JSON).
- Archivos individuales de más de 10 GB.

**Cifrado** (🔌 = en la app real, sobre discos virtuales exFAT y NTFS; ✅ = `test/bitlocker.test.js`)
- 🔌 USB sin cifrar en Windows Pro: se advierte en rojo y aparece "Cifrar este disco"; se puede copiar sin cifrar (el cifrado es opcional).
- 🔌 Flujo completo desde la app con la **contraseña escrita en el panel** (8 caracteres exactos y con eñe): corta o que no coincide no deja continuar; al confirmar los campos se vacían; no aparece la ventana de contraseña del ayudante; el `.pw` no queda en disco; el disco se desbloquea con esa contraseña; sin guardar la clave de recuperación no se cifra; al terminar el disco queda cifrado con AES-256 y protectores de contraseña y clave de recuperación.
- 🔌 Bloquear, desbloquear (cuadro de Windows) y "Bloquear al terminar el backup".
- 🔌 Desbloquear con la clave de recuperación generada.
- 🔌 Cancelar en la ventana de contraseña: el disco no se modifica. Ayudante cerrado a la fuerza: la app lo detecta en segundos.
- 🔌 Progreso real (disco de 4 GB con 2,5 GB de datos, cifrado completo) y estados 1, 2, 3 y 6 leídos sin elevación.
- 🔌 **Disco del sistema:** cifrar o bloquear C: saltándose la interfaz (llamando directo a la app y ejecutando el ayudante a mano con la identidad real de C:) se rechaza en todos los casos, y C: queda sin tocar.
- 🔌 **Cambios de disco** (con dos discos virtuales que se conectan, desconectan e intercambian): disco cambiado por otro con la misma letra después de elegirlo; cambiado **mientras la ventana de contraseña estaba abierta**; desconectado con la ventana abierta; cambio de letra después de elegirlo. En todos se cancela sin cifrar ningún disco. Control: sin cambios, el cifrado sigue funcionando.
- ✅ `test/disco-sistema.test.js`: 9 escenarios (incluidos otra partición del disco del sistema con letra, disco físico desconocido y Windows instalado en otra letra) evaluados por la app **y** por el ayudante de PowerShell, que tienen que coincidir.
- 🔌 Disco demasiado pequeño para BitLocker: el error de Windows llega claro a la app.
- ✅ Validación de argumentos del ayudante: acción, letra y rutas (sin comillas dobles), escape de comillas simples.
- 🔌 La contraseña no viaja en la línea de comandos: la del proceso elevado real solo lleva acción, letra, identidad del volumen y las rutas del archivo de estado y del `.pw`.
- 🔌 **Expulsar** con un USB real: con un archivo abierto en el USB, Windows lo impide y la app explica el motivo; sin nada abierto, se expulsa en menos de un segundo y la letra desaparece. Un disco virtual (no extraíble) no se expulsa.
- ✅ `.pw` fuera de la carpeta de la app o con otra extensión: el ayudante no lo lee ni lo borra. `.pw` dañado: se pide la contraseña en la ventana y el archivo se borra igual.
- 🔌 **Sin permisos de administrador** (proceso con token normal, como corre la app instalada): la lista de discos, la detección del disco del sistema, el ID de volumen, el estado de BitLocker y el tipo de disco funcionan; la app detecta bien si el ayudante elevado sigue vivo.
- **Pendiente, requiere a una persona:** el aviso de UAC al cifrar o bloquear con la app sin elevación, y el caso de rechazarlo. El aviso aparece en el escritorio seguro de Windows y no se puede automatizar.
- Windows Home: la opción de cifrar no aparece y se muestran alternativas.
- Un USB real cifrado desde la app y desbloqueado en otro equipo sin Kopia Desk.

---

## Hoja de ruta

Ordenada por prioridad.

**Crítico (antes de usar con datos reales)**
1. ✅ Copia a temporal + `rename` (resuelve problemas 2 y 5).
2. ✅ Corregir invalidación del índice de dedup (problema 1).
3. ✅ Escrituras atómicas y fallback a `.prev.json` (problema 4).
4. ✅ Hash completo cuando cambia la fecha (problema 3).
5. ✅ Verificación post-copia por defecto.

**Alto**
6. ✅ Cifrado del disco destino, fase 1 (detección y advertencia).
7. ✅ Validación de rutas en el proceso principal (problema 6).
8. ✅ CSP, `sandbox: true` y bloqueo de navegación.
9. ✅ Detección de FAT32 y archivos mayores a 4 GB.
10. ✅ Reporte de archivos omitidos o bloqueados.

**Medio**
11. ✅ Cifrado del disco destino, fases 2 y 3 (cifrar, desbloquear y bloquear desde la app).
12. Interfaz para restaurar versiones anteriores.
13. Política de retención.
14. Manejo de conflictos al restaurar.
15. Advertencia de OneDrive archivos a petición.
16. Firma de código e instalador.

**Bajo**
17. Recordatorios o programación.
18. Segundo destino.
19. Volume Shadow Copy para archivos en uso.

---

## Recomendaciones para quien usa la app

- **Cifra el disco de backup.** Si el USB se pierde sin cifrar, cualquiera puede leerlo.
- **Guarda la clave de recuperación de BitLocker fuera del USB**: impresa, en un gestor de contraseñas o en tu cuenta Microsoft. Sin contraseña ni clave de recuperación, los datos son irrecuperables.
- **Desconecta el disco cuando termines.** Un disco conectado siempre queda expuesto a ransomware.
- **Ten más de una copia.** Idealmente tres copias, en dos medios distintos, con una fuera de casa u oficina.
- **Prueba restaurar** de vez en cuando. Un backup que nunca se restauró es una suposición.
- **Cierra Outlook y programas con bases de datos** antes de respaldar.
- **Prefiere NTFS** para el disco de backup: admite archivos grandes, hardlinks (dedup) y tiene journaling.

---

## Stack

- Electron (proceso principal + renderer aislado y en sandbox con `contextBridge`)
- Node.js (`fs`/`original-fs`, `crypto`, `zlib`, `child_process`)
- HTML/CSS/JS sin frameworks
- `node --test` para la suite de `lib/core.js`
- PowerShell: módulo `Storage`; `Shell.Application` para leer el estado de BitLocker; módulo `BitLocker` y WinForms en el ayudante elevado `lib/bitlocker-helper.ps1`

---

## Licencia

MIT
