# Orama’s Detailing

Sitio de una sola página con **sistema de reservas real** para **Orama’s Detailing** (Aguada, P.R.).

- **Frontend:** Vite + Tailwind CSS v4 + JavaScript (módulos) + Three.js.
- **Backend:** Node ≥ 22.13 + Express 5 + SQLite (`node:sqlite`) + Gmail (nodemailer) + tareas programadas (node-cron).
  Capas: `controllers → services → repositories`, con `validation`, `config`, `integrations`, `jobs` y `emails` separados.

## Cómo correrlo

```bash
npm install
npm run gen:key  # genera DATA_ENCRYPTION_KEY → ponla en .env (copia .env.example)
npm run dev      # API en :3000 + página en http://localhost:5173
npm test         # pruebas automáticas (concurrencia real entre procesos, limpieza, calendario, auditoría de seguridad)
npm run lint:security   # análisis estático de seguridad · npm run audit:deps → vulnerabilidades de dependencias
node scripts/load/run.mjs D   # pruebas de carga (escenarios A–E) contra un servidor de prueba local
npm run build    # versión final en /dist
npm start        # producción: un solo proceso sirve la página y la API
```

Documentación: [API](docs/API.md) · [Operación](docs/OPERACION.md) · [Despliegue y recuperación](docs/DESPLIEGUE.md) ·
[Infraestructura y costos](docs/INFRAESTRUCTURA.md) · [Políticas de negocio](docs/POLITICAS.md) · [Seguridad](docs/SEGURIDAD.md) · [Pruebas de carga](docs/carga/RESULTADOS.md).
Panel del propietario: `/admin.html` (sin enlaces desde el sitio). Se entra con una contraseña propia (`npm run admin:password -- --generar`, en el servidor) y permite ver la agenda, cambiar el horario, definir el almuerzo o bloquear horas, cerrar días y apagar servicios.

## Estructura

```
index.html                  Esqueleto: ensambla los parciales
public/                     Archivos estáticos
  fotos/                    Fotos reales optimizadas (.webp, versión -sm para celular)
  models/                   Modelo 3D del carro (car.glb)
  video/                    Video de la portada: hero-lg.mp4 (computadora), hero.mp4 (celular) y sus imágenes inicial y final
src/
  partials/                 Una sección por archivo HTML
    header · hero · servicios · showroom · como-funciona · reservar
    mi-reserva · galeria · ubicacion · faq · footer
  styles/
    main.css                Entrada: Tailwind + imports
    theme.css               Tokens (@theme): colores, fuentes, tamaños
    base.css                Reset, superficies oscuras/claras, utilidades de sección
    components/             buttons · header · cards · forms · booking · effects
    sections/               hero · steps · compare · location · faq
  scripts/
    main.js                 Arranca todos los módulos
    api/client.js           Cliente de la API (fetch, errores, Idempotency-Key)
    data/services.js        Reexporta shared/catalog.js (precios "desde", servicios, duraciones, reglas)
    data/gallery.js         Lista de fotos de la galería
    utils/                  dom.js (helpers) · time.js (hora de Puerto Rico)
    modules/                menu · reveal · parallax · tilt · bubbles
                            pricing · booking · lookup · compare
                            car3d · car-model (carga public/models/car.glb)
```

## Diseño

Dirección de arte **"Luz de showroom"**: lienzo hueso cálido y tinta casi negra, capítulos oscuros solo donde hay impacto
(portada, showroom 3D, galería y pie), un único acento rojo `#C4161C`, titulares en Geist con palabras clave en
Instrument Serif cursiva, esquinas redondeadas coherentes y sombras suaves. Tokens en `src/styles/theme.css`;
las superficies claras/oscuras se cambian con `.surface-light | .surface-sand | .surface-dark | .surface-black`.

## Créditos

Modelo 3D del carro: “Car Concept” de Eric Chadwick / Darmstadt Graphics Group, licencia CC BY 4.0
(ver `public/models/LICENSE.md`). El crédito también aparece en el pie de página; no lo quites.

## Reglas de la agenda (fuente única: `shared/catalog.js`, usada por el servidor y la página)

- 8:00 a.m. – 5:00 p.m. (hora de Puerto Rico, `America/Puerto_Rico`). Días de operación y festivos: configurables desde el panel (por defecto miércoles a domingo).
- Un carro a la vez: el servicio #1 bloquea 2 h y el #2 bloquea 3 h.
- Última hora de inicio: 3:30 p.m. (#1) y 2:30 p.m. (#2).
- Se agenda desde el día siguiente; la agenda se cierra de 11:00 p.m. a 6:00 a.m.
- Cambiar o cancelar hasta 1 hora antes.

## Pendientes

- **Configuración manual** (nada se inventa): `GMAIL_USER` + `GMAIL_APP_PASSWORD`, `OWNER_EMAIL`, `DATA_ENCRYPTION_KEY`,
  `PUBLIC_BASE_URL` (https) y `ADMIN_TOKEN_SECRET`. Ver [docs/OPERACION.md](docs/OPERACION.md).
- **Antes y después:** el comparador está oculto hasta que pongas dos fotos en `modules/compare.js` (`PHOTOS`).
- **Más fotos:** agrega los .webp a `public/fotos/` y súmalos en `partials/galeria.html` y `modules/gallery.js`.
- **Logo:** reemplazar el texto del logo por el SVG/PNG en alta calidad.
