import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createApp } = require('../server/index.js');

// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const ADMIN_PW = 'Registry#Pass123';

let app, base;
const call = async (method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
};

const residentBody = (over = {}, extra = {}) => ({
  password: 'password123',
  resident: {
    name: 'Maria Santos', sex: 'Female', region: 'CLB', dob: '1992-05-14T12:00:00.000Z',
    address: '142 Rizal St, Calibutbut, Bacolor, Pampanga', phone: '(+63)917-123-4567',
    heightCm: 160, weightKg: 55, nationality: 'Filipino', occupation: 'Teacher', civilStatus: 'Single', bloodType: 'O+',
    familyContacts: [], idPhoto: PNG, idType: 'UMID', facePhoto: PNG, signaturePhoto: PNG, ...over
  },
  ...extra
});

test.before(async () => {
  app = await createApp({ databaseUrl: '', sqliteFile: ':memory:', adminPassword: ADMIN_PW, adminSignupCode: 'staff-code', autoVerify: true, trustProxy: false });
  const port = await app.listen(0);
  base = 'http://127.0.0.1:' + port;
});
test.after(async () => { await app.close(); });
test.beforeEach(() => app.limiter.reset());

test('registering creates a Civil ID, auto-verifies a complete registration, and logs the resident in', async () => {
  const r = await call('POST', '/api/register', residentBody());
  assert.equal(r.status, 200);
  assert.match(r.json.resident.id, /^BAC-\d{4}-1000$/);
  assert.equal(r.json.resident.verified, true);
  assert.equal(r.json.resident.phone, '(+63)917-123-4567');
  assert.ok(r.json.resident.validUntil);
  assert.equal(r.json.resident.password, undefined);
  assert.ok(r.json.resident.facePhoto.startsWith('data:image/png'));
  const me = await call('GET', '/api/me', undefined, r.json.token);
  assert.equal(me.json.resident.name, 'Maria Santos');
});

test('the same mobile number cannot be registered twice (any format)', async () => {
  const dup = await call('POST', '/api/register', residentBody({ phone: '09171234567' }));
  assert.equal(dup.status, 409);
  const avail = await call('POST', '/api/contact-available', { phone: '+639171234567' });
  assert.equal(avail.status, 409);
  const free = await call('POST', '/api/contact-available', { phone: '09991112222' });
  assert.equal(free.status, 200);
});

test('a client cannot choose its own verification status, ID number or extra fields', async () => {
  const r = await call('POST', '/api/register', residentBody(
    { name: 'Sneaky Person', phone: '09180000001', verified: true, id: 'BAC-2026-0001', loginEnabled: false, fatherId: 'x', isAdmin: true, idPhoto: '', idType: '' }));
  assert.equal(r.status, 200);
  assert.notEqual(r.json.resident.id, 'BAC-2026-0001');
  assert.equal(r.json.resident.verified, false);              // missing government ID -> not verified
  assert.equal(r.json.resident.verificationSource, 'missing-documents');
  assert.equal(r.json.resident.fatherId, undefined);
  assert.equal(r.json.resident.isAdmin, undefined);
});

test('validation rejects bad registrations with a helpful message', async () => {
  const cases = [
    [{ name: 'Al' }, /first page/],
    [{ region: 'XXX' }, /first page/],
    [{ phone: '123' }, /first page/],
    [{ dob: '2999-01-01T00:00:00Z' }, /first page/],
    [{ heightCm: 5 }, /height and weight/],
    [{ facePhoto: '' }, /face photo/],
    [{ signaturePhoto: 'javascript:alert(1)' }, /signature/]
  ];
  for (const [over, re] of cases) {
    const r = await call('POST', '/api/register', residentBody({ phone: '09180000002', ...over }));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.json.error, re);
  }
  const short = await call('POST', '/api/register', residentBody({ phone: '09180000002' }, { password: 'short' }));
  assert.equal(short.status, 400);
});

