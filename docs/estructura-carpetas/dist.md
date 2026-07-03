# Carpeta `dist/`

No se edita a mano: la genera `electron-builder` al ejecutar `npm run build`.
Contiene el instalador final para repartir la app:

```
dist/
├── Kopia Desk Setup 1.0.0.exe       ← instalador NSIS (esto es lo que se comparte)
├── Kopia Desk Setup 1.0.0.exe.blockmap
├── builder-debug.yml                 ← log de la última compilación
├── latest.yml                        ← metadata para auto-actualización (si se usara)
└── win-unpacked/                     ← la app ya compilada sin empaquetar en instalador
```

Si algo sale mal al compilar (por ejemplo, error de `winCodeSign`), la solución
está anotada en `docs/arquitectura.md`, sección "Notas de desarrollo". Esta
carpeta puede borrarse y regenerarse en cualquier momento con `npm run build`;
no guarda nada que no se pueda volver a generar.
