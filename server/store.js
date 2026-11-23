'use strict';
/*
 * Everything that reads or writes residents, photos, family links and sessions.
 * IMPORTANT: code that runs inside db.tx() must not do slow async work (like hashing passwords).
 * Hash first, then open the transaction.
 */
const crypto = require('node:crypto');
const { HttpError, FAMILY_RELATIONSHIPS, normPhone, fmtPhone, normName, cleanText } = require('./util');
const { sha256, newToken } = require('./security');

const PHOTO_KINDS = { idPhoto: 'id', facePhoto: 'face', signaturePhoto: 'signature' };
const localId = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
const placeholders = (n) => new Array(n).fill('?').join(',');
const nowIso = () => new Date().toISOString();

/* ================= sessions ================= */
async function createSession(db, kind, subject, ttlMs) {
  const token = newToken();
  await db.run('INSERT INTO sessions (token_hash, kind, subject, expires_at) VALUES (?, ?, ?, ?)',
    [sha256(token), kind, subject, new Date(Date.now() + ttlMs).toISOString()]);
  // Opportunistic clean-up of expired sessions.
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
  return token;
}

async function findSession(db, kind, token) {
  if (!token) return null;
  const rows = await db.query('SELECT subject, expires_at FROM sessions WHERE token_hash = ? AND kind = ?', [sha256(token), kind]);
  if (!rows.length || rows[0].expires_at < nowIso()) return null;
  return { subject: rows[0].subject, tokenHash: sha256(token) };
}

const deleteSession = (db, token) => db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
const deleteSubjectSessions = (db, kind, subject, exceptHash) =>
  db.run('DELETE FROM sessions WHERE kind = ? AND subject = ? AND token_hash <> ?', [kind, subject, exceptHash || '']);

/* ================= residents ================= */
function parseRow(row) {
  const rec = JSON.parse(row.data);
  rec.id = row.id;
  rec.name = row.name;
  rec.region = row.region;
  rec.registeredAt = row.registered_at;
  rec.verified = !!row.verified;
  return rec;
}

async function loadPhotos(db, ids, kinds) {
  if (!ids.length) return {};
  const wanted = kinds || ['id', 'face', 'signature'];
  const rows = await db.query(
    `SELECT resident_id, kind, data FROM resident_photos WHERE resident_id IN (${placeholders(ids.length)}) AND kind IN (${placeholders(wanted.length)})`,
    [...ids, ...wanted]);
  const out = {};
  const nameOf = { id: 'idPhoto', face: 'facePhoto', signature: 'signaturePhoto' };
  for (const r of rows) (out[r.resident_id] = out[r.resident_id] || {})[nameOf[r.kind]] = r.data;
  return out;
}

/** Load one resident with all three photos (used for "me" and the admin detail view). */
async function getResident(db, id) {
  const rows = await db.query('SELECT * FROM residents WHERE id = ?', [id]);
  if (!rows.length) return null;
  const rec = parseRow(rows[0]);
  const photos = (await loadPhotos(db, [id]))[id] || {};
  rec.idPhoto = photos.idPhoto || '';
  rec.facePhoto = photos.facePhoto || '';
  rec.signaturePhoto = photos.signaturePhoto || '';
  return rec;
}

async function findResidentByIdentifier(db, identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  let rows = await db.query('SELECT id FROM residents WHERE UPPER(id) = ?', [value.toUpperCase()]);
  if (!rows.length) {
    const key = normPhone(value);
    if (!key) return null;
    rows = await db.query('SELECT id FROM residents WHERE contact_key = ?', [key]);
  }
  return rows.length ? rows[0].id : null;
}

/* The JSON column holds everything except the photos, the display columns and the password. */
function splitForStorage(rec) {
  const data = { ...rec };
  for (const k of ['idPhoto', 'facePhoto', 'signaturePhoto', 'id', 'name', 'region', 'registeredAt', 'verified']) delete data[k];
  return JSON.stringify(data);
}

