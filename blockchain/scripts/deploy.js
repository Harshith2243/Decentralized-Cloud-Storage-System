const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying FileStorage with account:", deployer.address);

  const FileStorage = await hre.ethers.getContractFactory("FileStorage");
  const fileStorage = await FileStorage.deploy();
  await fileStorage.waitForDeployment();

  const address = await fileStorage.getAddress();
  console.log("FileStorage deployed to:", address);
  console.log("\nNext steps:");
  console.log("1. Copy this address into backend/config and frontend/src/utils as CONTRACT_ADDRESS");
  console.log("2. Copy artifacts/contracts/FileStorage.sol/FileStorage.json ABI to frontend/backend");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
