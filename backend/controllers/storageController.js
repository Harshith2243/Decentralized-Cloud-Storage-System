const { Readable, Transform, pipeline } = require("stream");
const { HttpError } = require("../utils/errors");
const { validateEncryptedContainer, hasContainerSignature } = require("../utils/container");
const { ProviderError } = require("../providers/IpfsProvider");

const PROVIDER_ERRORS = {
  UNAVAILABLE: [503, "STORAGE_UNAVAILABLE", "The storage service is currently unavailable. Nothing was stored."],
  TIMEOUT: [504, "STORAGE_TIMEOUT", "The storage service timed out."],
  NOT_FOUND: [404, "NOT_FOUND", "No content was found for this CID."],
  AUTH: [502, "STORAGE_MISCONFIGURED", "The storage service is misconfigured on the server."],
  BAD_RESPONSE: [502, "STORAGE_ERROR", "The storage service returned an unexpected response."],
};

function toHttpError(err) {
  if (err instanceof ProviderError) {
    const [status, code, message] = PROVIDER_ERRORS[err.code] || PROVIDER_ERRORS.BAD_RESPONSE;
    return new HttpError(status, code, message);
  }
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new HttpError(504, "STORAGE_TIMEOUT", PROVIDER_ERRORS.TIMEOUT[2]);
  }
  return err;
}

function requireValidCid(provider, cid) {
  if (!provider.validateCID(cid)) throw new HttpError(400, "INVALID_CID", "The CID is not valid.");
}

function createStorageController({ config, provider }) {
  return {
    async health(req, res) {
      const { reachable } = await provider.checkHealth();
      res.status(reachable ? 200 : 503).json({
        status: reachable ? "ok" : "unavailable",
        provider: provider.name,
        reachable,
        maxUploadBytes: config.maxUploadBytes,
      });
    },

    async upload(req, res) {
      if (!req.file) throw new HttpError(400, "NO_FILE", 'Send the encrypted file as multipart field "file".');
      const metadata = validateEncryptedContainer(req.file.buffer); // 422 if not a valid encrypted container
      try {
        const { cid, size } = await provider.uploadEncryptedFile(req.file.buffer);
        // Reaching this line means the provider confirmed the upload with a CID.
        res.status(201).json({ cid, size, provider: provider.name, metadata });
      } catch (err) {
        throw toHttpError(err);
      }
    },

    async info(req, res) {
      requireValidCid(provider, req.params.cid);
      try {
        res.json(await provider.getFileMetadata(req.params.cid));
      } catch (err) {
        throw toHttpError(err);
      }
    },

    async retrieve(req, res) {
      const { cid } = req.params;
      requireValidCid(provider, cid);

      let stream;
      try {
        ({ stream } = await provider.retrieveEncryptedFile(cid));
      } catch (err) {
        throw toHttpError(err);
      }
      res.on("close", () => stream.destroy()); // client went away: stop pulling from the provider

      // Peek at the first bytes: only serve content that is an encrypted container.
      const iterator = stream[Symbol.asyncIterator]();
      let head = Buffer.alloc(0);
      try {
        while (head.length < 12) {
          const { value, done } = await iterator.next();
          if (done) break;
          head = Buffer.concat([head, value]);
        }
      } catch (err) {
        stream.destroy();
        throw toHttpError(err instanceof ProviderError ? err : new ProviderError(err?.name === "TimeoutError" || err?.name === "AbortError" ? "TIMEOUT" : "UNAVAILABLE", ""));
      }
      if (!hasContainerSignature(head)) {
        stream.destroy();
        throw new HttpError(422, "NOT_ENCRYPTED_CONTAINER", "This CID does not contain an encrypted file created by this application.");
      }

      let sent = 0;
      const limiter = new Transform({
        transform(chunk, _enc, cb) {
          sent += chunk.length;
          if (sent > config.maxUploadBytes) return cb(new Error("size limit exceeded"));
          cb(null, chunk);
        },
      });
      async function* body() {
        yield head;
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) return;
          yield value;
        }
      }

      res.status(200);
      res.set({
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      pipeline(Readable.from(body()), limiter, res, (err) => {
        if (err) {
          console.error(`[storage] retrieval aborted: ${err.message}`);
          res.destroy(); // headers already sent: cut the connection so the client sees a failure
        }
      });
    },
  };
}

module.exports = { createStorageController };