test('login works with Civil ID or mobile number; wrong passwords give one generic message', async () => {
  const byPhone = await call('POST', '/api/login', { identifier: '0917 123 4567', password: 'password123' });
  assert.equal(byPhone.status, 200);
  const byId = await call('POST', '/api/login', { identifier: byPhone.json.resident.id.toLowerCase(), password: 'password123' });
  assert.equal(byId.status, 200);
  const bad = await call('POST', '/api/login', { identifier: '09171234567', password: 'nope' });
  const ghost = await call('POST', '/api/login', { identifier: '09170000000', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(bad.json.error, ghost.json.error);
});

test('logging out kills the session', async () => {
  const { json } = await call('POST', '/api/login', { identifier: '09171234567', password: 'password123' });
  assert.equal((await call('GET', '/api/me', undefined, json.token)).status, 200);
  await call('POST', '/api/logout', {}, json.token);
  assert.equal((await call('GET', '/api/me', undefined, json.token)).status, 401);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, 'garbage')).status, 401);
});

test('login is rate limited', async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await call('POST', '/api/login', { identifier: '09171234567', password: 'wrong' + i });
  assert.equal(last.status, 429);
  // even the right password is refused while locked out
  assert.equal((await call('POST', '/api/login', { identifier: '09171234567', password: 'password123' })).status, 429);
});

test('family: links are created, validated and a resident only sees their own circle', async () => {
  const maria = (await call('POST', '/api/login', { identifier: '09171234567', password: 'password123' })).json;
  const juan = (await call('POST', '/api/register', residentBody({ name: 'Juan Santos', phone: '09190001111' }))).json;
  const stranger = (await call('POST', '/api/register', residentBody({ name: 'Pedro Stranger', phone: '09190002222' }))).json;

  // Maria links Juan (registered: name + number must both match)
  const ok = await call('POST', '/api/family-relations', { name: 'JUAN SANTOS', phone: '09190001111', relationship: 'Brother', isEmergencyContact: true }, maria.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.registered, true);
  assert.equal(ok.json.relation.profileId, juan.resident.id);
  assert.equal(ok.json.resident.emergencyContacts.length, 1);

  // same person, other relationship -> refused; same relationship -> re-used
  assert.equal((await call('POST', '/api/family-relations', { name: 'Juan Santos', phone: '09190001111', relationship: 'Father' }, maria.token)).status, 400);
  assert.equal((await call('POST', '/api/family-relations', { name: 'Juan Santos', phone: '09190001111', relationship: 'Brother' }, maria.token)).json.created, false);
  // wrong name for that number -> becomes an unregistered profile, NOT Juan
  const ghost = await call('POST', '/api/family-relations', { name: 'Someone Else', phone: '09190001111', relationship: 'Sister' }, maria.token);
  assert.equal(ghost.json.registered, false);
  // cannot add yourself
  assert.equal((await call('POST', '/api/family-relations', { name: 'Maria Santos', phone: '09171234567', relationship: 'Sister' }, maria.token)).status, 400);
  assert.equal((await call('POST', '/api/family-relations', { name: 'X', phone: '09190001111', relationship: 'Sister' }, maria.token)).status, 400);
  assert.equal((await call('POST', '/api/family-relations', { name: 'Valid Name', phone: '09190001111', relationship: 'Cousin' }, maria.token)).status, 400);

  const fam = (await call('GET', '/api/family', undefined, maria.token)).json;
  const ids = fam.residents.map((r) => r.id);
  assert.ok(ids.includes(maria.resident.id) && ids.includes(juan.resident.id));
  assert.ok(!ids.includes(stranger.resident.id), 'strangers must not be exposed');
  const juanView = fam.residents.find((r) => r.id === juan.resident.id);
  for (const secret of ['idPhoto', 'signaturePhoto', 'address', 'dob', 'familyRelations']) assert.equal(juanView[secret], undefined, secret + ' leaked');
  assert.equal(fam.familyProfiles.length, 1);
});

test('registering with family contacts links them, and a waiting profile is connected when that person registers', async () => {
  const anna = await call('POST', '/api/register', residentBody({
    name: 'Anna Reyes', phone: '09200000001',
    familyContacts: [{ name: 'Luis Reyes', phone: '09200000002', relationship: 'Father', isEmergencyContact: true }]
  }));
  assert.equal(anna.status, 200);
  assert.equal(anna.json.resident.familyRelations.length, 1);
  const before = (await call('GET', '/api/family', undefined, anna.json.token)).json;
  assert.equal(before.residents.length, 1);
  assert.equal(before.familyProfiles[0].name, 'Luis Reyes');

  await call('POST', '/api/register', residentBody({ name: 'Luis Reyes', phone: '09200000002' }));
  const after = (await call('GET', '/api/family', undefined, anna.json.token)).json;
  assert.equal(after.residents.length, 2);
  assert.equal(after.residents[1].name, 'Luis Reyes');
});

