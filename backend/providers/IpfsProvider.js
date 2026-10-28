// Storage provider interface. Controllers depend only on this contract, so the
// backing service (local Kubo node, a pinning service, ...) can change without
// touching routes or the React UI.
const { isValidCID } = require("../utils/cid");

// code: UNAVAILABLE | TIMEOUT | NOT_FOUND | AUTH | BAD_RESPONSE
class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

class IpfsProvider {
  get name() {
    throw new Error("not implemented");
  }

  validateCID(cid) {
    return isValidCID(cid);
  }

  /** @param {Buffer} buffer encrypted bytes  @returns {Promise<{cid:string,size:number}>} */
  async uploadEncryptedFile(_buffer) {
    throw new Error("not implemented");
  }

  /** @returns {Promise<{stream: import('stream').Readable}>} */
  async retrieveEncryptedFile(_cid) {
    throw new Error("not implemented");
  }

  /** @returns {Promise<{cid:string,size:number}>} */
  async getFileMetadata(_cid) {
    throw new Error("not implemented");
  }

  /** @returns {Promise<{reachable:boolean}>} must never throw */
  async checkHealth() {
    throw new Error("not implemented");
  }
}

module.exports = { IpfsProvider, ProviderError };
