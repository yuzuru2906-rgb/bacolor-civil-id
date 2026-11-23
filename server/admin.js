'use strict';
const { HttpError, cleanText } = require('./util');
const { hashPassword, verifyPassword, dummyVerify, safeEqual } = require('./security');
const S = require('./store');

const MIN = 60 * 1000;
const FIFTEEN_MIN = 15 * MIN;

module.exports = function adminRoutes({ db, config, limiter }) {
  const ttl = config.adminSessionHours * 60 * MIN;
  const tooMany = () => new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');

  const publicAdmin = (a) => ({ name: a.name, username: a.username, phone: a.phone || '', role: a.role });

  async function getAdmin(username) {
    const rows = await db.query('SELECT * FROM admins WHERE username = ?', [String(username || '').toLowerCase()]);
    return rows[0] || null;
  }
  async function currentAdmin(ctx) {
    const a = await getAdmin(ctx.auth.subject);
    if (!a) throw new HttpError(401, 'Your session has expired. Please log in again.');
    return a;
  }

  /* ---------- sign in / sign up ---------- */
  async function login(ctx) {
    const body = ctx.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    if (!limiter.hit('alogin:ip:' + ctx.ip, 30, FIFTEEN_MIN) || !limiter.hit('alogin:u:' + username, 6, FIFTEEN_MIN)) throw tooMany();
    const admin = await getAdmin(username);
    const ok = admin ? await verifyPassword(body.password, admin.password_hash) : await dummyVerify(body.password);
    if (!admin || !ok) throw new HttpError(401, 'Incorrect username or password.');
    limiter.clear('alogin:u:' + username);
    const token = await S.createSession(db, 'admin', admin.username, ttl);
    return { token, admin: publicAdmin(admin) };
  }

  async function register(ctx) {
    if (!config.adminSignupCode) {
      throw new HttpError(403, 'Admin sign-up is turned off on this server. Ask the registry head to create your account.');
    }
    if (!limiter.hit('areg:ip:' + ctx.ip, 5, 60 * MIN)) throw tooMany();
    const b = ctx.body || {};
    if (!safeEqual(b.code || '', config.adminSignupCode)) throw new HttpError(403, 'That admin access code is not correct.');

    const name = cleanText(b.name, 100);
    const username = String(b.username || '').trim().toLowerCase();
    const phone = String(b.phone || '').replace(/\D/g, '');
    const password = String(b.password || '');
    if (name.length < 2) throw new HttpError(400, 'Please enter your full name.');
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'Username must be 3 to 32 letters, numbers, dots, dashes or underscores.');
    if (phone && !/^\d{7,15}$/.test(phone)) throw new HttpError(400, 'Enter a valid mobile number.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');

    const hash = await hashPassword(password);
    try {
      await db.run('INSERT INTO admins (username, name, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [username, name, phone, hash, 'staff', S.nowIso()]);
    } catch (e) {
      if (db.isUniqueViolation(e)) throw new HttpError(409, 'That username is already taken. Please pick another one.');
      throw e;
    }
    return { ok: true, name, username };
  }

  async function logout(ctx) { await S.deleteSession(db, ctx.token); return { ok: true }; }
  async function me(ctx) { return { admin: publicAdmin(await currentAdmin(ctx)) }; }

  /* ---------- own account ---------- */
  async function updateProfile(ctx) {
    const admin = await currentAdmin(ctx);
    const name = cleanText((ctx.body || {}).name, 100);
    const phone = String((ctx.body || {}).phone || '').replace(/\D/g, '');
    if (name.length < 2) throw new HttpError(400, 'Please enter your full name.');
    if (phone && !/^\d{7,15}$/.test(phone)) throw new HttpError(400, 'Enter a valid mobile number.');
    await db.run('UPDATE admins SET name = ?, phone = ? WHERE username = ?', [name, phone, admin.username]);
    return { admin: publicAdmin({ ...admin, name, phone }) };
  }

  async function changePassword(ctx) {
    const admin = await currentAdmin(ctx);
    const b = ctx.body || {};
    if (!limiter.hit('achpw:' + admin.username, 10, FIFTEEN_MIN)) throw tooMany();
    if (!(await verifyPassword(b.current, admin.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
    const password = String(b.password || '');
    if (password.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
    await db.run('UPDATE admins SET password_hash = ? WHERE username = ?', [await hashPassword(password), admin.username]);
    await S.deleteSubjectSessions(db, 'admin', admin.username, ctx.auth.tokenHash);
    return { ok: true };
  }

  /* ---------- resident registry ---------- */
  async function listResidents() { return { residents: await S.listResidentsForAdmin(db) }; }

  async function getOneResident(ctx) {
    const rec = await S.getResident(db, ctx.params.id);
    if (!rec) throw new HttpError(404, 'Record no longer exists.');
    return { resident: rec };
  }

  async function setVerified(ctx) {
    const admin = await currentAdmin(ctx);
    const verified = !!(ctx.body || {}).verified;
    await db.tx(async (t) => {
      const rec = await S.getResident(t, ctx.params.id);
      if (!rec) throw new HttpError(404, 'Record no longer exists.');
      rec.verified = verified;
      rec.verificationSource = verified ? 'admin-approved' : 'awaiting-admin-review';
      rec.verifiedAt = verified ? S.nowIso() : '';
      rec.verifiedBy = verified ? admin.name : '';
      await S.saveResident(t, rec);
    });
    const [light] = await S.listResidentsForAdmin(db, ctx.params.id);
    return { resident: light };
  }

  async function clearResidents(ctx) {
    const admin = await currentAdmin(ctx);
    if (admin.role !== 'superadmin') throw new HttpError(403, 'Only the main registry administrator can clear all records.');
    await db.tx(async (t) => {
      for (const table of ['resident_photos', 'credentials', 'family_profiles', 'residents']) await t.run('DELETE FROM ' + table);
      await t.run('DELETE FROM sessions WHERE kind = ?', ['resident']);
    });
    return { ok: true };
  }

  const A = 'admin';
  return [
    { method: 'POST', path: '/api/admin/login', handler: login },
    { method: 'POST', path: '/api/admin/register', handler: register },
    { method: 'POST', path: '/api/admin/logout', auth: A, handler: logout },
    { method: 'GET', path: '/api/admin/me', auth: A, handler: me },
    { method: 'POST', path: '/api/admin/profile', auth: A, handler: updateProfile },
    { method: 'POST', path: '/api/admin/change-password', auth: A, handler: changePassword },
    { method: 'GET', path: '/api/admin/residents', auth: A, handler: listResidents },
    { method: 'GET', path: '/api/admin/residents/:id', auth: A, handler: getOneResident },
    { method: 'POST', path: '/api/admin/residents/:id/verify', auth: A, handler: setVerified },
    { method: 'POST', path: '/api/admin/clear-residents', auth: A, handler: clearResidents }
  ];
};