test('uploading a government ID sends the resident back to review', async () => {
  const r = await call('POST', '/api/register', residentBody({ name: 'Rosa Diaz', phone: '09210000001', idPhoto: '', idType: '' }));
  assert.equal(r.json.resident.idPhoto, '');
  assert.equal((await call('POST', '/api/upload-document', { idType: '', idPhoto: PNG }, r.json.token)).status, 400);
  assert.equal((await call('POST', '/api/upload-document', { idType: 'UMID', idPhoto: 'not an image' }, r.json.token)).status, 400);
  const up = await call('POST', '/api/upload-document', { idType: 'UMID', idPhoto: PNG }, r.json.token);
  assert.equal(up.status, 200);
  assert.equal(up.json.resident.verified, false);
  assert.equal(up.json.resident.verificationSource, 'awaiting-admin-review');
  assert.ok(up.json.resident.idPhoto.startsWith('data:image'));
});

test('change password and forgot password', async () => {
  const r = await call('POST', '/api/register', residentBody({ name: 'Pw Tester', phone: '09220000001' }));
  const other = (await call('POST', '/api/login', { identifier: '09220000001', password: 'password123' })).json;
  assert.equal((await call('POST', '/api/change-password', { current: 'wrong', password: 'newpassword1' }, r.json.token)).status, 400);
  assert.equal((await call('POST', '/api/change-password', { current: 'password123', password: 'short' }, r.json.token)).status, 400);
  assert.equal((await call('POST', '/api/change-password', { current: 'password123', password: 'newpassword1' }, r.json.token)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, other.token)).status, 401, 'other devices are signed out');
  assert.equal((await call('GET', '/api/me', undefined, r.json.token)).status, 200, 'this device stays signed in');
  assert.equal((await call('POST', '/api/login', { identifier: '09220000001', password: 'password123' })).status, 401);

  assert.equal((await call('POST', '/api/password-reset', { identifier: '09220000001', dob: '1999-01-01', password: 'resetpass99' })).status, 400);
  assert.equal((await call('POST', '/api/password-reset', { identifier: '09220000001', dob: '1992-05-14', password: 'resetpass99' })).status, 200);
  assert.equal((await call('POST', '/api/login', { identifier: '09220000001', password: 'resetpass99' })).status, 200);
});

test('admin: seeded account logs in, residents list has no photo data, verify works, tokens are not interchangeable', async () => {
  assert.equal((await call('POST', '/api/admin/login', { username: 'admin', password: 'admin123' })).status, 401);
  const a = await call('POST', '/api/admin/login', { username: 'ADMIN', password: ADMIN_PW });
  assert.equal(a.status, 200);
  const token = a.json.token;

  const list = await call('GET', '/api/admin/residents', undefined, token);
  assert.equal(list.status, 200);
  assert.ok(list.json.residents.length >= 5);
  const withPhotos = list.json.residents.find((r) => r.name === 'Maria Santos');
  assert.equal(withPhotos.idPhoto, '');
  assert.equal(withPhotos.idPhotoOnFile, true);
  assert.equal(withPhotos.password, undefined);
  const noId = list.json.residents.find((r) => r.name === 'Sneaky Person');
  assert.equal(noId.idPhotoOnFile, false);

  const full = await call('GET', '/api/admin/residents/' + noId.id, undefined, token);
  assert.ok(full.json.resident.facePhoto.startsWith('data:image'));

  const v = await call('POST', '/api/admin/residents/' + noId.id + '/verify', { verified: true }, token);
  assert.equal(v.json.resident.verified, true);
  assert.equal(v.json.resident.verifiedBy, 'Registry Admin');
  assert.equal(v.json.resident.verificationSource, 'admin-approved');
  const back = await call('POST', '/api/admin/residents/' + noId.id + '/verify', { verified: false }, token);
  assert.equal(back.json.resident.verified, false);
  assert.equal((await call('GET', '/api/admin/residents/BAC-0000-0000', undefined, token)).status, 404);

  // a resident's token must never open admin doors (and vice versa)
  const resident = (await call('POST', '/api/login', { identifier: '09171234567', password: 'password123' })).json;
  assert.equal((await call('GET', '/api/admin/residents', undefined, resident.token)).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, token)).status, 401);
  assert.equal((await call('GET', '/api/admin/residents')).status, 401);
});

