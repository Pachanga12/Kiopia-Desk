# 🗄️ Kopia Desk

![Plataforma](https://img.shields.io/badge/plataforma-Windows-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020-339933?logo=nodedotjs&logoColor=white)
![Tests](https://img.shields.io/badge/tests-31%20passing-brightgreen?logo=nodedotjs&logoColor=white)
![Licencia](https://img.shields.io/badge/licencia-MIT-blue)
[![CI](https://img.shields.io/github/actions/workflow/status/Pachanga12/Kopia_Desk_Beta_1/ci.yml?branch=master&label=CI&logo=githubactions&logoColor=white)](https://github.com/Pachanga12/Kopia_Desk_Beta_1/actions/workflows/ci.yml)

Aplicación de escritorio para copias de seguridad incrementales en Windows. Permite respaldar carpetas como Imágenes, Documentos o Descargas a discos externos o USB.

## 🚀 Cómo ejecutar

```powershell
npm install
npm start
```

## 🧪 Tests

La lógica de escaneo, hashing, exclusiones y rutas seguras vive en `lib/core.js`
para poder testearla sin levantar Electron:

```powershell
npm test
```

## ✨ Qué hace

- Selección de carpetas origen mediante diálogo nativo de Windows, o con un
  clic desde los accesos rápidos a las carpetas típicas del usuario (Imágenes,
  Documentos, Descargas, Música, Videos, Escritorio — sólo se muestran las que
  existen en el equipo). Si dos carpetas distintas terminan con el mismo
  nombre, la segunda se renombra automáticamente (agregando la carpeta padre o
  un número) para que no compartan manifiesto ni carpeta de backup.
- Detección automática de discos/USB conectados con espacio disponible.
- Escaneo recursivo de archivos con barra de progreso.
- Filtros de exclusión configurables (por defecto ignora `Thumbs.db`, `desktop.ini`,
  `$RECYCLE.BIN`, `.git`, `node_modules`, `*.tmp`, etc.).
- Comparación incremental contra el último manifiesto guardado, usando un hash
  rápido (cabecera+cola) para no recopiar archivos que sólo cambiaron de fecha.
- Detecta archivos nuevos, cambiados y eliminados del origen. Cada categoría,
  badge y opción de la interfaz explica qué significa al pasar el mouse
  (p. ej. "eliminados" aclara que el archivo sigue guardado en el backup).
- Permite aceptar u omitir cada categoría por carpeta.
- Verificación de espacio libre en vivo: si lo seleccionado no entra en el
  destino, se muestra cuánto falta y el botón de copiar se deshabilita hasta
  que alcance (liberando espacio, cambiando de disco o desmarcando archivos).
- Copia archivos aceptados a `<disco>\KopiaDesk_Backup\<carpeta>\`, con
  concurrencia adaptada automáticamente al tipo de disco (SSD/HDD/USB). Los
  detalles técnicos (tipo de disco, concurrencia) quedan ocultos salvo que se
  active "Mostrar detalles técnicos" en Opciones.
- Deduplicación por contenido: si un archivo ya existe en el backup (aunque esté
  en otra carpeta o con otro nombre), se enlaza en vez de copiarse de nuevo.
- Versionado opcional: antes de sobrescribir un archivo cambiado en el backup,
  guarda su versión anterior comprimida con gzip en `.kopia-data\versions\<fecha>\`.
- Verificación profunda opcional con hash SHA-256 completo.
- Metadata interno oculto en `.kopia-data` (invisible al usuario).
- Journal de operaciones: detecta restos de un backup interrumpido (corte de
  luz, disco desconectado) la próxima vez que se usa ese destino, explica qué
  pasó y pide confirmación ("Continuar y limpiar" / "Ahora no") antes de
  eliminar los archivos parciales. Si se pospone y se lanza un backup nuevo,
  la limpieza se hace automáticamente antes de copiar.
- Pestaña **Comparar**: elegís qué carpetas del backup revisar y contra qué
  carpeta local, y sólo compara lo que marcaste (nada es automático); detecta
  archivos faltantes y permite restaurar sólo esos. Recuerda la carpeta local
  usada para no volver a preguntar la próxima vez. También detecta archivos
  que figuran como respaldados pero ya no están en el disco de backup (p. ej.
  borrados a mano de la copia) y ofrece quitarlos del registro para que el
  próximo backup los vuelva a copiar.
- Pestaña **Restaurar**: trae el contenido completo de una carpeta del backup
  a cualquier ubicación que elijas, sin depender de comparar contra nada —
  pensada para cuando la carpeta o el usuario original ya no existen (PC
  formateado, perfil de Windows distinto, etc.).
- Tema claro/oscuro, con selector en la barra superior (se recuerda entre sesiones).
- Persistencia de configuración entre sesiones.

> El backup **no se cifra** por ahora (se probó y no aportaba suficiente frente
> a simplemente cifrar la USB completa con BitLocker u otra herramienta a nivel
> de disco — queda pendiente para más adelante si se retoma esa idea).

## 📁 Estructura de backup en disco destino

```
D:\KopiaDesk_Backup\
├── Fotos\                    ← archivos de backup (visible)
├── Documentos\               ← archivos de backup (visible)
└── .kopia-data\              ← oculta (atributo Hidden)
    ├── manifests\            ← estado de cada carpeta
    ├── versions\             ← versiones anteriores
    └── logs\                 ← registros JSON
```

## 🧱 Stack

- Electron (proceso principal + renderer aislado con contextBridge)
- Node.js (fs, crypto, child_process)
- HTML/CSS/JS vanilla (sin frameworks)
- `node --test` para la suite de tests de `lib/core.js`

## 📦 Empaquetar como instalador

```powershell
npm run build
```

Genera un instalador NSIS en la carpeta `dist/`.
