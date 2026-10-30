/**
 * Plantillas de correo. Reciben los datos ya armados (payload del outbox) y devuelven { subject, text, html }.
 * Todo texto dinámico (nombre, lugar…) lo escribe el cliente: se ESCAPA antes de ir al HTML,
 * y el asunto se limpia de saltos de línea (evita inyección de cabeceras).
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

const C = { ink: '#0f0f11', bone: '#f4f2ee', card: '#ffffff', muted: '#6b6963', line: '#e3e0d9', red: '#c4161c', dark: '#0b0b0c' };

function button(href, label, primary = true) {
  const bg = primary ? C.red : 'transparent', color = primary ? '#ffffff' : C.ink, border = primary ? C.red : C.ink;
  return `<a href="${esc(href)}" style="display:inline-block;padding:13px 24px;border-radius:999px;background:${bg};color:${color};border:1px solid ${border};font-weight:600;font-size:15px;text-decoration:none">${esc(label)}</a>`;
}

function layout({ preheader, title, bodyHtml, empresa }) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bone};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bone};padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border-radius:20px;overflow:hidden;border:1px solid ${C.line}">
    <tr><td style="background:${C.dark};padding:26px 32px">
      <div style="font-size:22px;font-weight:700;letter-spacing:-.02em;color:#ffffff">Orama’s <span style="font-style:italic;font-weight:400;font-family:Georgia,serif;color:#ef6a6e">Detailing</span></div>
      <div style="font-size:10px;letter-spacing:.3em;color:#a09f9a;margin-top:4px;text-transform:uppercase">Powder Coating · Aguada, P.R.</div>
    </td></tr>
    <tr><td style="padding:32px">${bodyHtml}</td></tr>
    <tr><td style="background:${C.bone};padding:22px 32px;font-size:13px;line-height:1.6;color:${C.muted};border-top:1px solid ${C.line}">
      <strong style="color:${C.ink}">Orama’s Detailing</strong> · Aguada, Puerto Rico<br>
      Teléfono / WhatsApp: <a href="${esc(empresa.whatsappUrl)}" style="color:${C.red}">${esc(empresa.telefono)}</a> · Instagram: ${esc(empresa.instagram)}<br>
      Miércoles a domingo, 8:00 a.m. – 5:00 p.m.
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function detailsTable(rows) {
  const tr = rows.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.line};color:${C.muted};font-size:13px;text-transform:uppercase;letter-spacing:.08em;width:38%">${esc(k)}</td><td style="padding:10px 0;border-bottom:1px solid ${C.line};font-size:16px;font-weight:600">${esc(v)}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0">${tr}</table>`;
}

const textRows = (rows) => rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
const h1 = (t) => `<h1 style="margin:0 0 8px;font-size:28px;line-height:1.1;letter-spacing:-.03em">${esc(t)}</h1>`;
const p = (t) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#2a2a2d">${t}</p>`;
const footerText = (d) => `\n—\nOrama’s Detailing · Aguada, P.R.\nTeléfono / WhatsApp: ${d.empresa.telefono} (${d.empresa.whatsappUrl})\nInstagram: ${d.empresa.instagram}\nMiércoles a domingo, 8:00 a.m. – 5:00 p.m.\n`;

const detailRows = (d) => [
  ['Servicio', d.servicio], ['Vehículo', d.vehiculo], ['Día', d.dia[0].toUpperCase() + d.dia.slice(1)], ['Fecha', d.fechaLarga],
  ['Hora de inicio', d.inicio], ['Hora de finalización', d.fin], ['Lugar del servicio', d.lugar], ['Precio', d.precio],
];

/* ───────── cliente ───────── */