test('admin sign-up needs the secret code; usernames are unique; staff cannot wipe the registry', async () => {
  const body = { name: 'Juana Staff', username: 'juana', phone: '09175550000', password: 'staffpass123', code: 'wrong' };
  assert.equal((await call('POST', '/api/admin/register', body)).status, 403);
  assert.equal((await call('POST', '/api/admin/register', { ...body, code: 'staff-code', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/admin/register', { ...body, code: 'staff-code', username: 'a b' })).status, 400);
  assert.equal((await call('POST', '/api/admin/register', { ...body, code: 'staff-code' })).status, 200);
  app.limiter.reset(); // (sign-up is limited to 5 tries per hour per visitor; start fresh for the next checks)
  assert.equal((await call('POST', '/api/admin/register', { ...body, code: 'staff-code' })).status, 409);
  assert.equal((await call('POST', '/api/admin/register', { ...body, code: 'staff-code', username: 'admin' })).status, 409);

  const staff = (await call('POST', '/api/admin/login', { username: 'juana', password: 'staffpass123' })).json;
  assert.equal(staff.admin.role, 'staff');
  assert.equal((await call('POST', '/api/admin/clear-residents', {}, staff.token)).status, 403);

  const prof = await call('POST', '/api/admin/profile', { name: 'Juana D. Staff', phone: '09175551111' }, staff.token);
  assert.equal(prof.json.admin.name, 'Juana D. Staff');
  assert.equal((await call('POST', '/api/admin/change-password', { current: 'nope', password: 'brandnew123' }, staff.token)).status, 400);
  assert.equal((await call('POST', '/api/admin/change-password', { current: 'staffpass123', password: 'brandnew123' }, staff.token)).status, 200);
  assert.equal((await call('POST', '/api/admin/login', { username: 'juana', password: 'brandnew123' })).status, 200);
});

test('guessing the admin access code is rate limited', async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await call('POST', '/api/admin/register', { name: 'Guess Er', username: 'guesser', password: 'longenough1', code: 'try' + i });
  assert.equal(last.status, 429);
});

test('admin sign-up is closed entirely when no code is configured', async () => {
  const closed = await createApp({ databaseUrl: '', sqliteFile: ':memory:', adminPassword: ADMIN_PW, adminSignupCode: '' });
  const port = await closed.listen(0);
  const res = await fetch('http://127.0.0.1:' + port + '/api/admin/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X Y', username: 'xyz', password: 'longenough1', code: '' })
  });
  assert.equal(res.status, 403);
  await closed.close();
});

test('main admin can clear the registry', async () => {
  const token = (await call('POST', '/api/admin/login', { username: 'admin', password: ADMIN_PW })).json.token;
  assert.equal((await call('POST', '/api/admin/clear-residents', {}, token)).status, 200);
  assert.equal((await call('GET', '/api/admin/residents', undefined, token)).json.residents.length, 0);
  assert.equal((await call('POST', '/api/login', { identifier: '09171234567', password: 'password123' })).status, 401);
  // ID numbers start again from 1000
  const again = await call('POST', '/api/register', residentBody({ phone: '09171234567' }));
  assert.match(again.json.resident.id, /-1000$/);
});

test('web pages are served, API misses are JSON, and path traversal is blocked', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Bacolor Population Registry/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(base + '/admin')).status, 200);
  assert.equal((await fetch(base + '/CSS/Portal.css')).status, 200);
  assert.equal((await fetch(base + '/forgot.html')).status, 200);
  assert.equal((await fetch(base + '/nope.html')).status, 404);
  assert.equal((await fetch(base + '/api/nope')).status, 404);
  assert.equal((await fetch(base + '/api/login')).status, 405);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const evil = await fetch(base + '/..%2Fserver%2Fdb.js');
  assert.equal(evil.status, 404);
  const evil2 = await fetch(base + '/%2e%2e/package.json');
  assert.equal(evil2.status, 404);
  const bad = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});
