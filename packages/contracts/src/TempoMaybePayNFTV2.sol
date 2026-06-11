// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Owned} from "./Owned.sol";

contract TempoMaybePayNFTV2 is Owned {
    string public name;
    string public symbol;
    string public baseURI;
    address public store;
    uint256 public nextTokenId = 1;

    mapping(uint256 tokenId => address owner) public ownerOf;
    mapping(address owner => uint256 balance) public balanceOf;
    mapping(uint256 tokenId => uint256 productId) public tokenProduct;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event StoreUpdated(address indexed store);
    event BaseURIUpdated(string baseURI);

    error InvalidToken();
    error NotStore();

    modifier onlyStore() {
        if (msg.sender != store) revert NotStore();
        _;
    }

    constructor(string memory name_, string memory symbol_, string memory baseURI_, address initialOwner)
        Owned(initialOwner)
    {
        name = name_;
        symbol = symbol_;
        baseURI = baseURI_;
    }

    function setStore(address store_) external onlyOwner {
        if (store_ == address(0)) revert ZeroAddress();
        store = store_;
        emit StoreUpdated(store_);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        baseURI = baseURI_;
        emit BaseURIUpdated(baseURI_);
    }

    function mint(address to, uint256 productId) external onlyStore returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();

        tokenId = nextTokenId++;
        ownerOf[tokenId] = to;
        unchecked {
            balanceOf[to] += 1;
        }
        tokenProduct[tokenId] = productId;

        emit Transfer(address(0), to, tokenId);
    }

    function storeTransferFrom(address from, address to, uint256 tokenId) external onlyStore {
        _transfer(from, to, tokenId);
    }

    function tokensOfOwner(address owner) external view returns (uint256[] memory tokenIds) {
        tokenIds = new uint256[](balanceOf[owner]);
        uint256 found;
        uint256 next = nextTokenId;
        for (uint256 tokenId = 1; tokenId < next; tokenId += 1) {
            if (ownerOf[tokenId] == owner) {
                tokenIds[found] = tokenId;
                found += 1;
            }
        }
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (ownerOf[tokenId] == address(0)) revert InvalidToken();
        return string.concat(baseURI, _toString(tokenProduct[tokenId]));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    function _transfer(address from, address to, uint256 tokenId) private {
        if (to == address(0)) revert ZeroAddress();
        if (ownerOf[tokenId] != from) revert InvalidToken();

        ownerOf[tokenId] = to;
        unchecked {
            balanceOf[from] -= 1;
            balanceOf[to] += 1;
        }
        emit Transfer(from, to, tokenId);
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";

        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits += 1;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            // forge-lint: disable-next-line(unsafe-typecast)
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
