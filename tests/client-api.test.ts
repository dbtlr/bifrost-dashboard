import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ApiError, createApp, getCatalog } from '../src/api.ts';

const base = 'https://dashboard.example.test/start/';
const home = { id: 9, name: 'Home', url: 'https://home.example.test', icon: 'icons/home.svg', groupId: null };

// The client resolves API paths against the page, so tests give it a minimal document and a fake fetch.
function stub(t: TestContext, respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  Object.defineProperty(globalThis, 'document', { value: { baseURI: base }, configurable: true });
  t.after(() => { Reflect.deleteProperty(globalThis, 'document'); });
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  });
  return calls;
}

test('reads the catalog from the API with revalidation and a ten-second timeout', async t => {
  let count = 0;
  const calls = stub(t, () => new Response(JSON.stringify({ revision: ++count, groups: [], ungrouped: [home] })));
  const first = await getCatalog();
  assert.equal(first.revision, 1);
  assert.equal(first.ungrouped[0]?.icon, `${base}icons/home.svg`, 'icons resolve against the dashboard root');
  assert.equal((await getCatalog()).revision, 2);
  assert.equal(calls[0]?.url, `${base}api/catalog`);
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.cache, 'no-cache');
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
});

test('catalog failures keep the server’s message and reject malformed bodies and network errors', async t => {
  let respond: () => Response | Promise<Response> = () => new Response(JSON.stringify({ error: 'Database is locked.' }), { status: 503 });
  stub(t, () => respond());
  await assert.rejects(getCatalog(), error => error instanceof ApiError && error.status === 503 && error.message === 'Database is locked.');
  respond = () => new Response('{unfinished');
  await assert.rejects(getCatalog());
  respond = () => new Response(JSON.stringify({ groups: [], ungrouped: [] }));
  await assert.rejects(getCatalog(), /revision/);
  respond = () => { throw new TypeError('Network unavailable'); };
  await assert.rejects(getCatalog(), error => error instanceof ApiError && error.status === 0);
});

test('a created app is validated before it is used', async t => {
  let body: unknown = { ...home, id: 12 };
  const calls = stub(t, () => new Response(JSON.stringify(body), { status: 201 }));
  const created = await createApp({ name: 'Home', url: 'https://home.example.test', groupId: null });
  assert.equal(created.id, 12);
  assert.equal(created.domain, 'home.example.test');
  assert.equal(calls[0]?.url, `${base}api/apps`);
  assert.equal(calls[0]?.init?.method, 'POST');
  for (body of [{ ...home, id: 'x' }, { ...home, id: 0 }, {}, null]) {
    await assert.rejects(createApp({ name: 'Home', url: 'https://home.example.test', groupId: null }));
  }
});
