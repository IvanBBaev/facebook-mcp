import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch } from './with-fetch.js';

test('records method, url, and lowercased headers of an outgoing request', async () => {
  await withFetch(async (mock) => {
    mock.enqueue({ json: { id: '1' } });
    const res = await fetch('https://graph.facebook.com/v21.0/me', {
      method: 'GET',
      headers: { Authorization: 'Bearer x', 'X-Test': 'y' },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: '1' });

    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.method, 'GET');
    assert.equal(req.url, 'https://graph.facebook.com/v21.0/me');
    assert.equal(req.headers['authorization'], 'Bearer x');
    assert.equal(req.headers['x-test'], 'y');
    assert.equal(req.body.kind, 'none');
  });
});

test('captures a JSON string body', async () => {
  await withFetch(async (mock) => {
    mock.enqueue({ json: {} });
    await fetch('https://graph.facebook.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', n: 2 }),
    });

    const body = mock.lastRequest()?.body;
    assert.equal(body?.kind, 'json');
    if (body?.kind === 'json') {
      assert.deepEqual(body.json, { message: 'hi', n: 2 });
    }
  });
});

test('captures a URLSearchParams (query) body', async () => {
  await withFetch(async (mock) => {
    mock.enqueue({ json: {} });
    await fetch('https://graph.facebook.com/x', {
      method: 'POST',
      body: new URLSearchParams({ message: 'hello world', published: 'false' }),
    });

    const body = mock.lastRequest()?.body;
    assert.equal(body?.kind, 'urlencoded');
    if (body?.kind === 'urlencoded') {
      assert.equal(body.params['message'], 'hello world');
      assert.equal(body.params['published'], 'false');
    }
  });
});

test('captures a multipart FormData body with file parts', async () => {
  await withFetch(async (mock) => {
    mock.enqueue({ json: {} });
    const form = new FormData();
    form.set('caption', 'a photo');
    form.set(
      'source',
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      'pic.png',
    );
    await fetch('https://graph.facebook.com/x/photos', { method: 'POST', body: form });

    const body = mock.lastRequest()?.body;
    assert.equal(body?.kind, 'formData');
    if (body?.kind === 'formData') {
      assert.equal(body.fields['caption'], 'a photo');
      assert.equal(body.files.length, 1);
      const file = body.files[0];
      assert.ok(file);
      assert.equal(file.field, 'source');
      assert.equal(file.filename, 'pic.png');
      assert.equal(file.contentType, 'image/png');
      assert.deepEqual([...file.bytes], [1, 2, 3]);
    }
  });
});

test('captures a raw binary (Uint8Array) rupload body', async () => {
  await withFetch(async (mock) => {
    mock.enqueue({ json: {} });
    await fetch('https://rupload.facebook.com/x', {
      method: 'POST',
      headers: { file_offset: '0' },
      body: new Uint8Array([9, 8, 7, 6]),
    });

    const body = mock.lastRequest()?.body;
    assert.equal(body?.kind, 'binary');
    if (body?.kind === 'binary') {
      assert.equal(body.byteLength, 4);
      assert.deepEqual([...body.bytes], [9, 8, 7, 6]);
    }
  });
});

test('captures an ArrayBuffer body', async () => {
  await withFetch(async (mock) => {
    mock.enqueue({ json: {} });
    await fetch('https://rupload.facebook.com/x', {
      method: 'POST',
      body: new Uint8Array([1, 2]).buffer,
    });

    const body = mock.lastRequest()?.body;
    assert.equal(body?.kind, 'binary');
    if (body?.kind === 'binary') {
      assert.deepEqual([...body.bytes], [1, 2]);
    }
  });
});

test('serves responses by matcher with custom status and headers', async () => {
  await withFetch(async (mock) => {
    mock.on((r) => r.url.endsWith('/me'), {
      json: { id: 'me' },
      headers: { 'x-app-usage': '{}' },
    });
    mock.on((r) => r.method === 'DELETE', { status: 204 });

    const a = await fetch('https://graph.facebook.com/me');
    assert.equal(a.headers.get('x-app-usage'), '{}');
    assert.deepEqual(await a.json(), { id: 'me' });

    const b = await fetch('https://graph.facebook.com/123', { method: 'DELETE' });
    assert.equal(b.status, 204);

    assert.equal(mock.requests.length, 2);
  });
});

test('returns a programmed binary response body', async () => {
  await withFetch(async (mock) => {
    mock.enqueue({
      bytes: new Uint8Array([1, 2, 3]),
      headers: { 'content-type': 'image/png' },
    });
    const res = await fetch('https://graph.facebook.com/photo');
    const bytes = new Uint8Array(await res.arrayBuffer());

    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.equal(res.headers.get('content-type'), 'image/png');
  });
});

test('restores the previous global fetch after the scope', async () => {
  const before = globalThis.fetch;
  await withFetch(async (mock) => {
    mock.enqueue({ json: {} });
    await fetch('https://graph.facebook.com/x');
  });
  assert.equal(globalThis.fetch, before);
});

test('rejects an unprogrammed request with a clear error', async () => {
  await assert.rejects(
    withFetch(async () => {
      await fetch('https://graph.facebook.com/unmatched');
    }),
    /unexpected request/,
  );
});
