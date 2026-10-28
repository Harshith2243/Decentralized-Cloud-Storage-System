const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../app");
const { makeContainer, FakeProvider, testConfig, CID_V0, CID_V1 } = require("./helpers");

function setup(configOver) {
  const provider = new FakeProvider();
  const app = createApp({ config: testConfig(configOver), provider });
  return { provider, app };
}
const upload = (app, buf, name = "encrypted.bin") => request(app).post("/api/storage/upload").attach("file", buf, name);

test("existing /health route still works", async () => {
  const { app } = setup();
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});

test("valid encrypted container uploads and returns the provider-confirmed CID", async () => {
  const { app, provider } = setup();
  const container = makeContainer();
  const res = await upload(app, container);
  assert.equal(res.status, 201);
  assert.equal(res.body.cid, CID_V1);
  assert.equal(res.body.size, container.length);
  assert.equal(res.body.metadata.algorithm, "AES-256-GCM");
  assert.equal(provider.uploads.length, 1);
  assert.ok(provider.uploads[0].equals(container), "provider received exactly the encrypted bytes");
});

test("response never contains key material", async () => {
  const { app } = setup();
  const res = await upload(app, makeContainer());
  assert.doesNotMatch(JSON.stringify(res.body), /key/i);
});

test("rejects a request with no file", async () => {
  const { app } = setup();
  const res = await request(app).post("/api/storage/upload").send({ hello: "world" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "NO_FILE");
});

test("rejects plaintext / non-container uploads and never calls the provider", async () => {
  const { app, provider } = setup();
  const res = await upload(app, Buffer.from("this is a plaintext document"), "secret.txt");
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "INVALID_CONTAINER");
  assert.equal(provider.uploads.length, 0);
});

test("rejects headers with extra fields such as an encryption key", async () => {
  const { app, provider } = setup();
  for (const extra of [{ key: "AAAA" }, { encryptionKey: "x" }, { rawKey: "y" }]) {
    const res = await upload(app, makeContainer({ headerOverrides: extra }));
    assert.equal(res.status, 422, JSON.stringify(extra));
  }
  assert.equal(provider.uploads.length, 0);
});

test("rejects inconsistent sizes, bad IV, wrong algorithm, truncated payload", async () => {
  const { app } = setup();
  const cases = [
    makeContainer({ headerOverrides: { encryptedSize: 999 } }),
    makeContainer({ headerOverrides: { iv: "short" } }),
    makeContainer({ headerOverrides: { algorithm: "AES-128-CBC" } }),
    makeContainer().subarray(0, 60),
    Buffer.from("DCSENC01"),
  ];
  for (const buf of cases) assert.equal((await upload(app, buf)).status, 422);
});

test("enforces the configured upload size limit", async () => {
  const { app, provider } = setup({ maxUploadBytes: 512 });
  const res = await upload(app, makeContainer({ plainSize: 2000 }));
  assert.equal(res.status, 413);
  assert.equal(res.body.code, "FILE_TOO_LARGE");
  assert.equal(provider.uploads.length, 0);
});

test("rejects extra form fields and multiple files", async () => {
  const { app } = setup();
  const r1 = await request(app).post("/api/storage/upload").field("note", "x").attach("file", makeContainer(), "a.bin");
  assert.equal(r1.status, 400);
  const r2 = await request(app).post("/api/storage/upload").attach("file", makeContainer(), "a.bin").attach("file", makeContainer(), "b.bin");
  assert.equal(r2.status, 400);
});

test("provider failures are reported honestly with proper status codes", async () => {
  const { app, provider } = setup();
  const expected = { UNAVAILABLE: 503, TIMEOUT: 504, AUTH: 502, BAD_RESPONSE: 502 };
  for (const [code, status] of Object.entries(expected)) {
    provider.fail = code;
    const res = await upload(app, makeContainer());
    assert.equal(res.status, status, code);
    assert.ok(!res.body.cid, "no CID may be returned on failure");
    assert.doesNotMatch(JSON.stringify(res.body), /secret-token-123|boom|stack/);
  }
});

test("retrieval returns the exact encrypted bytes (streamed)", async () => {
  const { app, provider } = setup();
  const container = makeContainer({ plainSize: 500 });
  await upload(app, container);
  const res = await request(app).get(`/api/storage/${CID_V1}`).buffer(true).parse((r, cb) => {
    const parts = [];
    r.on("data", (d) => parts.push(d));
    r.on("end", () => cb(null, Buffer.concat(parts)));
  });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/octet-stream/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.ok(res.body.equals(container));
  assert.ok(provider.store.has(CID_V1));
});

test("retrieval rejects invalid CIDs before touching the provider", async () => {
  const { app, provider } = setup();
  let touched = false;
  provider.retrieveEncryptedFile = async () => { touched = true; };
  for (const bad of ["abc", "../etc/passwd", "http://evil.example/x", CID_V0 + "x"]) {
    const res = await request(app).get(`/api/storage/${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.code, "INVALID_CID");
  }
  assert.equal(touched, false);
});

test("retrieval: unknown CID -> 404, provider down -> 503, timeout -> 504", async () => {
  const { app, provider } = setup();
  assert.equal((await request(app).get(`/api/storage/${CID_V0}`)).status, 404);
  provider.fail = "UNAVAILABLE";
  assert.equal((await request(app).get(`/api/storage/${CID_V0}`)).status, 503);
  provider.fail = "TIMEOUT";
  assert.equal((await request(app).get(`/api/storage/${CID_V0}`)).status, 504);
});

test("retrieval refuses to serve content that is not an encrypted container", async () => {
  const { app, provider } = setup();
  provider.store.set(CID_V0, Buffer.from("<html>some arbitrary public IPFS content</html>"));
  const res = await request(app).get(`/api/storage/${CID_V0}`);
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "NOT_ENCRYPTED_CONTAINER");
});

test("info endpoint returns size; health reports provider state", async () => {
  const { app, provider } = setup();
  await upload(app, makeContainer());
  const info = await request(app).get(`/api/storage/${CID_V1}/info`);
  assert.equal(info.status, 200);
  assert.ok(info.body.size > 0);
  assert.equal((await request(app).get("/api/storage/health")).status, 200);
  provider.healthy = false;
  const down = await request(app).get("/api/storage/health");
  assert.equal(down.status, 503);
  assert.equal(down.body.reachable, false);
});

test("unknown routes and unexpected errors do not leak internals", async () => {
  const { app, provider } = setup();
  assert.equal((await request(app).get("/nope")).status, 404);
  provider.uploadEncryptedFile = async () => { throw new Error("db password=hunter2 at /srv/app.js:42"); };
  const res = await upload(app, makeContainer());
  assert.equal(res.status, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /hunter2|srv|\.js/);
});

test("CORS only allows the configured origin; rate limit applies", async () => {
  const { app } = setup();
  const ok = await request(app).get("/api/storage/health").set("Origin", "http://localhost:5173");
  assert.equal(ok.headers["access-control-allow-origin"], "http://localhost:5173");
  const evil = await request(app).get("/api/storage/health").set("Origin", "http://evil.example");
  assert.equal(evil.headers["access-control-allow-origin"], undefined);

  const limited = createApp({ config: testConfig({ rateLimitPerMinute: 2 }), provider: new FakeProvider() });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await request(limited).get("/api/storage/health")).status);
  assert.deepEqual(statuses.slice(2), [429, 429]);
});
