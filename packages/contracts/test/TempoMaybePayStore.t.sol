// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockTIP20} from "./MockTIP20.sol";
import {TempoMaybePayNFT} from "../src/TempoMaybePayNFT.sol";
import {TempoMaybePayStore} from "../src/TempoMaybePayStore.sol";

interface Vm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert() external;
}

contract TempoMaybePayStoreTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockTIP20 private token;
    TempoMaybePayNFT private nft;
    TempoMaybePayStore private store;

    address private buyer = address(0xB0B);
    address private operator = address(0x0E0);
    address private merchant = address(0xA11CE);

    uint256 private constant PRODUCT_ID = 1;
    uint256 private constant BASE_PRICE = 10_000_000; // 10 pathUSD
    uint16 private constant PAY_PROBABILITY_BPS = 5_000;
    bytes32 private constant METADATA_HASH = keccak256("metadata");

    function setUp() public {
        token = new MockTIP20();
        nft = new TempoMaybePayNFT("Tempo Maybe Pay", "TMP", address(this));
        store = new TempoMaybePayStore(address(token), address(nft), merchant, address(this));
        nft.setStore(address(store));
        store.setProcessor(operator, true);
        store.setProduct(PRODUCT_ID, "Payment Lane Pass", BASE_PRICE, 100, true, "https://example.com/1");
        token.mint(buyer, 1_000_000_000_000);
    }

    function testQuoteMaxEscrow() public view {
        _assertEq(store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS), 20_000_000, "max escrow");
        _assertEq(store.quoteMaxEscrow(PRODUCT_ID, 1_000), 100_000_000, "10% escrow");
    }

    function testPaidResolutionKeepsEscrowAndMintsNft() public {
        bytes32 orderId = keccak256("paid-order");
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        (bytes32 seed,) = _findSeed(orderId, maxEscrow, PAY_PROBABILITY_BPS, true);
        _openEpoch(seed);

        uint256 startingBuyerBalance = token.balanceOf(buyer);
        _placeOrder(orderId, maxEscrow);

        vm.prank(operator);
        (bool paid, uint256 tokenId) = store.processOrder(orderId, seed);

        _assertTrue(paid, "paid");
        _assertEq(token.balanceOf(buyer), startingBuyerBalance - maxEscrow, "buyer charged");
        _assertEq(token.balanceOf(merchant), maxEscrow, "merchant paid");
        _assertEq(nft.ownerOf(tokenId), buyer, "nft owner");
    }

    function testFreeResolutionRefundsEscrowAndMintsNft() public {
        bytes32 orderId = keccak256("free-order");
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        (bytes32 seed,) = _findSeed(orderId, maxEscrow, PAY_PROBABILITY_BPS, false);
        _openEpoch(seed);

        uint256 startingBuyerBalance = token.balanceOf(buyer);
        _placeOrder(orderId, maxEscrow);

        vm.prank(operator);
        (bool paid, uint256 tokenId) = store.processOrder(orderId, seed);

        _assertTrue(!paid, "free");
        _assertEq(token.balanceOf(buyer), startingBuyerBalance, "buyer refunded");
        _assertEq(token.balanceOf(merchant), 0, "merchant unpaid");
        _assertEq(nft.ownerOf(tokenId), buyer, "nft owner");
    }

    function testWrongRevealReverts() public {
        bytes32 orderId = keccak256("wrong-seed-order");
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        bytes32 seed = keccak256("correct-seed");
        _openEpoch(seed);
        _placeOrder(orderId, maxEscrow);

        vm.prank(operator);
        vm.expectRevert();
        store.processOrder(orderId, keccak256("wrong-seed"));
    }

    function testExpiredOrderCanBeRefunded() public {
        bytes32 orderId = keccak256("expired-order");
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        _openEpoch(keccak256("expired-seed"));
        uint256 startingBuyerBalance = token.balanceOf(buyer);
        _placeOrder(orderId, maxEscrow);

        vm.warp(block.timestamp + 2 days);
        store.refundExpired(orderId);

        _assertEq(token.balanceOf(buyer), startingBuyerBalance, "buyer refunded");
    }

    function _openEpoch(bytes32 seed) private {
        store.openEpoch(keccak256(abi.encodePacked(seed)), uint64(block.timestamp + 1 days));
    }

    function _placeOrder(bytes32 orderId, uint256 maxEscrow) private {
        vm.prank(buyer);
        token.approve(address(store), maxEscrow);
        vm.prank(buyer);
        store.placeOrder(orderId, PRODUCT_ID, PAY_PROBABILITY_BPS, METADATA_HASH);
    }

    function _findSeed(bytes32 orderId, uint256 maxEscrow, uint16 payProbabilityBps, bool wantPaid)
        private
        view
        returns (bytes32 seed, uint256 roll)
    {
        for (uint256 i = 0; i < 100_000; i += 1) {
            seed = keccak256(abi.encode("seed", i));
            roll = uint256(
                keccak256(
                    abi.encode(
                        seed,
                        block.chainid,
                        address(store),
                        orderId,
                        buyer,
                        PRODUCT_ID,
                        maxEscrow,
                        payProbabilityBps,
                        METADATA_HASH
                    )
                )
            ) % store.BPS();
            if ((roll < payProbabilityBps) == wantPaid) return (seed, roll);
        }
        revert("seed not found");
    }

    function _assertEq(uint256 actual, uint256 expected, string memory message) private pure {
        require(actual == expected, message);
    }

    function _assertEq(address actual, address expected, string memory message) private pure {
        require(actual == expected, message);
    }

    function _assertTrue(bool value, string memory message) private pure {
        require(value, message);
    }
}

