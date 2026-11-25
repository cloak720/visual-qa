import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, validateUrl, routeSlug, safeResetDir } from '../capture.mjs';

test('redact: query-string secrets', () => {
  const out = redact('https://app.test/cb?code=abc123&state=ok&access_token=xyz&apiKey=k1');
  assert.ok(!/abc123|xyz|k1/.test(out), out);
  assert.match(out, /state=ok/);
});

test('redact: credentials in URL', () => {
  assert.equal(redact('postgres://admin:hunter2@db.local/app'), 'postgres://[REDACTED]@db.local/app');
});

test('redact: bearer tokens, JWTs, provider keys', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlMTIz';
  const out = redact(`Authorization: Bearer abc.def ${jwt} sk_live_ABCDEFGH12345678 AKIAABCDEFGHIJKLMNOP ghp_aaaaaaaaaaaaaaaaaaaaaaaa`);
  for (const leaked of ['abc.def', jwt, 'sk_live_ABCDEFGH12345678', 'AKIAABCDEFGHIJKLMNOP', 'ghp_aaaa']) {
    assert.ok(!out.includes(leaked), `leaked ${leaked}: ${out}`);
  }
});

test('validateUrl: only http, https, file', () => {
  assert.ok(validateUrl('http://localhost:3000'));
  assert.ok(validateUrl('file:///tmp/a.html'));
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'ftp://x', 'not a url']) {
    assert.throws(() => validateUrl(bad), undefined, bad);
  }
});

test('routeSlug: never escapes the output dir', () => {
  for (const r of ['/../../etc/passwd', '..\\..\\windows', '/a/../../b', 'file:///C:/x/../../y.html']) {
    const s = routeSlug(r);
    assert.match(s, /^[a-z0-9-]+$/, `${r} -> ${s}`);
  }
  assert.equal(routeSlug('/'), 'home');
});

test('safeResetDir: refuses to delete folders it did not create', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vqa-'));
  const foreign = path.join(base, 'latest');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'important.txt'), 'keep');
  assert.throws(() => safeResetDir(foreign));
  assert.ok(fs.existsSync(path.join(foreign, 'important.txt')));

  const own = path.join(base, 'own');
  safeResetDir(own);
  fs.writeFileSync(path.join(own, 'old.png'), 'x');
  safeResetDir(own); // second run may clear its own output
  assert.ok(!fs.existsSync(path.join(own, 'old.png')));
  fs.rmSync(base, { recursive: true, force: true });
});

test('safeResetDir: refuses root, home and cwd', () => {
  assert.throws(() => safeResetDir(path.parse(process.cwd()).root));
  assert.throws(() => safeResetDir(os.homedir()));
  assert.throws(() => safeResetDir(process.cwd()));
});
