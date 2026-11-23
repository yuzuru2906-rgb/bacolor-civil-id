'use strict';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* Barangays of Bacolor (same list the website uses). */
const REGIONS = {
  CLB: 'Calibutbut', SIS: 'San Isidro', CBL: 'Cabalantian', CBT: 'Cabetican', MLW: 'Maliwalu', TNJ: 'Tinajero',
  SVT: 'San Vicente', MGL: 'Magliman', STB: 'Santa Barbara', STI: 'Santa Ines', SAN: 'San Antonio', MCB: 'Macabacle',
  PRL: 'Parulog', PTR: 'Potrero', DLR: 'Dolores', CBB: 'Cabambangan (Poblacion)', BLS: 'Balas', DUA: 'Duat',
  CON: 'Concepcion', MSL: 'Mesalipit', TLB: 'Talba'
};

const FAMILY_RELATIONSHIPS = ['Father', 'Mother', 'Son', 'Daughter', 'Brother', 'Sister', 'Spouse', 'Parent', 'Child', 'Grandparent', 'Grandchild', 'Other relative'];

const digits = (v) => String(v || '').replace(/\D/g, '');

/* Same rules as the website: a mobile number is stored as 09XXXXXXXXX, an email is lower-cased. */
function normPhone(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.indexOf('@') !== -1) return s.toLowerCase();
  let d = digits(s);
  if (d.indexOf('63') === 0 && d.length === 13 && d.charAt(2) === '0') d = d.slice(2);
  else if (d.indexOf('63') === 0 && d.length === 12) d = '0' + d.slice(2);
  else if (d.length === 10 && d.charAt(0) === '9') d = '0' + d;
  return d;
}

/* Shown as (+63)9XX-XXX-XXXX, exactly like the website does. */
function fmtPhone(v) {
  const d = normPhone(v);
  if (d.indexOf('@') !== -1) return d;
  return /^09\d{9}$/.test(d) ? '(+63)' + d.slice(1, 4) + '-' + d.slice(4, 7) + '-' + d.slice(7) : d;
}

const isMobile = (v) => /^09\d{9}$/.test(v);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const isContact = (v) => isMobile(v) || isEmail(v);

function ymd(v) {
  const d = new Date(v);
  if (isNaN(d)) return '';
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* Only genuine image data URIs, and not absurdly big (the website already shrinks photos to ~640px JPEGs). */
const MAX_IMAGE_CHARS = 1_500_000;
const IMG_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i;
const safeImg = (v) => typeof v === 'string' && v.length <= MAX_IMAGE_CHARS && IMG_RE.test(v) ? v : '';

const cleanText = (v, max = 200) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
const normName = (v) => cleanText(v).toLowerCase();

module.exports = { HttpError, REGIONS, FAMILY_RELATIONSHIPS, normPhone, fmtPhone, isMobile, isEmail, isContact, ymd, safeImg, cleanText, normName, MAX_IMAGE_CHARS };
