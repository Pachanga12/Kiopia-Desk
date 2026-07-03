# Carpeta `docs/`

Documentación del proyecto, pensada para quien retome el código más adelante.

```
docs/
├── arquitectura.md          ← Mapa técnico: tabla completa de canales IPC,
│                               seguridad (path traversal, journal, dedup),
│                               y el flujo de backup paso a paso.
└── estructura-carpetas/     ← Esta guía: un archivo por carpeta del proyecto,
    ├── README.md              explicado en términos de "qué hace" y "por dónde
    ├── raiz.md                empezar a leer", en vez de listar cada función.
    ├── renderer.md
    ├── assets.md
    ├── dist.md
    ├── docs.md               (este archivo)
    └── node_modules.md
```

**¿Cuándo usar cuál?** Si necesitás el detalle exacto de un canal IPC o cómo
está protegida una operación, `arquitectura.md`. Si estás llegando al proyecto
por primera vez o volviendo después de meses y necesitás orientarte, empezar
por `estructura-carpetas/README.md`.
