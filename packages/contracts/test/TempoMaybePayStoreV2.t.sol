// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockTIP20} from "./MockTIP20.sol";
import {TempoMaybePayNFTV2} from "../src/TempoMaybePayNFTV2.sol";
import {TempoMaybePayStoreV2} from "../src/TempoMaybePayStoreV2.sol";

interface VmV2 {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert() external;
}

contract TempoMaybePayStoreV2Test {
    VmV2 private constant vm = VmV2(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockTIP20 private token;
    TempoMaybePayNFTV2 private nft;
    TempoMaybePayStoreV2 private store;

    address private buyer = address(0xB0B);
    address private operator = address(0x0E0);
    address private merchant = address(0xA11CE);

    uint256 private constant PRODUCT_ID = 1;
    uint256 private constant BASE_PRICE = 10_000_000; // 10 pathUSD
    uint256 private constant HOUSE_BANKROLL = 1_000_000_000; // 1,000 pathUSD
    uint16 private constant PAY_PROBABILITY_BPS = 5_000;
    bytes32 private constant PAYMENT_TX_HASH = keccak256("payment-tx");

    function setUp() public {
        token = new MockTIP20();
        nft = new TempoMaybePayNFTV2("Tempo Maybe Pay", "TMP", "https://example.com/metadata/", address(this));
        store = new TempoMaybePayStoreV2(address(token), address(nft), merchant, address(this));
        nft.setStore(address(store));
        store.setProcessor(operator, true);
        store.setProduct(PRODUCT_ID, BASE_PRICE, 100, true);
        token.mint(buyer, 1_000_000_000_000);
        token.mint(address(store), HOUSE_BANKROLL);
    }

    function testQuoteMaxEscrowAndRedeemValue() public view {
        _assertEq(store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS), 20_000_000, "max escrow");
        _assertEq(store.quoteMaxEscrow(PRODUCT_ID, 1_000), 100_000_000, "10% escrow");
        _assertEq(store.quoteRedeemValue(PRODUCT_ID), 9_900_000, "99% redeem value");
    }

    function testPaidResolutionKeepsMemoEscrowInHouseAndCreatesClaim() public {
        bytes32 orderId = keccak256("paid-order");
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        (bytes32 seed,) = _findSeed(orderId, maxEscrow, PAYMENT_TX_HASH, true);
        _openEpoch(seed);

        uint256 startingBuyerBalance = token.balanceOf(buyer);
        _sendEscrow(orderId, maxEscrow);

        vm.prank(operator);
        (bool paid, uint256 tokenId) = store.processPaidOrder(
            orderId, buyer, PRODUCT_ID, PAY_PROBABILITY_BPS, maxEscrow, PAYMENT_TX_HASH, seed
        );

        _assertTrue(paid, "paid");
        _assertEq(token.balanceOf(buyer), startingBuyerBalance - maxEscrow, "buyer charged");
        _assertEq(token.balanceOf(address(store)), HOUSE_BANKROLL + maxEscrow, "house keeps escrow");
        _assertEq(token.balanceOf(merchant), 0, "merchant unpaid");
        _assertEq(nft.ownerOf(tokenId), buyer, "nft owner");
        _assertEq(store.pendingEscrowTotal(), 0, "no pending accounting");
        _assertEq(store.outstandingRedemptionLiability(), 9_900_000, "liability");
        _assertEq(store.availableHouseReserve(), HOUSE_BANKROLL + maxEscrow - 9_900_000, "available reserve");

        (uint256 redeemValue, uint64 deadline, bool active) = store.redemptions(tokenId);
        _assertEq(redeemValue, 9_900_000, "redeem value");
        _assertTrue(deadline == block.timestamp + store.REDEEM_WINDOW(), "deadline");
        _assertTrue(active, "active");
    }

    function testFreeResolutionRefundsMemoEscrowAndCreatesClaim() public {
        bytes32 orderId = keccak256("free-order");
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        (bytes32 seed,) = _findSeed(orderId, maxEscrow, PAYMENT_TX_HASH, false);
        _openEpoch(seed);

        uint256 startingBuyerBalance = token.balanceOf(buyer);
        _sendEscrow(orderId, maxEscrow);

        vm.prank(operator);
        (bool paid, uint256 tokenId) = store.processPaidOrder(
            orderId, buyer, PRODUCT_ID, PAY_PROBABILITY_BPS, maxEscrow, PAYMENT_TX_HASH, seed
        );

        _assertTrue(!paid, "free");
        _assertEq(token.balanceOf(buyer), startingBuyerBalance, "buyer refunded");
        _assertEq(token.balanceOf(address(store)), HOUSE_BANKROLL, "house bankroll unchanged before claim");
        _assertEq(nft.ownerOf(tokenId), buyer, "nft owner");
        _assertEq(store.outstandingRedemptionLiability(), 9_900_000, "liability");
        _assertEq(store.availableHouseReserve(), HOUSE_BANKROLL - 9_900_000, "available reserve");
    }

    function testRedeemReturnsPathUsdWithoutNftApproval() public {
        uint256 tokenId = _resolvedOrderToken(keccak256("redeem-order"), false);
        uint256 startingBuyerBalance = token.balanceOf(buyer);
        uint256 startingStoreBalance = token.balanceOf(address(store));

        vm.prank(buyer);
        store.redeem(tokenId);

        _assertEq(token.balanceOf(buyer), startingBuyerBalance + 9_900_000, "buyer redeemed");
        _assertEq(token.balanceOf(address(store)), startingStoreBalance - 9_900_000, "house paid claim");
        _assertEq(nft.ownerOf(tokenId), address(store), "nft reclaimed");
        _assertEq(store.productInventoryCount(PRODUCT_ID), 1, "inventory count");
        _assertEq(store.outstandingRedemptionLiability(), 0, "liability cleared");
    }

    function testProcessorCanSponsorRedemptionToOwner() public {
        uint256 tokenId = _resolvedOrderToken(keccak256("sponsored-redeem-order"), false);
        uint256 startingBuyerBalance = token.balanceOf(buyer);

        vm.prank(operator);
        store.redeemFor(buyer, tokenId);

        _assertEq(token.balanceOf(buyer), startingBuyerBalance + 9_900_000, "buyer redeemed");
        _assertEq(nft.ownerOf(tokenId), address(store), "nft reclaimed");
    }

    function testTokensOfOwnerScansWithoutWriteTimeEnumeration() public {
        uint256 first = _resolvedOrderToken(keccak256("first-token"), false);
        uint256 second = _resolvedOrderToken(keccak256("second-token"), true);

        uint256[] memory tokenIds = nft.tokensOfOwner(buyer);
        _assertEq(tokenIds.length, 2, "owned count");
        _assertEq(tokenIds[0], first, "first token");
        _assertEq(tokenIds[1], second, "second token");
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
        vm.expectRevert();
        store.redeem(tokenId);
    }

    function testHouseBankruptPreventsResolution() public {
        TempoMaybePayNFTV2 thinNft =
            new TempoMaybePayNFTV2("Tempo Maybe Pay", "TMP", "https://example.com/metadata/", address(this));
        TempoMaybePayStoreV2 thinStore = new TempoMaybePayStoreV2(address(token), address(thinNft), merchant, address(this));
        thinNft.setStore(address(thinStore));
        thinStore.setProcessor(operator, true);
        thinStore.setProduct(PRODUCT_ID, BASE_PRICE, 100, true);

        bytes32 orderId = keccak256("thin-order");
        bytes32 paymentTxHash = keccak256("thin-payment");
        uint256 maxEscrow = thinStore.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        bytes32 seed = keccak256("thin-seed");
        thinStore.openEpoch(keccak256(abi.encodePacked(seed)), uint64(block.timestamp + 1 days));

        vm.prank(buyer);
        token.transferWithMemo(address(thinStore), maxEscrow, orderId);

        vm.prank(operator);
        vm.expectRevert();
        thinStore.processPaidOrder(orderId, buyer, PRODUCT_ID, PAY_PROBABILITY_BPS, maxEscrow, paymentTxHash, seed);
    }

    function testSweepExcessCannotTouchLiveLiabilities() public {
        uint256 tokenId = _resolvedOrderToken(keccak256("sweep-order"), false);
        _assertEq(tokenId > 0 ? 1 : 0, 1, "token minted");

        vm.expectRevert();
        store.sweepExcess(merchant, HOUSE_BANKROLL);

        uint256 available = store.availableHouseReserve();
        store.sweepExcess(merchant, available);
        _assertEq(token.balanceOf(merchant), available, "merchant swept available reserve");
    }

    function _resolvedOrderToken(bytes32 orderId, bool wantPaid) private returns (uint256 tokenId) {
        uint256 maxEscrow = store.quoteMaxEscrow(PRODUCT_ID, PAY_PROBABILITY_BPS);
        bytes32 paymentTxHash = keccak256(abi.encode("payment", orderId));
        (bytes32 seed,) = _findSeed(orderId, maxEscrow, paymentTxHash, wantPaid);
        _openEpoch(seed);
        _sendEscrow(orderId, maxEscrow);

        vm.prank(operator);
        (, tokenId) =
            store.processPaidOrder(orderId, buyer, PRODUCT_ID, PAY_PROBABILITY_BPS, maxEscrow, paymentTxHash, seed);
    }

    function _openEpoch(bytes32 seed) private {
        store.openEpoch(keccak256(abi.encodePacked(seed)), uint64(block.timestamp + 1 days));
    }

    function _sendEscrow(bytes32 orderId, uint256 maxEscrow) private {
        vm.prank(buyer);
        token.transferWithMemo(address(store), maxEscrow, orderId);
    }

    function _findSeed(bytes32 orderId, uint256 maxEscrow, bytes32 paymentTxHash, bool wantPaid)
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
                        PAY_PROBABILITY_BPS,
                        paymentTxHash
                    )
                )
            ) % store.BPS();
            if ((roll < PAY_PROBABILITY_BPS) == wantPaid) return (seed, roll);
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
