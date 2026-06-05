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
    uint256 private constant HOUSE_BANKROLL = 1_000_000_000; // 1,000 pathUSD
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
        token.mint(address(store), HOUSE_BANKROLL);
    }

    function testQuoteMaxEscrowAndRedeemValue() public view {
        _assertEq(store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS), 20_000_000, "max escrow");
        _assertEq(store.quoteMaxEscrow(PRODUCT_ID, 1_000), 100_000_000, "10% escrow");
        _assertEq(store.quoteRedeemValue(PRODUCT_ID), 9_900_000, "99% redeem value");
    }

    function testPaidResolutionKeepsEscrowInHouseAndCreatesClaim() public {
        bytes32 orderId = keccak256("paid-order");
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        (bytes32 seed,) = _findSeed(orderId, maxEscrow, PAY_PROBABILITY_BPS, true);
        _openEpoch(seed);

        uint256 startingBuyerBalance = token.balanceOf(buyer);
        _placeOrder(orderId, maxEscrow);

        _assertEq(store.pendingEscrowTotal(), maxEscrow, "pending escrow");

        vm.prank(operator);
        (bool paid, uint256 tokenId) = store.processOrder(orderId, seed);

        _assertTrue(paid, "paid");
        _assertEq(token.balanceOf(buyer), startingBuyerBalance - maxEscrow, "buyer charged");
        _assertEq(token.balanceOf(address(store)), HOUSE_BANKROLL + maxEscrow, "house keeps escrow");
        _assertEq(token.balanceOf(merchant), 0, "merchant unpaid");
        _assertEq(nft.ownerOf(tokenId), buyer, "nft owner");
        _assertEq(store.pendingEscrowTotal(), 0, "pending cleared");
        _assertEq(store.outstandingRedemptionLiability(), 9_900_000, "liability");
        _assertEq(store.availableHouseReserve(), HOUSE_BANKROLL + maxEscrow - 9_900_000, "available reserve");

        (uint256 redeemValue, uint64 deadline, bool active) = store.redemptions(tokenId);
        _assertEq(redeemValue, 9_900_000, "redeem value");
        _assertTrue(deadline == block.timestamp + store.REDEEM_WINDOW(), "deadline");
        _assertTrue(active, "active");
    }

    function testFreeResolutionRefundsEscrowAndCreatesClaim() public {
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
        _assertEq(token.balanceOf(address(store)), HOUSE_BANKROLL, "house bankroll unchanged before claim");
        _assertEq(token.balanceOf(merchant), 0, "merchant unpaid");
        _assertEq(nft.ownerOf(tokenId), buyer, "nft owner");
        _assertEq(store.outstandingRedemptionLiability(), 9_900_000, "liability");
        _assertEq(store.availableHouseReserve(), HOUSE_BANKROLL - 9_900_000, "available reserve");
    }

    function testRedeemReturnsPathUsdAndRestocksNft() public {
        uint256 tokenId = _resolvedOrderToken(keccak256("redeem-order"), false);
        uint256 startingBuyerBalance = token.balanceOf(buyer);
        uint256 startingStoreBalance = token.balanceOf(address(store));

        vm.prank(buyer);
        nft.approve(address(store), tokenId);
        vm.prank(buyer);
        store.redeem(tokenId);

        _assertEq(token.balanceOf(buyer), startingBuyerBalance + 9_900_000, "buyer redeemed");
        _assertEq(token.balanceOf(address(store)), startingStoreBalance - 9_900_000, "house paid claim");
        _assertEq(nft.ownerOf(tokenId), address(store), "nft restocked");
        _assertEq(store.productInventoryCount(PRODUCT_ID), 1, "inventory count");
        _assertEq(store.outstandingRedemptionLiability(), 0, "liability cleared");

        (uint256 redeemValue,, bool active) = store.redemptions(tokenId);
        _assertEq(redeemValue, 0, "inactive value");
        _assertTrue(!active, "inactive");
    }

    function testRestockedNftIsReusedForNextOrder() public {
        uint256 tokenId = _resolvedOrderToken(keccak256("first-order"), false);

        vm.prank(buyer);
        nft.approve(address(store), tokenId);
        vm.prank(buyer);
        store.redeem(tokenId);

        bytes32 secondOrderId = keccak256("second-order");
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        (bytes32 seed,) = _findSeed(secondOrderId, maxEscrow, PAY_PROBABILITY_BPS, true);
        _openEpoch(seed);
        _placeOrder(secondOrderId, maxEscrow);

        vm.prank(operator);
        (, uint256 reusedTokenId) = store.processOrder(secondOrderId, seed);

        _assertEq(reusedTokenId, tokenId, "same token reused");
        _assertEq(nft.ownerOf(tokenId), buyer, "nft redelivered");
        _assertEq(store.productInventoryCount(PRODUCT_ID), 0, "inventory consumed");
        _assertEq(nft.nextTokenId(), 2, "no new mint");
        _assertEq(store.outstandingRedemptionLiability(), 9_900_000, "new claim");
    }

    function testExpiredRedemptionUnlocksHouseAndLeavesNftWithUser() public {
        uint256 tokenId = _resolvedOrderToken(keccak256("expire-order"), false);
        (, uint64 deadline,) = store.redemptions(tokenId);
        _assertEq(store.outstandingRedemptionLiability(), 9_900_000, "liability before expiry");

        vm.warp(uint256(deadline) + 1);
        store.expireRedemption(tokenId);

        _assertEq(store.outstandingRedemptionLiability(), 0, "liability expired");
        _assertEq(nft.ownerOf(tokenId), buyer, "buyer keeps collectible");

        vm.prank(buyer);
        nft.approve(address(store), tokenId);
        vm.prank(buyer);
        vm.expectRevert();
        store.redeem(tokenId);
    }

    function testHouseBankruptPreventsNewOrders() public {
        TempoMaybePayNFT thinNft = new TempoMaybePayNFT("Tempo Maybe Pay", "TMP", address(this));
        TempoMaybePayStore thinStore = new TempoMaybePayStore(address(token), address(thinNft), merchant, address(this));
        thinNft.setStore(address(thinStore));
        thinStore.setProduct(PRODUCT_ID, "Payment Lane Pass", BASE_PRICE, 100, true, "https://example.com/1");
        bytes32 seed = keccak256("thin-seed");
        thinStore.openEpoch(keccak256(abi.encodePacked(seed)), uint64(block.timestamp + 1 days));

        uint256 maxEscrow = thinStore.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        vm.prank(buyer);
        token.approve(address(thinStore), maxEscrow);
        vm.prank(buyer);
        vm.expectRevert();
        thinStore.placeOrder(keccak256("thin-order"), PRODUCT_ID, PAY_PROBABILITY_BPS, METADATA_HASH);
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

        _assertEq(store.pendingEscrowTotal(), maxEscrow, "pending escrow before refund");

        vm.warp(block.timestamp + 2 days);
        store.refundExpired(orderId);

        _assertEq(token.balanceOf(buyer), startingBuyerBalance, "buyer refunded");
        _assertEq(store.pendingEscrowTotal(), 0, "pending escrow cleared");
    }

    function _resolvedOrderToken(bytes32 orderId, bool wantPaid) private returns (uint256 tokenId) {
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        (bytes32 seed,) = _findSeed(orderId, maxEscrow, PAY_PROBABILITY_BPS, wantPaid);
        _openEpoch(seed);
        _placeOrder(orderId, maxEscrow);

        vm.prank(operator);
        (, tokenId) = store.processOrder(orderId, seed);
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
