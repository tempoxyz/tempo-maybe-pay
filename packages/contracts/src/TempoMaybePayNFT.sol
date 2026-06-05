// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Owned} from "./Owned.sol";

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

contract TempoMaybePayNFT is Owned {
    string public name;
    string public symbol;
    address public store;
    uint256 public nextTokenId = 1;

    mapping(uint256 tokenId => address owner) public ownerOf;
    mapping(address owner => uint256 balance) public balanceOf;
    mapping(uint256 tokenId => address approved) public getApproved;
    mapping(address owner => mapping(address operator => bool approved)) public isApprovedForAll;
    mapping(uint256 tokenId => uint256 productId) public tokenProduct;
    mapping(uint256 tokenId => string uri) private tokenUris;
    mapping(address owner => uint256[] tokenIds) private ownedTokens;
    mapping(uint256 tokenId => uint256 index) private ownedTokenIndex;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event StoreUpdated(address indexed store);

    error NotStore();
    error InvalidToken();
    error NotApproved();

    constructor(string memory name_, string memory symbol_, address initialOwner) Owned(initialOwner) {
        name = name_;
        symbol = symbol_;
    }

    function setStore(address store_) external onlyOwner {
        if (store_ == address(0)) revert ZeroAddress();
        store = store_;
        emit StoreUpdated(store_);
    }

    function mint(address to, uint256 productId, string calldata uri) external returns (uint256 tokenId) {
        if (msg.sender != store) revert NotStore();
        if (to == address(0)) revert ZeroAddress();

        tokenId = nextTokenId++;
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        _addOwnedToken(to, tokenId);
        tokenProduct[tokenId] = productId;
        tokenUris[tokenId] = uri;
        emit Transfer(address(0), to, tokenId);
    }

    function tokensOfOwner(address owner) external view returns (uint256[] memory) {
        return ownedTokens[owner];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (ownerOf[tokenId] == address(0)) revert InvalidToken();
        return tokenUris[tokenId];
    }

    function approve(address approved, uint256 tokenId) external {
        address tokenOwner = ownerOf[tokenId];
        if (tokenOwner == address(0)) revert InvalidToken();
        if (msg.sender != tokenOwner && !isApprovedForAll[tokenOwner][msg.sender]) revert NotApproved();
        getApproved[tokenId] = approved;
        emit Approval(tokenOwner, approved, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotApproved();
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            bytes4 result = IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data);
            if (result != IERC721Receiver.onERC721Received.selector) revert NotApproved();
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) private view returns (bool) {
        address tokenOwner = ownerOf[tokenId];
        return tokenOwner != address(0)
            && (spender == tokenOwner || spender == getApproved[tokenId] || isApprovedForAll[tokenOwner][spender]);
    }

    function _transfer(address from, address to, uint256 tokenId) private {
        if (to == address(0)) revert ZeroAddress();
        if (ownerOf[tokenId] != from) revert InvalidToken();

        delete getApproved[tokenId];
        _removeOwnedToken(from, tokenId);
        _addOwnedToken(to, tokenId);
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _addOwnedToken(address to, uint256 tokenId) private {
        ownedTokenIndex[tokenId] = ownedTokens[to].length;
        ownedTokens[to].push(tokenId);
    }

    function _removeOwnedToken(address from, uint256 tokenId) private {
        uint256 lastIndex = ownedTokens[from].length - 1;
        uint256 tokenIndex = ownedTokenIndex[tokenId];

        if (tokenIndex != lastIndex) {
            uint256 lastTokenId = ownedTokens[from][lastIndex];
            ownedTokens[from][tokenIndex] = lastTokenId;
            ownedTokenIndex[lastTokenId] = tokenIndex;
        }

        ownedTokens[from].pop();
        delete ownedTokenIndex[tokenId];
    }
}