function confirmacion(d) {
  const cutoff = d.empresa.cutoffMin;
  const subject = oneLine(`Reserva confirmada ${d.codigo} · ${d.fechaLarga}, ${d.inicio}`);
  const html = layout({
    preheader: `Tu número de reserva es ${d.codigo}. ${d.fechaLarga}, ${d.inicio}.`, title: subject, empresa: d.empresa,
    bodyHtml:
      h1('¡Tu cita está confirmada!') +
      p(`Hola ${esc(d.nombre)}, reservamos tu espacio. Guarda este número: lo necesitas para consultar, cambiar o cancelar tu cita.`) +
      `<div style="background:${C.bone};border-radius:16px;padding:18px;text-align:center;margin:20px 0"><div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:${C.muted}">Número de reserva</div><div style="font-size:38px;font-weight:700;letter-spacing:.06em;color:${C.red};margin-top:4px">${esc(d.codigo)}</div></div>` +
      detailsTable(detailRows(d)) +
      `<h2 style="margin:28px 0 10px;font-size:20px;letter-spacing:-.02em">Cómo gestionar tu reserva</h2>` +
      p(`<strong>1. Consultar:</strong> abre tu reserva con el botón de abajo, o entra a nuestra página, sección “Mi reserva”, e ingresa tu número de reserva y tu celular.`) +
      p(`<strong>2. Cancelar:</strong> desde el mismo enlace puedes cancelar hasta ${cutoff} minutos antes de la hora de inicio. El horario queda libre automáticamente.`) +
      p(`<strong>3. Cambiar fecha u hora:</strong> desde el mismo enlace eliges otro día u hora disponible, hasta ${cutoff} minutos antes de la cita. Si el nuevo horario no está libre, tu cita original se mantiene.`) +
      `<div style="margin:22px 0 8px">${button(d.gestionUrl, 'Consultar, cambiar o cancelar')}</div>` +
      p(`Pasado ese plazo, o si necesitas ayuda, escríbenos por <a href="${esc(d.empresa.whatsappUrl)}" style="color:${C.red}">WhatsApp</a>.`) +
      `<p style="margin:18px 0 0;font-size:13px;color:${C.muted}">Este enlace es personal: no lo compartas. Si no hiciste esta reserva, ignora este mensaje o escríbenos.</p>`,
  });
  const text =
    `¡Tu cita está confirmada!\n\nHola ${d.nombre}, reservamos tu espacio.\n\nNÚMERO DE RESERVA: ${d.codigo}\n\n${textRows(detailRows(d))}\n\n` +
    `CÓMO GESTIONAR TU RESERVA\n1. Consultar: ${d.gestionUrl}\n   (o en nuestra página, sección “Mi reserva”, con tu número de reserva y tu celular)\n` +
    `2. Cancelar: desde el mismo enlace, hasta ${cutoff} minutos antes de la cita.\n` +
    `3. Cambiar fecha u hora: desde el mismo enlace, hasta ${cutoff} minutos antes de la cita.\n` +
    `Pasado ese plazo o si necesitas ayuda, escríbenos por WhatsApp: ${d.empresa.whatsappUrl}\n` + footerText(d);
  return { subject, text, html };
}

function cambio(d) {
  const subject = oneLine(`Cita cambiada ${d.codigo} · ${d.fechaLarga}, ${d.inicio}`);
  const html = layout({
    preheader: `Tu cita ${d.codigo} ahora es el ${d.fechaLarga}, ${d.inicio}.`, title: subject, empresa: d.empresa,
    bodyHtml:
      h1('Cambiamos tu cita') +
      p(`Hola ${esc(d.nombre)}, tu cita <strong>${esc(d.codigo)}</strong> tiene un nuevo horario.`) +
      `<p style="margin:0 0 6px;color:${C.muted};font-size:14px;text-decoration:line-through">Antes: ${esc(d.antes.fechaLarga)}, ${esc(d.antes.inicio)} – ${esc(d.antes.fin)}</p>` +
      detailsTable(detailRows(d)) +
      `<div style="margin:22px 0 8px">${button(d.consultaUrl, 'Ver mi reserva', false)}</div>` +
      p(`Para otro cambio o para cancelar, entra a “Mi reserva” con tu número y tu celular. Si no fuiste tú, escríbenos por <a href="${esc(d.empresa.whatsappUrl)}" style="color:${C.red}">WhatsApp</a>.`),
  });
  const text = `Cambiamos tu cita ${d.codigo}\n\nAntes: ${d.antes.fechaLarga}, ${d.antes.inicio} – ${d.antes.fin}\n\n${textRows(detailRows(d))}\n\nVer mi reserva: ${d.consultaUrl}\nSi no fuiste tú, escríbenos por WhatsApp: ${d.empresa.whatsappUrl}\n` + footerText(d);
  return { subject, text, html };
}

