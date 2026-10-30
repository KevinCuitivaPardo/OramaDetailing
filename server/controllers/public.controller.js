import { isAgendaClosed } from '../utils/time.js';
import { E } from '../utils/errors.js';

/** Controladores públicos: delgados a propósito. Validan (en la ruta), llaman a un servicio y dan forma a la respuesta. */
export function createPublicController({ env, availability, reservations, mailer, calendar, clock }) {
  const whatsappUrl = `https://wa.me/${env.WHATSAPP_NUMBER}`;
  const wa = (texto) => `${whatsappUrl}?text=${encodeURIComponent(texto)}`;

  return {
    config: (_req, res) => {
      const w = reservations.bookingWindow();
      res.json({
        whatsapp: env.WHATSAPP_NUMBER, whatsappUrl, telefono: env.BUSINESS_PHONE,
        correoActivo: mailer.configured, agendaCerrada: isAgendaClosed(clock()), ventana: { desde: w.desde, hasta: w.hasta }, cambioHastaMin: env.CHANGE_CUTOFF_MINUTES,
        horario: { aperturaMin: calendar.hours().openMin, cierreMin: calendar.hours().closeMin },
      });
    },

    availabilityDay: (req, res) => {
      const { servicio, fecha } = req.valid;
      const day = availability.day({ fecha, servicioId: servicio });
      // Día agotado: solo se ofrece contactar al dueño. La API no habilita ninguna reserva ese día.
      if (day.agotado) day.whatsapp = { url: wa(`Hola, quisiera consultar si hay disponibilidad el ${fecha}.`) };
      res.json(day);
    },

    availabilityMonth: (req, res) => res.json(availability.month({ mes: req.valid.mes, servicioId: req.valid.servicio })),

    create: (req, res) => {
      const { reserva, token, replay } = reservations.create(req.valid, { idempotencyKey: req.idemKey, requestId: req.id });
      if (replay) res.setHeader('Idempotent-Replayed', 'true');
      // `correo` describe lo que realmente pasó: 'en_cola' (se envía enseguida) o 'sin_configurar' (Gmail aún no está listo). Nunca se afirma "enviado" sin serlo
      res.status(replay ? 200 : 201).json({ reserva, tokenGestion: token ?? undefined, correo: { estado: mailer.configured ? 'en_cola' : 'sin_configurar', destino: reserva.correo } });
    },

    ownAvailability: (req, res) => {
      const { fecha, ...creds } = req.valid;
      const { servicioId, row } = reservations.ownAvailability(creds, fecha);
      const day = availability.day({ fecha, servicioId, excludeReservaId: row.id });
      if (day.agotado) day.whatsapp = { url: wa(`Hola, quisiera consultar si hay disponibilidad el ${fecha} para mi reserva.`) };
      res.json(day);
    },

    lookup: (req, res) => res.json({ reserva: reservations.lookup(req.valid) }),

    // Cambiar y cancelar NO se ejecutan al instante: piden una segunda confirmación por correo (202 = solicitud recibida, falta confirmar)
    reschedule: (req, res) => {
      if (!mailer.configured) throw E.mailUnavailable(); // sin correo no hay forma de confirmar: se dice la verdad y se ofrece WhatsApp
      const { fecha, hora, ...creds } = req.valid;
      res.status(202).json(reservations.requestReschedule(creds, { fecha, hora }, { requestId: req.id }));
    },

    cancel: (req, res) => {
      if (!mailer.configured) throw E.mailUnavailable();
      res.status(202).json(reservations.requestCancel(req.valid, { requestId: req.id }));
    },

    /** Qué hará el enlace del correo (no ejecuta nada: así un escáner de enlaces no puede cancelar por accidente). */
    actionPreview: (req, res) => res.json(reservations.previewAction(req.valid)),

    actionConfirm: (req, res) => res.json(reservations.confirmAction(req.valid, { requestId: req.id })),
  };
}
