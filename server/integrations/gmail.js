import nodemailer from 'nodemailer';

/**
 * Integración con Gmail (SMTP vía nodemailer). Aislada del resto: el sistema de reservas no sabe cómo se envía un correo.
 * Credenciales SOLO por variables de entorno. Con `transport` inyectable para pruebas.
 *
 * Importante: si no hay credenciales, `configured` es false y NO se finge ningún envío:
 * los correos se quedan en la cola (outbox) hasta que se configure Gmail.
 */
export function createMailer({ env, log, transport }) {
  let tx = transport ?? null;
  const timeouts = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

  if (!tx) {
    if (env.gmailMode === 'app-password') {
      tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, ...timeouts, auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD } });
    } else if (env.gmailMode === 'oauth2') {
      tx = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true, ...timeouts,
        auth: { type: 'OAuth2', user: env.GMAIL_USER, clientId: env.GMAIL_OAUTH_CLIENT_ID, clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET, refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN },
      });
    }
  }

  const from = env.GMAIL_USER ? { name: env.GMAIL_FROM_NAME, address: env.GMAIL_USER } : null;
  const domain = env.GMAIL_USER?.split('@')[1] ?? 'orama.local';

  return {
    configured: Boolean(tx && from),
    mode: transport ? 'inyectado' : env.gmailMode,

    /** Envía un correo. Lanza si falla; quien llama decide si reintenta. */
    async send({ to, subject, text, html, outboxId }) {
      if (!tx || !from) throw Object.assign(new Error('Gmail no está configurado'), { code: 'NO_CONFIGURADO' });
      const info = await tx.sendMail({
        from, to, subject, text, html,
        // Mismo Message-ID para la misma fila del outbox: si un reintento duplica un envío, es identificable
        messageId: `<orama-${outboxId}@${domain}>`,
        headers: { 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
      });
      const accepted = (info.accepted ?? []).map(String);
      if (info.accepted && !accepted.length) throw Object.assign(new Error('El servidor rechazó al destinatario'), { code: 'EENVELOPE', responseCode: 550 });
      return { messageId: info.messageId };
    },

    /** Comprueba la conexión y las credenciales sin enviar nada. */
    async verify() {
      if (!tx?.verify) return { ok: false, motivo: 'no_configurado' };
      try { await tx.verify(); return { ok: true }; } catch (err) { return { ok: false, motivo: classifyError(err) }; }
    },

    log,
  };
}

/** 'auth' = credenciales rechazadas (no es culpa del mensaje); 'permanent' = el mensaje nunca saldrá; 'quota' = límite/cuota de Gmail (se pausa el envío y se reintenta más tarde); 'transient' = reintentar. */
export function classifyError(err) {
  const code = err?.code, rc = err?.responseCode;
  if (code === 'EAUTH' || rc === 535 || rc === 534) return 'auth';
  if (code === 'NO_CONFIGURADO') return 'auth';
  const text = String(err?.message ?? '');
  // Cuota diaria superada, límite de velocidad o bloqueo temporal por spam: NO es un mensaje malo, se reintenta más tarde
  if (/quota|rate limit|too many|try again|temporar|5\.4\.5|5\.7\.[01]/i.test(text) || [421, 450, 451, 452, 454].includes(rc)) return 'quota';
  if (code === 'EENVELOPE' || (rc >= 500 && rc < 600 && rc !== 552 && rc !== 554)) return 'permanent';
  return 'transient';
}

/** Mensaje de error seguro para guardar y registrar: sin direcciones de correo ni credenciales. */
export function sanitizeError(err, env) {
  let msg = `${err?.code ?? err?.name ?? 'Error'}${err?.responseCode ? ' ' + err.responseCode : ''}: ${String(err?.message ?? '').split('\n')[0]}`;
  msg = msg.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[correo]');
  for (const secret of [env.GMAIL_APP_PASSWORD, env.GMAIL_OAUTH_CLIENT_SECRET, env.GMAIL_OAUTH_REFRESH_TOKEN]) {
    if (secret) msg = msg.split(secret).join('[secreto]');
  }
  return msg.slice(0, 240);
}