function cancelacion(d) {
  const subject = oneLine(`Cita cancelada ${d.codigo}`);
  const quien = d.por === 'dueno' ? 'Cancelamos tu cita (lo acordamos contigo).' : 'Recibimos tu cancelación. El horario quedó libre.';
  const html = layout({
    preheader: `La cita ${d.codigo} fue cancelada.`, title: subject, empresa: d.empresa,
    bodyHtml:
      h1('Cita cancelada') + p(`Hola ${esc(d.nombre)}. ${esc(quien)}`) +
      detailsTable([['Número de reserva', d.codigo], ['Servicio', d.servicio], ['Fecha', d.fechaLarga], ['Hora', `${d.inicio} – ${d.fin}`]]) +
      p(`Cuando quieras, agenda de nuevo en nuestra página. Para cualquier duda escríbenos por <a href="${esc(d.empresa.whatsappUrl)}" style="color:${C.red}">WhatsApp</a>.`),
  });
  const text = `Cita cancelada\n\nHola ${d.nombre}. ${quien}\n\n${textRows([['Número de reserva', d.codigo], ['Servicio', d.servicio], ['Fecha', d.fechaLarga], ['Hora', `${d.inicio} – ${d.fin}`]])}\n\nPuedes agendar de nuevo en nuestra página o escribirnos por WhatsApp: ${d.empresa.whatsappUrl}\n` + footerText(d);
  return { subject, text, html };
}

/* ───────── dueño (texto plano, como pidió) ───────── */

/** Aviso al propietario cuando un cliente cambia o cancela (ya confirmado por correo). Diseño igual al de los correos a clientes. */
function avisoDueno(d) {
  const cancelo = !d.ahora;
  const subject = oneLine(`${cancelo ? 'Cita cancelada' : 'Cita cambiada'} por el cliente · ${d.nombre} · ${d.codigo}`);
  const rows = [['Cliente', d.nombre], ['Teléfono', d.telefono], ['Lugar', d.lugar], ['Número de reserva', d.codigo], ['Servicio', `${d.servicio}${d.vehiculo ? ` (${d.vehiculo})` : ''}`], [cancelo ? 'Horario que tenía' : 'Horario anterior', d.antes], ...(cancelo ? [] : [['Horario nuevo', d.ahora]])];
  const tel = String(d.telefono ?? '').replace(/[^\d+]/g, '');
  const html = layout({
    preheader: `${d.nombre} ${d.accion}. ${d.antes}.`, title: subject, empresa: d.empresa,
    bodyHtml:
      `<div style="display:inline-block;padding:6px 14px;border-radius:999px;background:${cancelo ? '#fdecec' : '#fff6e0'};color:${cancelo ? C.red : '#8a5a00'};font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:14px">${cancelo ? 'Cancelación' : 'Cambio de horario'}</div>` +
      h1(cancelo ? 'Un cliente canceló su cita' : 'Un cliente cambió su cita') +
      p(`<strong>${esc(d.nombre)}</strong> ${esc(d.accion)} desde la página${cancelo ? '.' : '; el nuevo horario ya está ocupado y el anterior quedó libre.'}`) +
      detailsTable(rows) +
      (cancelo ? `<div style="background:${C.bone};border-radius:14px;padding:14px 18px;font-size:15px;color:#2a2a2d">El horario quedó <strong>libre</strong> y ya aparece disponible para otros clientes.</div>` : '') +
      (tel ? `<div style="margin:22px 0 4px">${button(`tel:${tel}`, 'Llamar al cliente', false)}</div>` : ''),
  });
  const text = [`AVISO: un cliente ${d.accion}`, '', `Nombre: ${d.nombre}`, `Teléfono: ${d.telefono}`, `Lugar: ${d.lugar}`, `Número de reserva: ${d.codigo}`, `Servicio: ${d.servicio}`,
    `Horario anterior: ${d.antes}`, d.ahora ? `Horario nuevo: ${d.ahora}` : 'La cita quedó cancelada y el horario está libre.'].join('\n') + '\n';
  return { subject, text, html };
}

