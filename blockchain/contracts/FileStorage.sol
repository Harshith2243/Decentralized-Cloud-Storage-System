// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title FileStorage
/// @notice Stores ONLY file metadata (never raw file bytes, never encryption keys).
///         The actual encrypted file lives on IPFS/Filecoin; this contract stores
///         the CID pointer plus ownership and access-control state.
contract FileStorage {
    // ---------------------------------------------------------------------
    // Data structures
    // ---------------------------------------------------------------------

    struct FileMeta {
        uint256 id;          // unique file id
        address owner;       // wallet that uploaded the file
        string cid;          // IPFS/Filecoin content identifier of the ENCRYPTED file
        string fileName;     // original file name (optional, for UI display)
        uint256 fileSize;    // size in bytes (optional, for UI display)
        uint256 uploadedAt;  // block timestamp of upload
        bool exists;         // existence flag, since structs default to zero values
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint256 private nextFileId = 1;

    // fileId => file metadata
    mapping(uint256 => FileMeta) private files;

    // fileId => address => hasAccess
    mapping(uint256 => mapping(address => bool)) private accessList;

    // owner => list of fileIds they uploaded (for "my files" views)
    mapping(address => uint256[]) private filesByOwner;

    // ---------------------------------------------------------------------
    // Events — the frontend listens to these for tx history / notifications
    // ---------------------------------------------------------------------

    event FileUploaded(
        uint256 indexed fileId,
        address indexed owner,
        string cid,
        string fileName,
        uint256 timestamp
    );

    event AccessShared(
        uint256 indexed fileId,
        address indexed owner,
        address indexed grantedTo,
        uint256 timestamp
    );

    event AccessRevoked(
        uint256 indexed fileId,
        address indexed owner,
        address indexed revokedFrom,
        uint256 timestamp
    );

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner(uint256 fileId) {
        require(files[fileId].exists, "FileStorage: file does not exist");
        require(files[fileId].owner == msg.sender, "FileStorage: caller is not the file owner");
        _;
    }

    modifier fileExists(uint256 fileId) {
        require(files[fileId].exists, "FileStorage: file does not exist");
        _;
    }

    // ---------------------------------------------------------------------
    // Core functions
    // ---------------------------------------------------------------------

    /// @notice Register metadata for a newly uploaded (already encrypted, already
    ///         pinned to IPFS) file. The owner automatically has access.
    function uploadFile(
        string calldata cid,
        string calldata fileName,
        uint256 fileSize
    ) external returns (uint256) {
        require(bytes(cid).length > 0, "FileStorage: CID cannot be empty");

        uint256 fileId = nextFileId++;

        files[fileId] = FileMeta({
            id: fileId,
            owner: msg.sender,
            cid: cid,
            fileName: fileName,
            fileSize: fileSize,
            uploadedAt: block.timestamp,
            exists: true
        });

        accessList[fileId][msg.sender] = true;
        filesByOwner[msg.sender].push(fileId);

        emit FileUploaded(fileId, msg.sender, cid, fileName, block.timestamp);
        return fileId;
    }

    /// @notice Grant another wallet access to a file. Only the owner may call this.
    function shareFile(uint256 fileId, address grantee) external onlyOwner(fileId) {
        require(grantee != address(0), "FileStorage: invalid address");
        require(grantee != msg.sender, "FileStorage: owner already has access");

        accessList[fileId][grantee] = true;
        emit AccessShared(fileId, msg.sender, grantee, block.timestamp);
    }

    /// @notice Revoke a previously granted wallet's access. Only the owner may call this.
    function revokeAccess(uint256 fileId, address grantee) external onlyOwner(fileId) {
        require(grantee != msg.sender, "FileStorage: owner cannot revoke their own access");
        require(accessList[fileId][grantee], "FileStorage: address does not have access");

        accessList[fileId][grantee] = false;
        emit AccessRevoked(fileId, msg.sender, grantee, block.timestamp);
    }

    /// @notice Check whether an address currently has access to a file.
    function hasAccess(uint256 fileId, address user) public view fileExists(fileId) returns (bool) {
        return accessList[fileId][user];
    }

    /// @notice Fetch file metadata. Reverts if the caller does not have access,
    ///         so the CID pointer itself is access-gated on-chain.
    function getFile(uint256 fileId)
        external
        view
        fileExists(fileId)
        returns (
            uint256 id,
            address owner,
            string memory cid,
            string memory fileName,
            uint256 fileSize,
            uint256 uploadedAt
        )
    {
        require(hasAccess(fileId, msg.sender), "FileStorage: caller does not have access");

        FileMeta storage f = files[fileId];
        return (f.id, f.owner, f.cid, f.fileName, f.fileSize, f.uploadedAt);
    }

    /// @notice Convenience view for "My Files" dashboards.
    function getFilesByOwner(address owner) external view returns (uint256[] memory) {
        return filesByOwner[owner];
    }

    /// @notice Total number of files ever uploaded (id counter - 1).
    function totalFiles() external view returns (uint256) {
        return nextFileId - 1;
    }
}
