# Seguridad: medidas, auditoría real y riesgos pendientes

Todo lo que aquí se afirma como "verificado" está cubierto por una prueba automática que **se ejecuta con `npm test`** (suite completa) — los ataques reales
están en [`tests/pentest.test.js`](../tests/pentest.test.js), [`tests/security.test.js`](../tests/security.test.js) y [`tests/hardening.test.js`](../tests/hardening.test.js).
Las pruebas corren contra nuestro propio servidor, con base de datos en memoria; no se atacó ningún servicio de terceros ni dato real.

## 1. Cómo se hizo la auditoría

| Técnica | Herramienta | Resultado |
|---|---|---|
| Dependencias conocidas vulnerables | `npm audit` (`npm run audit:deps`) | **0 vulnerabilidades** (producción y desarrollo) |
| Análisis estático | ESLint + `eslint-plugin-security` (`npm run lint:security`), 0 errores | 73 avisos (58 en el código de la aplicación, el resto en los scripts de carga), todos revisados: ~45 "object injection" (índices con claves ya validadas por zod/CHECK de la BD o claves constantes), 8 de `fs` con rutas que vienen de variables de entorno propias (no de usuarios), 4 de expresiones regulares: las de correo (`logger`, `gmail`) se acotaron (longitud máxima y comprobación previa de `@`); las otras están anclaradas y con cuantificadores acotados. **Ningún aviso representa un fallo explotable.** |
| Inyección SQL | 8 cargas (`' OR '1'='1`, `'; DROP TABLE…`, `UNION SELECT`, bytes nulos…) en **cada** campo del formulario, cada parámetro de consulta y cada ruta | Sin errores 500; los campos estructurados las rechazan (400); donde el texto libre las admite (`lugar`, `modelo`) se guardan como texto y la base queda intacta. Todo el SQL es parametrizado. |
| Operadores estilo NoSQL / tipos raros | `{"$ne":null}`, `$gt`, `$regex`, `$where`, arreglos, `__proto__`, `servicio[$ne]=1`, parámetros repetidos | 100 % rechazados con 400 (zod `strictObject`; no hay MongoDB: SQLite con consultas parametrizadas). Sin contaminación de prototipo. |
| Asignación masiva | `estado`, `precio_monto`, `id`, `codigo`, `cliente_id`, `token_hash`, `cancelada_por`… en crear y cambiar | Todos rechazados (400); el estado y el precio solo los fija el servidor. |
| Autorización horizontal (IDOR/BOLA) | Cliente B contra la reserva de A: consultar, cambiar, cancelar, ver disponibilidad, con teléfono, con token y mezclando | Siempre 404/400 sin datos de A; la respuesta es **idéntica** para código ajeno, inexistente y mal formado (no se puede enumerar). Un token de gestión no sirve para otra reserva. |
| Autorización vertical | Las 16 rutas de `/api/admin/*` × 10 variantes de credencial erróneas (sin cabecera, `Basic`, minúsculas, truncado, `x-admin-token`, cookie, secreto en la URL…) + variantes de ruta (`//`, `..`, `%2F`, mayúsculas) | **401/404 en todos los casos**; con el secreto correcto, 200. El secreto del administrador no vale en el disparador de tareas y viceversa. |
| Manipulación de estados | Cancelar por la ruta de admin, marcar "completada", reactivar una cancelada | Imposible desde el cliente (404/401/409). |
| XSS | `<script>`, `<img onerror>`, `<svg onload>` en lugar/modelo; revisión del código del panel y del sitio | La API devuelve JSON con `nosniff`; los correos escapan HTML; el panel construye el DOM con nodos de texto (prueba: ni `innerHTML`, ni `eval`, ni `document.write`). CSP sin scripts en línea. |
| CSRF / CORS / cookies / sesiones | Origen ajeno, preflight, cookies falsas | **No hay cookies ni sesiones**: la autenticación del administrador es una cabecera `Authorization` que el navegador no adjunta solo ⇒ no hay CSRF. Un origen ajeno no recibe `Access-Control-Allow-Origin`; los permitidos nunca incluyen `/api/admin`. |
| Límites de uso | Fuerza bruta de códigos, de secreto de administrador y creación masiva con límites activos | 429 tras 15 intentos fallidos de código, 5 fallos de administrador (después, incluso el secreto correcto queda bloqueado 15 min por IP) y 10 reservas/hora por IP. |
| Exposición de información | Errores forzados, rutas inexistentes, archivos estáticos (`.env`, `/server/*`, `/data/orama.db`, `..%2f`) | Sin pilas, rutas, SQL ni versiones; sin `X-Powered-By` ni `Server`; `/api/config` solo expone 7 campos públicos; `/api/listo` solo `{estado}`; ningún archivo sensible se sirve. |
| Gestión de secretos | Escaneo del repositorio (claves privadas, AWS, GitHub, asignaciones de secretos), revisión de logs y bundles | Ningún secreto en archivos versionables ni en el JS compilado ni en los logs; `.env` ignorado por git. |
| Cabeceras (modo producción) | HSTS, CSP, `frame-ancestors 'none'`, `Referrer-Policy`, `no-store` en la API | Presentes y verificadas sobre el servidor real con el sitio compilado. |

## 2. Hallazgos y correcciones