function resumenDueno(d) {
  const subject = oneLine(`Reservas programadas para mañana · ${d.fechaLarga}`);
  // El texto del resumen (summary.service) se lee por bloques "CLIENTE n" y se dibuja como tarjetas
  const fecha = /^Fecha: (.*)$/m.exec(d.texto)?.[1] || d.fechaLarga;
  const total = /^Total: (\d+)/m.exec(d.texto)?.[1];
  const cards = d.texto.split(/^CLIENTE \d+\s*$/m).slice(1).map((blk, i) => {
    const f = {};
    for (const line of blk.split('\n')) { const m = /^([^:]+): (.*)$/.exec(line); if (m) f[m[1]] = m[2]; }
    const tel = String(f['Teléfono'] || '').replace(/[^\d+]/g, '');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border:1px solid ${C.line};border-radius:16px;overflow:hidden">
<tr><td style="background:${C.bone};padding:12px 18px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${C.muted}"><strong style="color:${C.red}">${esc(f['Horario'])}</strong></td><td align="right" style="background:${C.bone};padding:12px 18px;font-size:12px;letter-spacing:.08em;color:${C.muted}">CLIENTE ${i + 1}</td></tr>
<tr><td colspan="2" style="padding:16px 18px"><div style="font-size:19px;font-weight:700;letter-spacing:-.01em">${esc(f['Nombre'])}</div>
<div style="font-size:14px;color:${C.muted};margin:2px 0 12px">${esc(f['Servicio'])} · Reserva ${esc(f['Número de reserva'])}</div>
<div style="font-size:15px;line-height:1.7">📍 ${esc(f['Lugar'])}<br>📞 ${tel ? `<a href="tel:${esc(tel)}" style="color:${C.ink};font-weight:600">${esc(f['Teléfono'])}</a>` : esc(f['Teléfono'])}</div></td></tr></table>`;
  }).join('');
  const html = layout({
    preheader: total ? `${total} ${total === '1' ? 'reserva' : 'reservas'} para ${fecha}.` : `Sin reservas para ${fecha}.`, title: subject, empresa: d.empresa,
    bodyHtml:
      `<div style="display:inline-block;padding:5px 12px;border-radius:999px;background:${C.bone};font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:${C.muted};margin-bottom:12px">Resumen del día siguiente</div>` +
      h1(fecha[0].toUpperCase() + fecha.slice(1)) +
      p(total ? `<strong>${esc(total)}</strong> ${total === '1' ? 'reserva programada' : 'reservas programadas'}, en orden de hora.` : 'No hay reservas confirmadas para esta fecha.') +
      cards +
      `<p style="margin:18px 0 0;font-size:12px;color:${C.muted}">${esc(/^Estado al momento de generar: (.*)$/m.exec(d.texto)?.[1] ? 'Estado al momento de generar: ' + /^Estado al momento de generar: (.*)$/m.exec(d.texto)[1] : '')}</p>`,
  });
  return { subject, text: d.texto, html };
}

/* ───────── segunda verificación (cancelar / cambiar) ───────── */

function confirmarCancelacion(d) {
  const subject = oneLine(`Confirma la cancelación de tu cita ${d.codigo}`);
  const html = layout({
    preheader: `Falta un paso: confirma que quieres cancelar la cita ${d.codigo}.`, title: subject, empresa: d.empresa,
    bodyHtml:
      h1('Confirma la cancelación') +
      p(`Hola ${esc(d.nombre)}, recibimos una solicitud para <strong>cancelar</strong> tu cita <strong>${esc(d.codigo)}</strong>. <strong>Tu cita sigue activa</strong> hasta que confirmes.`) +
      detailsTable([['Número de reserva', d.codigo], ['Servicio', d.servicio], ['Fecha', d.fechaLarga], ['Hora', `${d.inicio} – ${d.fin}`]]) +
      `<div style="margin:22px 0 8px">${button(d.confirmUrl, 'Sí, cancelar mi cita')}</div>` +
      p(`Este enlace se puede usar una sola vez y vence en ${esc(d.expira)}.`) +
      `<p style="margin:18px 0 0;font-size:13px;color:${C.muted}"><strong>¿No fuiste tú?</strong> Ignora este mensaje: no se cancelará nada. Si tienes dudas, escríbenos por <a href="${esc(d.empresa.whatsappUrl)}" style="color:${C.red}">WhatsApp</a>.</p>`,
  });
  const text = `Confirma la cancelación de tu cita ${d.codigo}\n\nHola ${d.nombre}, recibimos una solicitud para CANCELAR tu cita. Tu cita sigue activa hasta que confirmes.\n\n${textRows([['Número de reserva', d.codigo], ['Servicio', d.servicio], ['Fecha', d.fechaLarga], ['Hora', `${d.inicio} – ${d.fin}`]])}\n\nPara cancelar, abre este enlace (se usa una sola vez y vence en ${d.expira}):\n${d.confirmUrl}\n\n¿No fuiste tú? Ignora este mensaje: no se cancelará nada. Dudas por WhatsApp: ${d.empresa.whatsappUrl}\n` + footerText(d);
  return { subject, text, html };
}

function confirmarCambio(d) {
  const subject = oneLine(`Confirma el cambio de tu cita ${d.codigo}`);
  const nuevo = [['Nueva fecha', d.nueva.fechaLarga], ['Nueva hora', `${d.nueva.inicio} – ${d.nueva.fin}`]];
  const antes = [['Fecha actual', d.fechaLarga], ['Hora actual', `${d.inicio} – ${d.fin}`]];
  const html = layout({
    preheader: `Falta un paso: confirma el nuevo horario de la cita ${d.codigo}.`, title: subject, empresa: d.empresa,
    bodyHtml:
      h1('Confirma el cambio de tu cita') +
      p(`Hola ${esc(d.nombre)}, recibimos una solicitud para <strong>cambiar</strong> tu cita <strong>${esc(d.codigo)}</strong>. <strong>Tu cita no cambia</strong> hasta que confirmes.`) +
      detailsTable([...antes, ...nuevo, ['Lugar del servicio', d.lugar]]) +
      `<div style="margin:22px 0 8px">${button(d.confirmUrl, 'Sí, cambiar mi cita')}</div>` +
      p(`Este enlace se puede usar una sola vez y vence en ${esc(d.expira)}. Si para entonces el nuevo horario ya lo tomó otra persona, te avisaremos y tu cita original se mantiene.`) +
      `<p style="margin:18px 0 0;font-size:13px;color:${C.muted}"><strong>¿No fuiste tú?</strong> Ignora este mensaje: tu cita sigue igual. Dudas por <a href="${esc(d.empresa.whatsappUrl)}" style="color:${C.red}">WhatsApp</a>.</p>`,
  });
  const text = `Confirma el cambio de tu cita ${d.codigo}\n\nHola ${d.nombre}, recibimos una solicitud para CAMBIAR tu cita. Tu cita no cambia hasta que confirmes.\n\n${textRows([...antes, ...nuevo])}\n\nPara confirmar, abre este enlace (se usa una sola vez y vence en ${d.expira}):\n${d.confirmUrl}\n\n¿No fuiste tú? Ignora este mensaje: tu cita sigue igual. Dudas por WhatsApp: ${d.empresa.whatsappUrl}\n` + footerText(d);
  return { subject, text, html };
}

const RENDERERS = { confirmacion, cambio, cancelacion, confirmar_cancelacion: confirmarCancelacion, confirmar_cambio: confirmarCambio, aviso_dueno: avisoDueno, resumen_dueno: resumenDueno };

export function renderEmail(tipo, data) {
  const fn = RENDERERS[tipo];
  if (!fn) throw new Error(`Tipo de correo desconocido: ${tipo}`);
  return fn(data);
}
