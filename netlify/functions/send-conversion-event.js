// netlify/functions/send-conversion-event.js
//
// Recibe eventos de conversion desde el navegador (botones de WhatsApp que
// abren el formulario de esta landing) y los reenvia server-side a la API
// de Conversiones de Meta, deduplicados contra el Pixel via event_id.
//
// El Access Token NUNCA vive en este archivo ni en el repositorio: se lee
// unicamente de la variable de entorno META_CAPI_ACCESS_TOKEN, configurada
// a mano por el dueno del sitio en Netlify (Site settings > Environment
// variables). Si no esta presente, la funcion responde 500 y no envia nada.
//
// META_TEST_EVENT_CODE (opcional, no secreta): si esta configurada en
// Netlify, se agrega test_event_code al payload para que los eventos
// aparezcan en Meta Events Manager > Probar eventos en vez de contar como
// trafico real. Se debe eliminar esa variable cuando termine la prueba.
//
// em/ph (opcionales): email y telefono del formulario de lead. Nunca se
// envian en texto plano a Meta -- se normalizan y se hashean con SHA-256
// aqui mismo antes de salir de este servidor, como exige la Conversions API.
const crypto = require('crypto');
const PIXEL_ID = '675376958999264';
const GRAPH_API_VERSION = 'v19.0';
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function hashEmail(email) {
  if (!email) return undefined;
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) return undefined;
  return sha256(normalized);
}
function hashPhone(phone) {
  if (!phone) return undefined;
  const digitsOnly = String(phone).replace(/\D/g, '');
  if (!digitsOnly) return undefined;
  return sha256(digitsOnly);
}
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!accessToken) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'META_CAPI_ACCESS_TOKEN no esta configurado en las variables de entorno de Netlify.' }),
    };
  }
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON invalido en el body.' }) };
  }
  const { event_name, event_id, event_source_url, fbp, fbc, em, ph, external_id } = payload;
  if (!event_name || !event_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'event_name y event_id son obligatorios.' }) };
  }
  const headers = event.headers || {};
  const clientIp =
    headers['x-nf-client-connection-ip'] ||
    (headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    undefined;
  const userAgent = headers['user-agent'] || undefined;
  const userData = {};
  if (clientIp) userData.client_ip_address = clientIp;
  if (userAgent) userData.client_user_agent = userAgent;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (external_id) userData.external_id = external_id;
  const hashedEmail = hashEmail(em);
  const hashedPhone = hashPhone(ph);
  if (hashedEmail) userData.em = hashedEmail;
  if (hashedPhone) userData.ph = hashedPhone;
  const metaPayload = {
    data: [
      {
        event_name,
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: event_source_url || '',
        action_source: 'website',
        event_id,
        user_data: userData,
      },
      ],
  };
  if (process.env.META_TEST_EVENT_CODE) {
    metaPayload.test_event_code = process.env.META_TEST_EVENT_CODE;
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(accessToken)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metaPayload),
    });
    const body = await response.text();
    return { statusCode: response.status, headers: { 'Content-Type': 'application/json' }, body };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'No se pudo contactar a Meta.', detail: String(err) }),
    };
  }
};
