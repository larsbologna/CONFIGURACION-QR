'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const { bad, str } = require('../util');

const TYPES = {
  google_resena: 'Reseña en Google (Place ID)',
  google_maps: 'Ficha de Google Maps',
  menu: 'Menú / carta',
  url: 'Sitio web (URL)',
  pagina: 'Página propia con enlaces',
};

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}

/** Valida un destino externo: https, sin credenciales, sin hosts internos, sin bucles. */
function validateExternalUrl(raw, config, field = 'URL') {
  const s = str(raw, { field, max: 2000, required: true });
  let u;
  try { u = new URL(s); } catch { throw bad(`${field}: no es una dirección válida (debe empezar con https://)`); }
  if (u.protocol !== 'https:' && !(config.allowHttpDestinations && u.protocol === 'http:')) {
    throw bad(`${field}: solo se permiten direcciones https://`);
  }
  if (u.username || u.password) throw bad(`${field}: no se permiten credenciales dentro de la URL`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw bad(`${field}: el dominio no es público`);
  }
  if (net.isIP(host) && isPrivateIp(host)) throw bad(`${field}: no se permiten direcciones IP privadas`);
  const own = new URL(config.publicBaseUrl);
  if (host === own.hostname.toLowerCase() && u.pathname.startsWith(`${own.pathname.replace(/\/$/, '')}/q/`)) {
    throw bad(`${field}: no puede apuntar a otro QR del sistema (redirección en bucle)`);
  }
  return u.toString();
}

/**
 * Normaliza el destino que envía el panel.
 * input = { type, url?, place_id?, page?: { title, message, links: [{ text, url }] } }
 */
function buildDestination(input, config) {
  const type = input?.type;
  if (!type || type === 'ninguno') return { destination_type: null, destination_url: null, destination_config: null };
  if (!TYPES[type]) throw bad('Tipo de destino inválido');
  if (type === 'google_resena') {
    const pid = str(input.place_id, { field: 'Place ID', max: 300, required: true });
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(pid)) throw bad('El Place ID de Google no tiene un formato válido');
    return {
      destination_type: type,
      destination_url: `https://search.google.com/local/writereview?placeid=${encodeURIComponent(pid)}`,
      destination_config: JSON.stringify({ place_id: pid }),
    };
  }
  if (type === 'pagina') {
    const p = input.page || {};
    const links = Array.isArray(p.links) ? p.links : [];
    if (links.length < 1 || links.length > 6) throw bad('La página propia debe tener entre 1 y 6 enlaces');
    const page = {
      title: str(p.title, { field: 'título', max: 120, required: true }),
      message: str(p.message, { field: 'mensaje', max: 500 }) || '',
      links: links.map((l, i) => ({
        text: str(l.text, { field: `texto del enlace ${i + 1}`, max: 60, required: true }),
        url: validateExternalUrl(l.url, config, `Enlace ${i + 1}`),
      })),
    };
    return { destination_type: type, destination_url: null, destination_config: JSON.stringify(page) };
  }
  return { destination_type: type, destination_url: validateExternalUrl(input.url, config), destination_config: null };
}

function describeDestination(unit) {
  if (!unit.destination_type) return 'Sin destino';
  if (unit.destination_type === 'pagina') {
    try { return `Página propia: ${JSON.parse(unit.destination_config).title}`; } catch { return 'Página propia'; }
  }
  return unit.destination_url;
}

/** Prueba el destino desde el servidor (sin seguir redirecciones a redes internas). */
async function testDestination(url, config) {
  const target = validateExternalUrl(url, config);
  const u = new URL(target);
  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); } catch {
    return { ok: false, message: `El dominio ${u.hostname} no existe o no se pudo resolver.` };
  }
  if (addrs.some((a) => isPrivateIp(a.address))) return { ok: false, message: 'El dominio apunta a una red privada: no se permite.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(target, { method: 'GET', redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'QR-Panel-Verificador/1.0' } });
    const loc = res.headers.get('location');
    const ok = res.status < 400;
    return {
      ok, status: res.status,
      message: ok ? `El destino respondió ${res.status}${loc ? ` (redirige a ${loc.slice(0, 200)})` : ''}.` : `El destino respondió con error ${res.status}.`,
    };
  } catch (e) {
    return { ok: false, message: e.name === 'AbortError' ? 'El destino no respondió en 8 segundos.' : `No se pudo conectar: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { TYPES, buildDestination, validateExternalUrl, describeDestination, testDestination, isPrivateIp };
