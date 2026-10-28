const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("FileStorage", function () {
  let fileStorage;
  let owner, other, stranger;

  const CID = "bafybeigdyrztgqvxyqxyqxy_test_cid";
  const FILE_NAME = "resume.pdf";
  const FILE_SIZE = 204800; // 200 KB

  beforeEach(async function () {
    [owner, other, stranger] = await ethers.getSigners();
    const FileStorage = await ethers.getContractFactory("FileStorage");
    fileStorage = await FileStorage.deploy();
    await fileStorage.waitForDeployment();
  });

  it("uploads a file and stores correct metadata", async function () {
    const tx = await fileStorage.connect(owner).uploadFile(CID, FILE_NAME, FILE_SIZE);
    await expect(tx).to.emit(fileStorage, "FileUploaded");

    const [id, fileOwner, cid, fileName, fileSize] = await fileStorage
      .connect(owner)
      .getFile(1);

    expect(id).to.equal(1);
    expect(fileOwner).to.equal(owner.address);
    expect(cid).to.equal(CID);
    expect(fileName).to.equal(FILE_NAME);
    expect(fileSize).to.equal(FILE_SIZE);
  });

  it("rejects an empty CID", async function () {
    await expect(
      fileStorage.connect(owner).uploadFile("", FILE_NAME, FILE_SIZE)
    ).to.be.revertedWith("FileStorage: CID cannot be empty");
  });

  it("owner automatically has access after upload", async function () {
    await fileStorage.connect(owner).uploadFile(CID, FILE_NAME, FILE_SIZE);
    expect(await fileStorage.hasAccess(1, owner.address)).to.equal(true);
  });

  it("a non-owner cannot read file metadata before being granted access", async function () {
    await fileStorage.connect(owner).uploadFile(CID, FILE_NAME, FILE_SIZE);
    await expect(fileStorage.connect(other).getFile(1)).to.be.revertedWith(
      "FileStorage: caller does not have access"
    );
  });

  it("owner can share access, and grantee can then read metadata", async function () {
    await fileStorage.connect(owner).uploadFile(CID, FILE_NAME, FILE_SIZE);

    await expect(fileStorage.connect(owner).shareFile(1, other.address))
      .to.emit(fileStorage, "AccessShared")
      .withArgs(1, owner.address, other.address, anyValue);

    expect(await fileStorage.hasAccess(1, other.address)).to.equal(true);

    const [, fileOwner] = await fileStorage.connect(other).getFile(1);
    expect(fileOwner).to.equal(owner.address);
  });

  it("a non-owner cannot share access to a file they don't own", async function () {
    await fileStorage.connect(owner).uploadFile(CID, FILE_NAME, FILE_SIZE);
    await expect(
      fileStorage.connect(stranger).shareFile(1, other.address)
    ).to.be.revertedWith("FileStorage: caller is not the file owner");
  });

  it("owner can revoke previously granted access", async function () {
    await fileStorage.connect(owner).uploadFile(CID, FILE_NAME, FILE_SIZE);
    await fileStorage.connect(owner).shareFile(1, other.address);

    await expect(fileStorage.connect(owner).revokeAccess(1, other.address)).to.emit(
      fileStorage,
      "AccessRevoked"
    );

    expect(await fileStorage.hasAccess(1, other.address)).to.equal(false);
    await expect(fileStorage.connect(other).getFile(1)).to.be.revertedWith(
      "FileStorage: caller does not have access"
    );
  });

  it("reverts when revoking access that was never granted", async function () {
    await fileStorage.connect(owner).uploadFile(CID, FILE_NAME, FILE_SIZE);
    await expect(
      fileStorage.connect(owner).revokeAccess(1, other.address)
    ).to.be.revertedWith("FileStorage: address does not have access");
  });

  it("owner cannot revoke their own access (regression: self-revocation bug)", async function () {
    await fileStorage.connect(owner).uploadFile(CID, FILE_NAME, FILE_SIZE);
    // Owner should still have access before the attempt
    expect(await fileStorage.hasAccess(1, owner.address)).to.equal(true);
    // Attempting self-revocation must revert
    await expect(
      fileStorage.connect(owner).revokeAccess(1, owner.address)
    ).to.be.revertedWith("FileStorage: owner cannot revoke their own access");
    // Owner must still have access after the failed attempt
    expect(await fileStorage.hasAccess(1, owner.address)).to.equal(true);
  });

  it("tracks files by owner", async function () {
    await fileStorage.connect(owner).uploadFile(CID, "a.txt", 10);
    await fileStorage.connect(owner).uploadFile(CID, "b.txt", 20);
    const ids = await fileStorage.getFilesByOwner(owner.address);
    expect(ids.map((x) => Number(x))).to.deep.equal([1, 2]);
  });

  it("reverts on operations against a non-existent file", async function () {
    await expect(fileStorage.connect(owner).getFile(999)).to.be.revertedWith(
      "FileStorage: file does not exist"
    );
  });
});