async function saveResident(t, rec) {
  await t.run('UPDATE residents SET name = ?, region = ?, verified = ?, data = ? WHERE id = ?',
    [rec.name, rec.region, rec.verified ? 1 : 0, splitForStorage(rec), rec.id]);
}

async function savePhoto(t, residentId, kind, data) {
  await t.run('DELETE FROM resident_photos WHERE resident_id = ? AND kind = ?', [residentId, kind]);
  if (data) await t.run('INSERT INTO resident_photos (resident_id, kind, data) VALUES (?, ?, ?)', [residentId, kind, data]);
}

async function nextCivilId(t) {
  const rows = await t.query("SELECT id FROM residents WHERE id LIKE 'BAC-%'");
  const max = rows.reduce((m, r) => Math.max(m, parseInt(String(r.id).split('-').pop(), 10) || 0), 999);
  return 'BAC-' + new Date().getFullYear() + '-' + String(max + 1).padStart(4, '0');
}

async function contactTaken(db, contactKey, exceptId) {
  const rows = await db.query('SELECT id FROM residents WHERE contact_key = ?', [contactKey]);
  return rows.some((r) => r.id !== exceptId);
}

const CONTACT_TAKEN_MSG = (key) => key.indexOf('@') !== -1
  ? 'This email is already registered to another account. Log in, or use a different email.'
  : 'This mobile number is already registered to another account. Log in, or use a different number.';

/* ================= admin-side views of residents ================= */
/** Every resident, WITHOUT photo data; flags say which documents are on file. */
async function listResidentsForAdmin(db, onlyId) {
  const rows = onlyId
    ? await db.query('SELECT * FROM residents WHERE id = ?', [onlyId])
    : await db.query('SELECT * FROM residents ORDER BY registered_at DESC');
  const flags = onlyId
    ? await db.query('SELECT resident_id, kind FROM resident_photos WHERE resident_id = ?', [onlyId])
    : await db.query('SELECT resident_id, kind FROM resident_photos');
  const byId = {};
  for (const f of flags) (byId[f.resident_id] = byId[f.resident_id] || {})[f.kind] = true;
  return rows.map((row) => {
    const rec = parseRow(row);
    const f = byId[rec.id] || {};
    rec.idPhoto = ''; rec.facePhoto = ''; rec.signaturePhoto = '';
    rec.idPhotoOnFile = !!f.id; rec.facePhotoOnFile = !!f.face; rec.signaturePhotoOnFile = !!f.signature;
    return rec;
  });
}

/* ================= family ================= */
async function getProfile(db, id) {
  const rows = await db.query('SELECT data FROM family_profiles WHERE id = ?', [id]);
  return rows.length ? JSON.parse(rows[0].data) : null;
}
async function saveProfile(t, profile) {
  const phoneKey = normPhone(profile.phone);
  const body = JSON.stringify(profile);
  const upd = await t.run('UPDATE family_profiles SET phone_key = ?, resident_id = ?, data = ? WHERE id = ?', [phoneKey, profile.residentId || '', body, profile.id]);
  if (!upd.changes) await t.run('INSERT INTO family_profiles (id, phone_key, resident_id, data) VALUES (?, ?, ?, ?)', [profile.id, phoneKey, profile.residentId || '', body]);
}

/** Works out which registered resident (or unregistered profile) a family contact refers to. */
async function familyProfileIdForContact(t, contact, owner) {
  if (contact.personId) {
    const rows = await t.query('SELECT id FROM residents WHERE id = ?', [String(contact.personId)]);
    if (!rows.length || rows[0].id === owner.id) throw new HttpError(400, 'Select a valid registered family member.');
    return rows[0].id;
  }
  const name = cleanText(contact.name);
  const phone = normPhone(contact.phone);
  if (name.length < 2) throw new HttpError(400, 'Enter the family member’s full name.');
  if (!/^09\d{9}$/.test(phone)) throw new HttpError(400, 'Enter a valid family member mobile number.');

  // A registered resident must match BOTH the name and the number.
  const people = await t.query('SELECT id, name FROM residents WHERE contact_key = ?', [phone]);
  const match = people.filter((p) => normName(p.name) === normName(name))[0];
  if (match) {
    if (match.id === owner.id) throw new HttpError(400, 'You cannot add yourself as a family member.');
    return match.id;
  }
  const profiles = await t.query('SELECT data FROM family_profiles WHERE phone_key = ? AND resident_id = ?', [phone, '']);
  const existing = profiles.map((p) => JSON.parse(p.data)).filter((p) => normName(p.name) === normName(name))[0];
  if (existing) return existing.id;
  const profile = { id: localId('FAM'), name, phone: fmtPhone(phone), createdAt: nowIso() };
  await saveProfile(t, profile);
  return profile.id;
}

