# Desplegar gratis en Oracle Cloud (Always Free) — paso a paso

> **Estado:** guía y script **preparados pero no ejecutados** (no puedo crear la cuenta ni la VM por ti, y no hay una VM de Linux aquí para probar). `bash -n` valida la sintaxis del script; el resto se comprobará en el primer despliegue. Los nombres de los botones de la consola de Oracle pueden variar.
> Con ≤ 20 personas simultáneas la capacidad no es problema (la app usa ~80–200 MB de RAM y se midió ~1.000 solicitudes/s en un núcleo rápido). El riesgo de este plan es **operativo**, ver `INFRAESTRUCTURA.md` §4.

## 1. Lo que tú haces en Oracle (≈ 20 min)

1. Crea la cuenta en <https://www.oracle.com/cloud/free/> (pide tarjeta solo para verificar identidad; elige una región cercana, p. ej. la de EE. UU. más próxima). Con la cuenta del negocio.
2. **Compute → Instances → Create instance**:
   - Imagen: **Ubuntu 24.04** (o 22.04).
   - Shape: **VM.Standard.E2.1.Micro** (la que dice "Always Free-eligible", AMD, 1 GB). Si hay una Ampere A1 gratuita disponible también sirve.
   - Descarga la **clave SSH privada** que te ofrece y guárdala (`orama.key`). Sin ella no podrás entrar.
3. **Networking → IP reservada**: crea una **Reserved Public IP** (gratis) y asígnala a la VM, para que la IP no cambie.
4. **Red → tu VCN → Security Lists → Ingress Rules**: agrega reglas TCP para los puertos **80** y **443** desde `0.0.0.0/0`.
5. Dominio gratis: en <https://www.duckdns.org> crea un subdominio (por ejemplo `orama-detailing.duckdns.org`) y apúntalo a la IP reservada. *(Servicio de terceros; no lo he verificado. Si prefieres un dominio propio, apunta su registro A a esa IP.)*

## 2. Preparar la VM (una vez)

Desde tu PC (PowerShell), con la clave descargada:
```powershell
scp -i .\orama.key deploy\oracle-setup.sh ubuntu@IP_RESERVADA:~
ssh -i .\orama.key ubuntu@IP_RESERVADA "sudo bash oracle-setup.sh orama-detailing.duckdns.org"
```
El script instala Node 22 y Caddy (HTTPS automático), abre el firewall, crea el servicio `orama` y **genera** `DATA_ENCRYPTION_KEY` en `/etc/orama/orama.env`. **Guarda esa clave** (el script te dice cómo verla).

Luego escribe la contraseña de Gmail en el servidor (tú, nadie más la ve):
```bash
ssh -i orama.key ubuntu@IP_RESERVADA
sudo nano /etc/orama/orama.env     # completa GMAIL_APP_PASSWORD=las16letras (sin espacios)
```

## 3. Subir la app

En tu PC, en la carpeta del proyecto:
```powershell
npm run build
tar czf orama.tgz dist server shared scripts package.json package-lock.json
scp -i .\orama.key orama.tgz ubuntu@IP_RESERVADA:~
ssh -i .\orama.key ubuntu@IP_RESERVADA "sudo tar xzf orama.tgz -C /opt/orama && sudo chown -R orama:orama /opt/orama && cd /opt/orama && sudo -u orama npm ci --omit=dev && sudo systemctl restart orama"
```

## 4. Comprobar

```powershell
curl https://orama-detailing.duckdns.org/api/salud        # {"ok":true}
curl https://orama-detailing.duckdns.org/api/listo        # {"estado":"ok"}
ssh -i .\orama.key ubuntu@IP_RESERVADA "sudo journalctl -u orama -n 30 --no-pager"
```
Después abre el sitio, haz una reserva con tu correo y confirma que el correo llega y que sus enlaces abren `https://…` (ya no `localhost`).

## 5. Después de desplegar

- **Actualizar la app:** repite el paso 3 (migraciones automáticas con copia previa).
- **Respaldos fuera del servidor (importante en este plan):** el sistema guarda un respaldo diario en `/var/lib/orama/backups`. Cada semana descarga la carpeta a tu PC:
  `scp -i .\orama.key -r ubuntu@IP_RESERVADA:/var/lib/orama/backups .\respaldos\` (el sudo no hace falta si antes das permiso de lectura; si falla, usa `ssh … "sudo tar czf - /var/lib/orama/backups" > respaldos.tgz`).
- **Si Oracle suspende o borra la VM:** crea otra, repite los pasos 2–3 y restaura el último respaldo (`DESPLIEGUE.md` §7) **con la misma `DATA_ENCRYPTION_KEY`**.
- **Mantenimiento:** `sudo apt update && sudo apt upgrade` una vez al mes y reiniciar.
- **Monitoreo:** un chequeo gratuito de `https://tu-dominio/api/listo` cada 5 minutos con aviso por correo.
- El flujo de GitHub Actions es opcional (necesita subir el código al repositorio y definir secretos); el cron interno ya cubre el resumen y la limpieza.
