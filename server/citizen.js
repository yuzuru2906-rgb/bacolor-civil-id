'use strict';
const { HttpError, REGIONS, normPhone, fmtPhone, isContact, isMobile, ymd, safeImg, cleanText, normName } = require('./util');
const { hashPassword, verifyPassword, dummyVerify } = require('./security');
const S = require('./store');

const MIN = 60 * 1000;
const FIFTEEN_MIN = 15 * MIN;

module.exports = function citizenRoutes({ db, config, limiter }) {
  const sessionTtl = config.sessionDays * 24 * 60 * MIN;

  const tooMany = () => new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');

  async function currentResident(ctx) {
    const me = await S.getResident(db, ctx.auth.subject);
    if (!me) throw new HttpError(401, 'Your session has expired. Please log in again.');
    return me;
  }

  /* ---------- register ---------- */
  async function register(ctx) {
    if (!limiter.hit('register:ip:' + ctx.ip, 10, 60 * MIN)) throw tooMany();
    const body = ctx.body || {};
    const input = body.resident || {};
    const password = String(body.password || '');

    const name = cleanText(input.name);
    const sex = ['Male', 'Female'].indexOf(input.sex) !== -1 ? input.sex : cleanText(input.sex, 20);
    const region = String(input.region || '');
    const address = cleanText(input.address, 300);
    const contact = normPhone(input.phone);
    const dob = new Date(input.dob);
    const height = Number(input.heightCm), weight = Number(input.weightKg);
    const nationality = cleanText(input.nationality, 80);

    if (name.length < 3 || !sex || isNaN(dob) || dob > new Date() || dob.getUTCFullYear() < 1900 || !REGIONS[region] || address.length < 3 || !isContact(contact)) {
      throw new HttpError(400, 'Your resident information on the first page is incomplete or invalid.');
    }
    if (!Number.isFinite(height) || height < 50 || height > 250 || !Number.isFinite(weight) || weight < 2 || weight > 500) {
      throw new HttpError(400, 'Check your height and weight on the second page.');
    }
    if (nationality.length < 2) throw new HttpError(400, 'Enter your nationality on the second page.');
    if (password.length < 8) throw new HttpError(400, 'Set a password of at least 8 characters on the third page.');

    const familyContacts = (Array.isArray(input.familyContacts) ? input.familyContacts : []).slice(0, 20);
    const idPhoto = safeImg(input.idPhoto), facePhoto = safeImg(input.facePhoto), signaturePhoto = safeImg(input.signaturePhoto);
    const idType = idPhoto ? cleanText(input.idType, 80) : '';
    if (!facePhoto) throw new HttpError(400, 'Add a face photo on the third page.');
    if (!signaturePhoto) throw new HttpError(400, 'Upload a clear image of your signature on the third page.');

    if (await S.contactTaken(db, contact)) throw new HttpError(409, S.CONTACT_TAKEN_MSG(contact));

    const passwordHash = await hashPassword(password); // slow work happens BEFORE the transaction

    const issued = new Date();
    const expires = new Date(issued);
    expires.setUTCFullYear(expires.getUTCFullYear() + 3);
    if (expires.getUTCMonth() !== issued.getUTCMonth()) expires.setUTCDate(0);

    // Only these fields are ever taken from the browser. Status fields are decided here, never by the client.
    const complete = !!(idPhoto && idType);
    const autoVerified = config.autoVerify && complete;
    const record = {
      sex, dob: dob.toISOString(), address, phone: fmtPhone(contact),
      heightCm: height, weightKg: weight, nationality,
      occupation: cleanText(input.occupation, 100), civilStatus: cleanText(input.civilStatus, 40), bloodType: cleanText(input.bloodType, 10),
      idType, validUntil: expires.toISOString().slice(0, 10),
      verificationSource: autoVerified ? 'auto-verified' : (complete ? 'awaiting-admin-review' : 'missing-documents'),
      verifiedAt: autoVerified ? issued.toISOString() : '',
      verifiedBy: autoVerified ? 'Automatic check (complete registration)' : '',
      loginEnabled: true, familyRelations: [], emergencyContacts: []
    };

    let newId;
    try {
      newId = await db.tx(async (t) => {
        const id = await S.nextCivilId(t);
        const rec = { ...record, id, name, region, registeredAt: issued.toISOString(), verified: autoVerified };
        await t.run('INSERT INTO residents (id, contact_key, name, region, registered_at, verified, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, contact, name, region, rec.registeredAt, autoVerified ? 1 : 0, S.splitForStorage(rec)]);
        await t.run('INSERT INTO credentials (resident_id, password_hash) VALUES (?, ?)', [id, passwordHash]);
        await S.savePhoto(t, id, 'face', facePhoto);
        await S.savePhoto(t, id, 'signature', signaturePhoto);
        if (idPhoto) await S.savePhoto(t, id, 'id', idPhoto);

        // If someone already listed this person as an (unregistered) relative, connect that profile to the new account.
        const waiting = await t.query('SELECT data FROM family_profiles WHERE phone_key = ? AND resident_id = ?', [contact, '']);
        for (const row of waiting) {
          const p = JSON.parse(row.data);
          if (normName(p.name) === normName(name)) { p.residentId = id; await S.saveProfile(t, p); }
        }
        for (const c of familyContacts) {
          if (!c || (!String(c.name || '').trim() && !String(c.phone || '').trim() && !c.relationship)) continue;
          await S.addFamilyRelation(t, rec, c);
        }
        await S.saveResident(t, rec);
        return id;
      });
    } catch (e) {
      if (db.isUniqueViolation(e)) throw new HttpError(409, S.CONTACT_TAKEN_MSG(contact));
      throw e;
    }
    const token = await S.createSession(db, 'resident', newId, sessionTtl);
    return { token, resident: await S.getResident(db, newId) };
  }

  /* ---------- login / logout / me ---------- */
  async function login(ctx) {
    const body = ctx.body || {};
    const identifier = String(body.identifier || '').trim();
    const idKey = 'login:id:' + identifier.toLowerCase();
    if (!limiter.hit('login:ip:' + ctx.ip, 40, FIFTEEN_MIN) || !limiter.hit(idKey, 8, FIFTEEN_MIN)) throw tooMany();

    const residentId = await S.findResidentByIdentifier(db, identifier);
    let ok = false;
    if (residentId) {
      const cred = await db.query('SELECT password_hash FROM credentials WHERE resident_id = ?', [residentId]);
      ok = cred.length ? await verifyPassword(body.password, cred[0].password_hash) : false;
    } else {
      await dummyVerify(body.password);
    }
    // One message for both "no such account" and "wrong password", so nobody can probe which accounts exist.
    if (!ok) throw new HttpError(401, 'Incorrect Civil ID, mobile number, email, or password.');
    limiter.clear(idKey);
    const token = await S.createSession(db, 'resident', residentId, sessionTtl);
    return { token, resident: await S.getResident(db, residentId) };
  }

  const me = async (ctx) => ({ resident: await currentResident(ctx) });

  async function logout(ctx) {
    await S.deleteSession(db, ctx.token);
    return { ok: true };
  }

  /* ---------- passwords ---------- */
  async function passwordReset(ctx) {
    if (!config.allowDobReset) throw new HttpError(403, 'Online password reset is turned off. Please visit the registry office.');
    const body = ctx.body || {};
    const identifier = String(body.identifier || '').trim();
    if (!limiter.hit('reset:ip:' + ctx.ip, 20, FIFTEEN_MIN) || !limiter.hit('reset:id:' + identifier.toLowerCase(), 5, FIFTEEN_MIN)) throw tooMany();
    const password = String(body.password || '');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');

    const fail = new HttpError(400, 'We could not match that account to the date of birth you entered.');
    const id = await S.findResidentByIdentifier(db, identifier);
    if (!id) { await dummyVerify(password); throw fail; }
    const resident = await S.getResident(db, id);
    if (!resident || ymd(resident.dob) !== String(body.dob || '')) throw fail;

    const hash = await hashPassword(password);
    await db.tx(async (t) => {
      await t.run('UPDATE credentials SET password_hash = ? WHERE resident_id = ?', [hash, id]);
      await t.run('DELETE FROM sessions WHERE kind = ? AND subject = ?', ['resident', id]); // log out everywhere
    });
    return { ok: true };
  }

  async function changePassword(ctx) {
    const body = ctx.body || {};
    const resident = await currentResident(ctx);
    if (!limiter.hit('chpw:' + resident.id, 10, FIFTEEN_MIN)) throw tooMany();
    const cred = await db.query('SELECT password_hash FROM credentials WHERE resident_id = ?', [resident.id]);
    if (!cred.length || !(await verifyPassword(body.current, cred[0].password_hash))) throw new HttpError(400, 'Current password is incorrect.');
    const password = String(body.password || '');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    const hash = await hashPassword(password);
    await db.run('UPDATE credentials SET password_hash = ? WHERE resident_id = ?', [hash, resident.id]);
    await S.deleteSubjectSessions(db, 'resident', resident.id, ctx.auth.tokenHash); // sign out other devices
    return { ok: true };
  }

  /* ---------- documents ---------- */
  async function uploadDocument(ctx) {
    const body = ctx.body || {};
    const idType = cleanText(body.idType, 80);
    if (!idType) throw new HttpError(400, 'Select your Government ID type.');
    const idPhoto = safeImg(body.idPhoto);
    if (!idPhoto) throw new HttpError(400, 'Choose a clear photo of your Government ID.');
    await db.tx(async (t) => {
      const rec = await S.getResident(t, ctx.auth.subject);
      if (!rec) throw new HttpError(404, 'Your resident profile could not be found.');
      rec.idType = idType;
      rec.verified = false;
      rec.verificationSource = 'awaiting-admin-review'; // a new document always goes to the registry for review
      rec.verifiedAt = '';
      rec.verifiedBy = '';
      rec.documentsSubmittedAt = S.nowIso();
      await S.savePhoto(t, rec.id, 'id', idPhoto);
      await S.saveResident(t, rec);
    });
    return { resident: await currentResident(ctx) };
  }

  /* ---------- contact + family ---------- */
  async function contactAvailable(ctx) {
    if (!limiter.hit('avail:ip:' + ctx.ip, 40, FIFTEEN_MIN)) throw tooMany();
    const key = normPhone((ctx.body || {}).phone);
    if (key && await S.contactTaken(db, key)) throw new HttpError(409, S.CONTACT_TAKEN_MSG(key));
    return { ok: true };
  }

  async function family(ctx) {
    return S.familyCircle(db, await currentResident(ctx));
  }

  async function familyRelations(ctx) {
    const result = await db.tx(async (t) => {
      const owner = await S.getResident(t, ctx.auth.subject);
      if (!owner) throw new HttpError(404, 'Your resident profile could not be found.');
      const out = await S.addFamilyRelation(t, owner, ctx.body || {});
      await S.saveResident(t, owner);
      return { owner, ...out };
    });
    const pid = result.relation.profileId;
    let registered = (await db.query('SELECT id FROM residents WHERE id = ?', [pid])).length > 0;
    if (!registered) { const p = await S.getProfile(db, pid); registered = !!(p && p.residentId); }
    return { resident: result.owner, relation: result.relation, created: result.created, emergencyUpdated: result.emergencyUpdated, registered };
  }

  const R = 'resident';
  return [
    { method: 'POST', path: '/api/register', handler: register },
    { method: 'POST', path: '/api/login', handler: login },
    { method: 'POST', path: '/api/logout', auth: R, handler: logout },
    { method: 'GET', path: '/api/me', auth: R, handler: me },
    { method: 'POST', path: '/api/password-reset', handler: passwordReset },
    { method: 'POST', path: '/api/change-password', auth: R, handler: changePassword },
    { method: 'POST', path: '/api/upload-document', auth: R, handler: uploadDocument },
    { method: 'POST', path: '/api/contact-available', handler: contactAvailable },
    { method: 'GET', path: '/api/family', auth: R, handler: family },
    { method: 'POST', path: '/api/family-relations', auth: R, handler: familyRelations }
  ];
};