/** Adds (or re-uses) a family link on `owner` (mutates owner; the caller saves it). */
async function addFamilyRelation(t, owner, contact) {
  const relationship = String(contact.relationship || '').trim();
  if (FAMILY_RELATIONSHIPS.indexOf(relationship) === -1) throw new HttpError(400, 'Select the family relationship.');
  const profileId = await familyProfileIdForContact(t, contact, owner);
  const relations = Array.isArray(owner.familyRelations) ? owner.familyRelations : (owner.familyRelations = []);
  const emergency = Array.isArray(owner.emergencyContacts) ? owner.emergencyContacts : (owner.emergencyContacts = []);
  const existing = relations.filter((r) => r.profileId === profileId)[0];
  if (existing) {
    if (existing.relationship !== relationship) {
      throw new HttpError(400, 'This person is already linked as ' + existing.relationship + '. Existing family relationships were not changed.');
    }
    const emergencyUpdated = !!contact.isEmergencyContact && emergency.indexOf(existing.id) === -1;
    if (emergencyUpdated) emergency.push(existing.id);
    return { relation: existing, created: false, emergencyUpdated };
  }
  const relation = { id: localId('REL'), profileId, relationship, status: 'pending', createdAt: nowIso() };
  relations.push(relation);
  if (contact.isEmergencyContact) emergency.push(relation.id);
  return { relation, created: true, emergencyUpdated: !!contact.isEmergencyContact };
}

/** The slice of other residents that a person is allowed to see: only people they have linked as family. */
async function familyCircle(db, me) {
  const relations = Array.isArray(me.familyRelations) ? me.familyRelations : [];
  const ids = [...new Set(relations.map((r) => r.profileId))];
  const residentIds = new Set();
  const profiles = [];
  if (ids.length) {
    const found = await db.query(`SELECT id FROM residents WHERE id IN (${placeholders(ids.length)})`, ids);
    found.forEach((r) => residentIds.add(r.id));
    const profileIds = ids.filter((id) => !residentIds.has(id));
    if (profileIds.length) {
      const rows = await db.query(`SELECT data FROM family_profiles WHERE id IN (${placeholders(profileIds.length)})`, profileIds);
      rows.forEach((r) => { const p = JSON.parse(r.data); profiles.push(p); if (p.residentId) residentIds.add(p.residentId); });
    }
  }
  residentIds.delete(me.id);
  const people = [];
  const list = [...residentIds];
  if (list.length) {
    const rows = await db.query(`SELECT * FROM residents WHERE id IN (${placeholders(list.length)})`, list);
    const photos = await loadPhotos(db, list, ['face']);
    for (const row of rows) {
      const r = parseRow(row);
      // Deliberately limited: no address, date of birth, ID document or signature of other people.
      people.push({ id: r.id, name: r.name, sex: r.sex, region: r.region, phone: r.phone, verified: r.verified, loginEnabled: true, facePhoto: (photos[r.id] || {}).facePhoto || '' });
    }
  }
  return { residents: [me, ...people], familyProfiles: profiles };
}

module.exports = {
  PHOTO_KINDS, localId, nowIso,
  createSession, findSession, deleteSession, deleteSubjectSessions,
  getResident, findResidentByIdentifier, saveResident, savePhoto, nextCivilId, contactTaken, CONTACT_TAKEN_MSG, splitForStorage,
  listResidentsForAdmin, getProfile, saveProfile, addFamilyRelation, familyCircle, loadPhotos
};
