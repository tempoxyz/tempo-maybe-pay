// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ITIP20} from "./ITIP20.sol";
import {Owned} from "./Owned.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {TempoMaybePayNFTV2} from "./TempoMaybePayNFTV2.sol";

contract TempoMaybePayStoreV2 is Owned, ReentrancyGuard {
    uint16 public constant BPS = 10_000;
    uint16 public constant MIN_PAY_PROBABILITY_BPS = 100;
    uint16 public constant REDEEM_BPS = 9_900;
    uint64 public constant REDEEM_WINDOW = 1 hours;

    enum OrderStatus {
        None,
        Pending,
        Paid,
        Free,
        Refunded
    }

    struct Product {
        uint96 basePrice;
        uint32 maxSupply;
        uint32 minted;
        bool active;
    }

    struct Epoch {
        bytes32 commitment;
        uint64 openedAt;
        uint64 revealDeadline;
        bool revealed;
    }

    struct Redemption {
        uint96 value;
        uint64 deadline;
        bool active;
    }

    ITIP20 public immutable paymentToken;
    TempoMaybePayNFTV2 public immutable nft;
    address public merchant;
    uint256 public currentEpochId;
    uint256 public pendingEscrowTotal;
    uint256 public outstandingRedemptionLiability;

    mapping(uint256 productId => Product product) public products;
    mapping(uint256 epochId => Epoch epoch) public epochs;
    mapping(bytes32 orderId => bool processed) public processedOrders;
    mapping(address processor => bool enabled) public processors;
    mapping(uint256 tokenId => Redemption redemption) public redemptions;

    event MerchantUpdated(address indexed merchant);
    event ProcessorUpdated(address indexed processor, bool enabled);
    event ProductSet(uint256 indexed productId, uint256 basePrice, uint256 maxSupply, bool active);
    event EpochOpened(uint256 indexed epochId, bytes32 indexed commitment, uint64 revealDeadline);
    event PaymentOrderResolved(
        bytes32 indexed orderId,
        address indexed buyer,
        uint256 indexed tokenId,
        OrderStatus status,
        uint256 productId,
        uint256 roll,
        uint256 paidAmount,
        uint256 refundedAmount,
        uint256 redeemValue,
        uint64 redeemDeadline,
        bytes32 paymentTxHash
    );
    event NftRedeemed(address indexed redeemer, uint256 indexed tokenId, uint256 indexed productId, uint256 amount);
    event RedemptionExpired(uint256 indexed tokenId, uint256 amount);
    event ExcessSwept(address indexed to, uint256 amount);

    error InvalidProbability();
    error InvalidProduct();
    error InvalidEpoch();
    error EpochBusy();
    error OrderExists();
    error OrderNotPending();
    error DeadlineNotPassed();
    error CommitmentMismatch();
    error TokenTransferFailed();
    error HouseBankrupt();
    error RedemptionInactive();
    error RedemptionNotExpired();
    error NotTokenOwner();
    error InvalidEscrow();

    modifier onlyProcessor() {
        if (msg.sender != owner && !processors[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(address paymentToken_, address nft_, address merchant_, address initialOwner) Owned(initialOwner) {
        if (paymentToken_ == address(0) || nft_ == address(0) || merchant_ == address(0)) revert ZeroAddress();
        paymentToken = ITIP20(paymentToken_);
        nft = TempoMaybePayNFTV2(nft_);
        merchant = merchant_;
        emit MerchantUpdated(merchant_);
    }

    function setMerchant(address merchant_) external onlyOwner {
        if (merchant_ == address(0)) revert ZeroAddress();
        merchant = merchant_;
        emit MerchantUpdated(merchant_);
    }

    function setProcessor(address processor, bool enabled) external onlyOwner {
        if (processor == address(0)) revert ZeroAddress();
        processors[processor] = enabled;
        emit ProcessorUpdated(processor, enabled);
    }

    function setProduct(uint256 productId, uint256 basePrice, uint256 maxSupply, bool active) external onlyOwner {
        if (
            productId == 0 || productId > type(uint32).max || basePrice == 0 || basePrice > type(uint96).max
                || maxSupply == 0 || maxSupply > type(uint32).max
        ) {
            revert InvalidProduct();
        }
        Product storage product = products[productId];
        if (product.minted > maxSupply) revert InvalidProduct();

        // forge-lint: disable-next-line(unsafe-typecast)
        product.basePrice = uint96(basePrice);
        // forge-lint: disable-next-line(unsafe-typecast)
        product.maxSupply = uint32(maxSupply);
        product.active = active;

        emit ProductSet(productId, basePrice, maxSupply, active);
    }

    function openEpoch(bytes32 commitment, uint64 revealDeadline) external onlyProcessor returns (uint256 epochId) {
        if (commitment == bytes32(0) || revealDeadline <= block.timestamp) revert InvalidEpoch();

        Epoch storage current = epochs[currentEpochId];
        if (currentEpochId != 0 && !current.revealed && block.timestamp <= current.revealDeadline) {
            revert EpochBusy();
        }

        epochId = ++currentEpochId;
        epochs[epochId] = Epoch({
            commitment: commitment,
            openedAt: uint64(block.timestamp),
            revealDeadline: revealDeadline,
            revealed: false
        });

        emit EpochOpened(epochId, commitment, revealDeadline);
    }

    function quoteMaxEscrow(uint256 productId, uint16 payProbabilityBps) public view returns (uint256) {
        Product storage product = products[productId];
        if (!product.active || product.basePrice == 0 || product.minted >= product.maxSupply) revert InvalidProduct();
        if (payProbabilityBps < MIN_PAY_PROBABILITY_BPS || payProbabilityBps > BPS) revert InvalidProbability();
        return _ceilDiv(uint256(product.basePrice) * BPS, payProbabilityBps);
    }

    function quoteRedeemValue(uint256 productId) public view returns (uint256) {
        Product storage product = products[productId];
        if (!product.active || product.basePrice == 0) revert InvalidProduct();
        return (uint256(product.basePrice) * REDEEM_BPS) / BPS;
    }

    function productInventoryCount(uint256 productId) external view returns (uint256 count) {
        uint256 next = nft.nextTokenId();
        for (uint256 tokenId = 1; tokenId < next; tokenId += 1) {
            if (nft.ownerOf(tokenId) == address(this) && nft.tokenProduct(tokenId) == productId) count += 1;
        }
    }

    function availableHouseReserve() public view returns (uint256) {
        uint256 locked = pendingEscrowTotal + outstandingRedemptionLiability;
        uint256 balance = paymentToken.balanceOf(address(this));
        return balance > locked ? balance - locked : 0;
    }

    function processPaidOrder(
        bytes32 orderId,
        address buyer,
        uint256 productId,
        uint16 payProbabilityBps,
        uint256 maxEscrow,
        bytes32 paymentTxHash,
        bytes32 seed
    ) external onlyProcessor nonReentrant returns (bool paid, uint256 tokenId) {
        if (orderId == bytes32(0) || paymentTxHash == bytes32(0) || buyer == address(0)) revert InvalidEscrow();
        if (processedOrders[orderId]) revert OrderExists();
        if (maxEscrow > type(uint96).max) revert InvalidEscrow();
        if (currentEpochId > type(uint32).max || productId > type(uint32).max) revert InvalidProduct();

        Product storage product = products[productId];
        if (!product.active || product.basePrice == 0 || product.minted >= product.maxSupply) revert InvalidProduct();
        if (maxEscrow != quoteMaxEscrow(productId, payProbabilityBps)) revert InvalidEscrow();

        Epoch storage epoch = epochs[currentEpochId];
        if (
            currentEpochId == 0 || epoch.commitment == bytes32(0) || epoch.revealed
                || block.timestamp > epoch.revealDeadline
        ) revert InvalidEpoch();
        if (keccak256(abi.encodePacked(seed)) != epoch.commitment) revert CommitmentMismatch();

        uint256 redeemValue = (uint256(product.basePrice) * REDEEM_BPS) / BPS;
        uint256 balance = paymentToken.balanceOf(address(this));
        if (balance < maxEscrow + outstandingRedemptionLiability + redeemValue) revert HouseBankrupt();

        uint256 roll = uint256(
            keccak256(
                abi.encode(
                    seed,
                    block.chainid,
                    address(this),
                    orderId,
                    buyer,
                    productId,
                    maxEscrow,
                    payProbabilityBps,
                    paymentTxHash
                )
            )
        ) % BPS;

        paid = roll < payProbabilityBps;
        epoch.revealed = true;
        processedOrders[orderId] = true;

        uint256 paidAmount;
        uint256 refundedAmount;
        if (paid) {
            paidAmount = maxEscrow;
        } else {
            refundedAmount = maxEscrow;
            paymentToken.transferWithMemo(buyer, maxEscrow, orderId);
        }

        product.minted += 1;
        tokenId = nft.mint(buyer, productId);
        if (tokenId > type(uint64).max || redeemValue > type(uint96).max) revert InvalidProduct();

        uint64 redeemDeadline = uint64(block.timestamp + REDEEM_WINDOW);
        // forge-lint: disable-next-line(unsafe-typecast)
        redemptions[tokenId] = Redemption({value: uint96(redeemValue), deadline: redeemDeadline, active: true});
        outstandingRedemptionLiability += redeemValue;

        emit PaymentOrderResolved(
            orderId,
            buyer,
            tokenId,
            paid ? OrderStatus.Paid : OrderStatus.Free,
            productId,
            roll,
            paidAmount,
            refundedAmount,
            redeemValue,
            redeemDeadline,
            paymentTxHash
        );
    }

    function redeem(uint256 tokenId) external nonReentrant {
        _redeemTo(msg.sender, tokenId);
    }

    function redeemFor(address owner, uint256 tokenId) external onlyProcessor nonReentrant {
        _redeemTo(owner, tokenId);
    }

    function expireRedemption(uint256 tokenId) public {
        Redemption storage redemption = redemptions[tokenId];
        if (!redemption.active || redemption.value == 0) revert RedemptionInactive();
        if (block.timestamp <= redemption.deadline) revert RedemptionNotExpired();

        uint256 amount = redemption.value;
        _clearRedemption(redemption);
        emit RedemptionExpired(tokenId, amount);
    }

    function expireRedemptions(uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i += 1) {
            expireRedemption(tokenIds[i]);
        }
    }

    function sweepExcess(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > availableHouseReserve()) revert HouseBankrupt();
        bool ok = paymentToken.transfer(to, amount);
        if (!ok) revert TokenTransferFailed();
        emit ExcessSwept(to, amount);
    }

    function _redeemTo(address owner, uint256 tokenId) private {
        Redemption storage redemption = redemptions[tokenId];
        if (!redemption.active || redemption.value == 0) revert RedemptionInactive();
        if (block.timestamp > redemption.deadline) revert DeadlineNotPassed();
        if (nft.ownerOf(tokenId) != owner) revert NotTokenOwner();

        uint256 amount = redemption.value;
        uint256 productId = nft.tokenProduct(tokenId);
        _clearRedemption(redemption);

        nft.storeTransferFrom(owner, address(this), tokenId);
        paymentToken.transferWithMemo(owner, amount, bytes32(tokenId));

        emit NftRedeemed(owner, tokenId, productId, amount);
    }

    function _clearRedemption(Redemption storage redemption) private {
        uint256 amount = redemption.value;
        redemption.value = 0;
        redemption.deadline = 0;
        redemption.active = false;
        outstandingRedemptionLiability -= amount;
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator == 0 ? 0 : ((numerator - 1) / denominator) + 1;
    }
}
