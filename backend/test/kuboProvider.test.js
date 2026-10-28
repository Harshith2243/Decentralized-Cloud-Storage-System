const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { KuboProvider } = require("../providers/KuboProvider");
const { makeContainer, CID_V1 } = require("./helpers");

// Minimal mock of Kubo's documented HTTP RPC API (/api/v0/add, cat, files/stat, id).
// NOTE: this verifies our client against the documented contract, NOT a live node.
function startMockKubo(handlerOverrides = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const custom = handlerOverrides[url.pathname];
      if (custom) return custom(req, res, { url, body });
      if (req.method !== "POST") return res.writeHead(405).end();
      if (url.pathname === "/api/v0/add") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ Name: "encrypted.bin", Hash: CID_V1, Size: "123" }) + "\n");
      }
      if (url.pathname === "/api/v0/cat") return res.writeHead(200).end(Buffer.from("DCSENC01-payload"));
      if (url.pathname === "/api/v0/files/stat") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ Size: 99, Type: "file" }));
      if (url.pathname === "/api/v0/id") return res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })
    )
  );
}
const read = async (stream) => { const p = []; for await (const c of stream) p.push(c); return Buffer.concat(p); };

test("upload: posts multipart with pin + CIDv1, generic filename, returns CID", async () => {
  const mock = await startMockKubo();
  try {
    const provider = new KuboProvider({ apiUrl: mock.url });
    const container = makeContainer({ fileName: "private-passport.pdf" });
    const result = await provider.uploadEncryptedFile(container);
    assert.deepEqual(result, { cid: CID_V1, size: container.length });
    const call = mock.seen[0];
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/api/v0/add");
    assert.equal(call.query.pin, "true");
    assert.equal(call.query["cid-version"], "1");
    const text = call.body.toString("latin1");
    assert.match(text, /filename="encrypted\.bin"/);
    assert.doesNotMatch(text, /filename="[^"]*passport/); // original filename not used as the IPFS file name
    assert.ok(call.body.includes(container), "multipart body carries the exact encrypted bytes");
  } finally { await mock.close(); }
});

test("upload fails (never fake-succeeds) when the response has no valid CID", async () => {
  for (const payload of ["", "not json", JSON.stringify({ Hash: "garbage" })]) {
    const mock = await startMockKubo({ "/api/v0/add": (req, res) => res.writeHead(200).end(payload) });
    try {
      await assert.rejects(new KuboProvider({ apiUrl: mock.url }).uploadEncryptedFile(Buffer.from("x")), { code: "BAD_RESPONSE" });
    } finally { await mock.close(); }
  }
});

test("retrieve streams bytes and sends only the CID", async () => {
  const mock = await startMockKubo();
  try {
    const { stream } = await new KuboProvider({ apiUrl: mock.url }).retrieveEncryptedFile(CID_V1);
    assert.equal((await read(stream)).toString(), "DCSENC01-payload");
    assert.equal(mock.seen[0].path, "/api/v0/cat");
    assert.equal(mock.seen[0].query.arg, CID_V1);
  } finally { await mock.close(); }
});

test("metadata and health", async () => {
  const mock = await startMockKubo();
  try {
    const p = new KuboProvider({ apiUrl: mock.url });
    assert.deepEqual(await p.getFileMetadata(CID_V1), { cid: CID_V1, size: 99 });
    assert.equal(mock.seen[0].query.arg, `/ipfs/${CID_V1}`);
    assert.deepEqual(await p.checkHealth(), { reachable: true });
  } finally { await mock.close(); }
});

test("bearer token is forwarded to the configured API only when set", async () => {
  const mock = await startMockKubo();
  try {
    await new KuboProvider({ apiUrl: mock.url, apiToken: "tok-123" }).checkHealth();
    await new KuboProvider({ apiUrl: mock.url }).checkHealth();
    assert.equal(mock.seen[0].headers.authorization, "Bearer tok-123");
    assert.equal(mock.seen[1].headers.authorization, undefined);
  } finally { await mock.close(); }
});

test("error mapping: unreachable, 401, not found, 500, timeout", async () => {
  const dead = new KuboProvider({ apiUrl: "http://127.0.0.1:1", timeoutMs: 1500 });
  await assert.rejects(dead.uploadEncryptedFile(Buffer.from("x")), { code: "UNAVAILABLE" });
  assert.deepEqual(await dead.checkHealth(), { reachable: false });

  const mock = await startMockKubo({
    "/api/v0/add": (req, res) => res.writeHead(401).end("denied token=abc"),
    "/api/v0/cat": (req, res, { url }) =>
      url.searchParams.get("arg") === CID_V1
        ? res.writeHead(500).end(JSON.stringify({ Message: "merkledag: not found", Code: 0, Type: "error" }))
        : res.writeHead(500).end("kaboom"),
    "/api/v0/files/stat": () => { /* never answers */ },
  });
  try {
    const p = new KuboProvider({ apiUrl: mock.url, timeoutMs: 300 });
    await assert.rejects(p.uploadEncryptedFile(Buffer.from("x")), (e) => e.code === "AUTH" && !/abc/.test(e.message));
    await assert.rejects(p.retrieveEncryptedFile(CID_V1), { code: "NOT_FOUND" });
    await assert.rejects(p.retrieveEncryptedFile("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"), { code: "BAD_RESPONSE" });
    await assert.rejects(p.getFileMetadata(CID_V1), { code: "TIMEOUT" });
  } finally { await mock.close(); }
});
