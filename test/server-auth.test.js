import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = 24000 + Math.floor(Math.random() * 20000);
const baseUrl = `http://127.0.0.1:${port}`;

function launchServer(extraEnv = {}) {
  return spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      APP_PASSWORD: '',
      GEMINI_API_KEY: 'test-only-key',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForHealth(child, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before becoming healthy.');
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response;
    } catch {}
    await delay(100);
  }
  throw new Error('Server did not become healthy in time.');
}

test('production refuses to start without an authentication mechanism', async () => {
  const child = launchServer();
  let output = '';
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdout.on('data', chunk => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Server unexpectedly stayed alive without production authentication.'));
    }, 5000);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.notEqual(exitCode, 0);
  assert.match(output, /Production ortamında Supabase hesap sistemi veya APP_PASSWORD yapılandırılmalı/);
});

test('password-protected production API rejects anonymous analysis and supports session logout', async () => {
  const child = launchServer({ APP_PASSWORD: 'test-password' });
  try {
    const health = await waitForHealth(child);
    const healthData = await health.json();
    assert.equal(healthData.protected, true);

    const anonymousAnalysis = await fetch(`${baseUrl}/api/analyze`, { method: 'POST' });
    assert.equal(anonymousAnalysis.status, 401);

    const wrongLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' })
    });
    assert.equal(wrongLogin.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'successful login must issue a session cookie');

    const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
    assert.equal((await session.json()).authenticated, true);

    const authorizedButInvalidAnalysis = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(authorizedButInvalidAnalysis.status, 400);

    await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { cookie } });
    const afterLogout = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
    assert.equal((await afterLogout.json()).authenticated, false);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      delay(2000).then(() => child.kill('SIGKILL'))
    ]);
  }
});