No se encontró ninguna vulnerabilidad explotable en estas pruebas (las únicas fallas de la primera corrida fueron errores de las propias pruebas, ya corregidos). Sí se hallaron y corrigieron **debilidades de diseño** durante esta fase:

1. **El resumen del propietario podía enviarse con datos viejos** (se armaba al encolarse y se enviaba horas después si Gmail fallaba). Ahora se reconstruye con la base de datos justo antes de enviarse. *(corregido, con prueba)*
2. **El secreto de administrador podía ser débil** (`ADMIN_TOKEN` ≥ 32 caracteres aunque fuera `aaaa…`). Ahora `ADMIN_TOKEN_SECRET` exige ≥ 43 caracteres con variedad mínima, se compara por SHA-256 en tiempo constante, soporta rotación sin caída (`ADMIN_TOKEN_SECRET_PREVIOUS`) y hay un generador criptográfico (`npm run gen:admin-token`). *(corregido)*
3. **La limpieza podía borrar según una política de días, sin protección contra relojes erróneos o cálculos defectuosos.** Ahora: corte semanal, doble guarda en SQL, transacción con verificación de conteo, aborto por reloj sospechoso y por tope, y confirmación explícita en la manual. *(corregido, con prueba de propiedad sobre 1.000 reservas aleatorias)*
4. **Mensajes de error con datos en el registro**: el logger recorta cadenas a 2.000 caracteres y oculta correos incrustados. *(corregido)*
5. **Panel del propietario con contraseña propia** (hash scrypt, sesión firmada de 8 horas en cabecera, sin cookies ⇒ sin CSRF; 5 intentos fallidos por IP y 40 por hora en total; cambiar la contraseña cierra las sesiones). Verificado con pruebas.

## 3. Riesgos pendientes (no se ocultan)

| Riesgo | Por qué sigue | Mitigación actual / decisión del dueño |
|---|---|---|
| **Reservas hechas con el correo o teléfono de un tercero** (spam con la marca, nombre del cliente sobrescrito) | Verificar el correo antes de confirmar cambiaría el flujo pedido. | Tope de 20 correos/día por dirección, 10 reservas/hora por IP, máx. 3 activas por teléfono/correo. Opción: verificación por correo o Cloudflare Turnstile. |
| **Bloqueo del administrador por fuerza bruta intencional** | Los límites son por IP. | Bloqueo de 15 min; el secreto de 256 bits no es adivinable. Detrás de un proxy mal configurado (`TRUST_PROXY=0`) todos comparten IP: el servidor lo avisa al arrancar. |
| **Enumeración parcial**: un intento de reservar revela si un teléfono/correo ya tiene 3 reservas activas (`LIMITE_DE_RESERVAS`) | Es necesario para el límite. | Impacto bajo (no revela datos). |
| **Límites de uso en memoria** | Una sola instancia; se reinician con el proceso. | Aceptable a esta escala. |
| **Sin rotación de la clave de cifrado de datos** (`DATA_ENCRYPTION_KEY`) ni identificador de clave | Complejidad innecesaria hoy. | Procedimiento manual descrito en OPERACION. |
| **Envío real por Gmail no verificado** | Faltan credenciales. | Probado con un transporte simulado; hay que hacer una reserva real tras configurar Gmail. |
| **Dockerfile / fly.toml no ejecutados** | Docker apagado y sin cuenta de Fly. | Documentado; revisar en el primer despliegue. |

## 4. Medidas que se mantienen desde la fase anterior

Datos personales cifrados en reposo (AES-256-GCM) con huellas HMAC para verificar y limitar sin descifrar; token de gestión de 192 bits (solo su SHA-256 en la BD, viaja en el `#` del enlace);
casilleros únicos `(fecha, slot)` dentro de transacciones `BEGIN IMMEDIATE` (probado con 8 procesos y con 200 solicitudes simultáneas); `Idempotency-Key` obligatoria; cola de correos (outbox) con reintentos;
migraciones con checksum y copia previa; respaldo diario verificado; CSP/HSTS/`nosniff`; errores genéricos; logger que oculta datos personales; canario de la clave de cifrado al arrancar.

## 5. Decisión sobre el acceso administrativo (actualizada)

El propietario inicia sesión con **contraseña propia** en `/admin.html` (un solo administrador: no se justifican roles ni usuarios múltiples). La sesión es un token firmado con vencimiento que se guarda solo en la pestaña (`sessionStorage`); el secreto largo `ADMIN_TOKEN_SECRET` queda para automatizaciones. Riesgo residual: un `XSS` robaría la sesión de 8 h; mitigado por la CSP sin scripts en línea y porque el panel solo escribe texto en la página. Texto anterior:

Hay **un solo administrador** (el propietario) y, por decisión suya, **no hay panel web**. Con un único usuario, un sistema de cuentas con contraseñas y roles añadiría superficie de ataque (formularios de acceso, recuperación de contraseña, sesiones) sin ningún beneficio; por eso la API opcional usa un secreto de 256 bits por cabecera, apagado por defecto. Si algún día hubiera empleados con permisos distintos, lo correcto sería pasar a usuarios con roles (no ampliar este secreto). Estado del secreto: no existe en el repositorio ni en el frontend; se valida su fortaleza al arrancar; rotación documentada; no hace falta rotarlo hoy porque nunca se ha usado fuera de pruebas locales.
