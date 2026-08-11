// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ITIP20} from "./ITIP20.sol";
import {Owned} from "./Owned.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {TempoMaybePayNFT} from "./TempoMaybePayNFT.sol";

contract TempoMaybePayStore is Owned, ReentrancyGuard {
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
        string name;
        string metadataURI;
        uint256 basePrice;
        uint256 maxSupply;
        uint256 minted;
        uint256 reserved;
        bool active;
    }

    struct Epoch {
        bytes32 commitment;
        uint64 openedAt;
        uint64 revealDeadline;
        bytes32 orderId; // Kept for storage layout backwards-compatibility, but no longer enforced as a singleton limit
        bool revealed;
    }

    struct Order {
        address buyer;
        uint256 productId;
        uint256 epochId;
        uint256 basePrice;
        uint256 maxEscrow;
        uint16 payProbabilityBps;
        bytes32 metadataHash;
        OrderStatus status;
        uint256 roll;
        uint256 tokenId;
    }

    struct Redemption {
        uint256 value;
        uint64 deadline;
        bool active;
    }

    ITIP20 public immutable paymentToken;
    TempoMaybePayNFT public immutable nft;
    address public merchant;
    uint256 public currentEpochId;
    uint256 public pendingEscrowTotal;
    uint256 public outstandingRedemptionLiability;

    mapping(uint256 productId => Product product) public products;
    mapping(uint256 epochId => Epoch epoch) public epochs;
    mapping(bytes32 orderId => Order order) public orders;
    mapping(address processor => bool enabled) public processors;
    mapping(uint256 tokenId => Redemption redemption) public redemptions;
    mapping(uint256 productId => uint256[] tokenIds) private productInventory;

    event MerchantUpdated(address indexed merchant);
    event ProcessorUpdated(address indexed processor, bool enabled);
    event ProductSet(
        uint256 indexed productId, string name, uint256 basePrice, uint256 maxSupply, bool active, string metadataURI
    );
    event EpochOpened(uint256 indexed epochId, bytes32 indexed commitment, uint64 revealDeadline);
    event OrderPlaced(
        bytes32 indexed orderId,
        address indexed buyer,
        uint256 indexed productId,
        uint256 epochId,
        uint256 basePrice,
        uint256 maxEscrow,
        uint16 payProbabilityBps,
        bytes32 metadataHash
    );
    event OrderResolved(
        bytes32 indexed orderId,
        address indexed buyer,
        uint256 indexed tokenId,
        OrderStatus status,
        uint256 roll,
        uint256 paidAmount,
        uint256 refundedAmount,
        uint256 redeemValue,
        uint64 redeemDeadline
    );
    event OrderRefunded(bytes32 indexed orderId, address indexed buyer, uint256 amount);
    event NftRedeemed(address indexed redeemer, uint256 indexed tokenId, uint256 indexed productId, uint256 amount);
    event RedemptionExpired(uint256 indexed tokenId, uint256 amount);

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

    modifier onlyProcessor() {
        if (msg.sender != owner && !processors[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(address paymentToken_, address nft_, address merchant_, address initialOwner) Owned(initialOwner) {
        if (paymentToken_ == address(0) || nft_ == address(0) || merchant_ == address(0)) revert ZeroAddress();
        paymentToken = ITIP20(paymentToken_);
        nft = TempoMaybePayNFT(nft_);
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

    function setProduct(
        uint256 productId,
        string calldata name,
        uint256 basePrice,
        uint256 maxSupply,
        bool active,
        string calldata metadataURI
    ) external onlyOwner {
        if (productId == 0 || basePrice == 0 || maxSupply == 0) revert InvalidProduct();

        Product storage product = products[productId];
        if (product.minted + product.reserved > maxSupply) revert InvalidProduct();

        product.name = name;
        product.basePrice = basePrice;
        product.maxSupply = maxSupply;
        product.active = active;
        product.metadataURI = metadataURI;

        emit ProductSet(productId, name, basePrice, maxSupply, active, metadataURI);
    }

    function openEpoch(bytes32 commitment, uint64 revealDeadline) external onlyProcessor returns (uint256 epochId) {
        if (commitment == bytes32(0) || revealDeadline <= block.timestamp) revert InvalidEpoch();

        // [PERFORMANCE / LIVENESS PATCH]: Removed the `EpochBusy` block.
        // Previously, `epoch.orderId != 0` artificially limited the system to 1 order per epoch,
        // freezing the store until reveal/deadline. We now allow N concurrent orders per epoch.

        epochId = ++currentEpochId;
        epochs[epochId] = Epoch({
            commitment: commitment,
            openedAt: uint64(block.timestamp),
            revealDeadline: revealDeadline,
            orderId: bytes32(0),
            revealed: false
        });

        emit EpochOpened(epochId, commitment, revealDeadline);
    }

    function quoteMaxEscrow(uint256 productId, uint16 payProbabilityBps) public view returns (uint256) {
        Product storage product = products[productId];
        if (!product.active || product.basePrice == 0 || !_hasAvailableStock(productId, product)) {
            revert InvalidProduct();
        }
        if (payProbabilityBps < MIN_PAY_PROBABILITY_BPS || payProbabilityBps > BPS) revert InvalidProbability();
        return _ceilDiv(product.basePrice * BPS, payProbabilityBps);
    }

    function quoteRedeemValue(uint256 productId) public view returns (uint256) {
        Product storage product = products[productId];
        if (!product.active || product.basePrice == 0) revert InvalidProduct();
        return (product.basePrice * REDEEM_BPS) / BPS;
    }

    function productInventoryCount(uint256 productId) external view returns (uint256) {
        return productInventory[productId].length;
    }

    function availableHouseReserve() public view returns (uint256) {
        uint256 locked = pendingEscrowTotal + outstandingRedemptionLiability;
        uint256 balance = paymentToken.balanceOf(address(this));
        return balance > locked ? balance - locked : 0;
    }

    function placeOrder(bytes32 orderId, uint256 productId, uint16 payProbabilityBps, bytes32 metadataHash)
        external
        nonReentrant
        returns (uint256 maxEscrow)
    {
        return _placeOrder(orderId, productId, payProbabilityBps, metadataHash);
    }

    function permitAndPlaceOrder(
        bytes32 orderId,
        uint256 productId,
        uint16 payProbabilityBps,
        bytes32 metadataHash,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 maxEscrow) {
        maxEscrow = quoteMaxEscrow(productId, payProbabilityBps);
        paymentToken.permit(msg.sender, address(this), maxEscrow, permitDeadline, v, r, s);
        _placeOrderWithEscrow(orderId, productId, payProbabilityBps, metadataHash, maxEscrow);
    }

    function processOrder(bytes32 orderId, bytes32 seed)
        external
        onlyProcessor
        nonReentrant
        returns (bool paid, uint256 tokenId)
    {
        Order storage order = orders[orderId];
        if (order.status != OrderStatus.Pending) revert OrderNotPending();

        Epoch storage epoch = epochs[order.epochId];
        if (keccak256(abi.encodePacked(seed)) != epoch.commitment) revert CommitmentMismatch();

        Product storage product = products[order.productId];
        product.reserved -= 1;
        epoch.revealed = true;
        pendingEscrowTotal -= order.maxEscrow;

        uint256 roll = uint256(
            keccak256(
                abi.encode(
                    seed,
                    block.chainid,
                    address(this),
                    orderId,
                    order.buyer,
                    order.productId,
                    order.maxEscrow,
                    order.payProbabilityBps,
                    order.metadataHash
                )
            )
        ) % BPS;

        paid = roll < order.payProbabilityBps;
        order.roll = roll;
        order.status = paid ? OrderStatus.Paid : OrderStatus.Free;

        uint256 paidAmount;
        uint256 refundedAmount;
        if (paid) {
            paidAmount = order.maxEscrow;
        } else {
            refundedAmount = order.maxEscrow;
            paymentToken.transferWithMemo(order.buyer, order.maxEscrow, orderId);
        }

        tokenId = _deliverNft(order.buyer, order.productId, product);
        order.tokenId = tokenId;

        uint256 redeemValue = (order.basePrice * REDEEM_BPS) / BPS;
        uint64 redeemDeadline = uint64(block.timestamp + REDEEM_WINDOW);
        redemptions[tokenId] = Redemption({value: redeemValue, deadline: redeemDeadline, active: true});
        outstandingRedemptionLiability += redeemValue;

        emit OrderResolved(
            orderId, order.buyer, tokenId, order.status, roll, paidAmount, refundedAmount, redeemValue, redeemDeadline
        );
    }

    // [SECURITY PATCH]: resolveExpired completely replaces the old `refundExpired` function.
    // Reveal-timeout now resolves to the buyer-favorable Free outcome. This neutralizes the 
    // operator selective-abort vulnerability: censoring a would-be Free order yields Free anyway, 
    // and censoring a Paid order yields the strictly-worse-for-house Free. Permissionless.
    function resolveExpired(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status != OrderStatus.Pending) revert OrderNotPending();

        Epoch storage epoch = epochs[order.epochId];
        if (block.timestamp <= epoch.revealDeadline) revert DeadlineNotPassed();

        Product storage product = products[order.productId];
        product.reserved -= 1;
        pendingEscrowTotal -= order.maxEscrow;

        // Effects: mirror the Free branch of processOrder (Checks-Effects-Interactions preserved).
        order.status = OrderStatus.Free;
        order.roll = order.payProbabilityBps; // sentinel: roll == prob => not-paid, deterministic on timeout

        uint256 redeemValue = (order.basePrice * REDEEM_BPS) / BPS;
        uint64 redeemDeadline = uint64(block.timestamp + REDEEM_WINDOW);

        // Interactions.
        paymentToken.transferWithMemo(order.buyer, order.maxEscrow, orderId);
        uint256 tokenId = _deliverNft(order.buyer, order.productId, product);
        order.tokenId = tokenId;

        redemptions[tokenId] = Redemption({value: redeemValue, deadline: redeemDeadline, active: true});
        outstandingRedemptionLiability += redeemValue;

        emit OrderResolved(
            orderId, order.buyer, tokenId, OrderStatus.Free,
            order.roll, 0, order.maxEscrow, redeemValue, redeemDeadline
        );
    }

    function redeem(uint256 tokenId) external nonReentrant {
        Redemption storage redemption = redemptions[tokenId];
        if (!redemption.active || redemption.value == 0) revert RedemptionInactive();
        if (block.timestamp > redemption.deadline) revert DeadlineNotPassed();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        uint256 amount = redemption.value;
        uint256 productId = nft.tokenProduct(tokenId);
        _clearRedemption(redemption);

        nft.transferFrom(msg.sender, address(this), tokenId);
        productInventory[productId].push(tokenId);
        paymentToken.transferWithMemo(msg.sender, amount, bytes32(tokenId));

        emit NftRedeemed(msg.sender, tokenId, productId, amount);
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

    function _placeOrder(bytes32 orderId, uint256 productId, uint16 payProbabilityBps, bytes32 metadataHash)
        private
        returns (uint256 maxEscrow)
    {
        maxEscrow = quoteMaxEscrow(productId, payProbabilityBps);
        _placeOrderWithEscrow(orderId, productId, payProbabilityBps, metadataHash, maxEscrow);
    }

    function _placeOrderWithEscrow(
        bytes32 orderId,
        uint256 productId,
        uint16 payProbabilityBps,
        bytes32 metadataHash,
        uint256 maxEscrow
    ) private {
        if (orderId == bytes32(0)) revert OrderExists();
        if (orders[orderId].status != OrderStatus.None) revert OrderExists();

        Epoch storage epoch = epochs[currentEpochId];
        
        // [PERFORMANCE / LIVENESS PATCH]: Removed `epoch.orderId != bytes32(0)` singleton gate.
        // `orderId` remains a roll input for domain separation, but is no longer restricted to 1 per epoch.
        if (
            currentEpochId == 0 || epoch.commitment == bytes32(0) || epoch.revealed
                || block.timestamp > epoch.revealDeadline
        ) revert InvalidEpoch();

        Product storage product = products[productId];
        if (!_hasAvailableStock(productId, product)) revert InvalidProduct();
        if (availableHouseReserve() < (product.basePrice * REDEEM_BPS) / BPS) revert HouseBankrupt();

        product.reserved += 1;
        pendingEscrowTotal += maxEscrow;

        orders[orderId] = Order({
            buyer: msg.sender,
            productId: productId,
            epochId: currentEpochId,
            basePrice: product.basePrice,
            maxEscrow: maxEscrow,
            payProbabilityBps: payProbabilityBps,
            metadataHash: metadataHash,
            status: OrderStatus.Pending,
            roll: 0,
            tokenId: 0
        });

        bool ok = paymentToken.transferFromWithMemo(msg.sender, address(this), maxEscrow, orderId);
        if (!ok) revert TokenTransferFailed();

        emit OrderPlaced(
            orderId,
            msg.sender,
            productId,
            currentEpochId,
            product.basePrice,
            maxEscrow,
            payProbabilityBps,
            metadataHash
        );
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator == 0 ? 0 : ((numerator - 1) / denominator) + 1;
    }

    function _deliverNft(address buyer, uint256 productId, Product storage product) private returns (uint256 tokenId) {
        uint256[] storage inventory = productInventory[productId];
        if (inventory.length != 0) {
            tokenId = inventory[inventory.length - 1];
            inventory.pop();
            nft.transferFrom(address(this), buyer, tokenId);
            return tokenId;
        }

        product.minted += 1;
        return nft.mint(buyer, productId, product.metadataURI);
    }

    function _hasAvailableStock(uint256 productId, Product storage product) private view returns (bool) {
        uint256 availableInventory = productInventory[productId].length;
        uint256 mintable = product.minted < product.maxSupply ? product.maxSupply - product.minted : 0;
        return availableInventory + mintable > product.reserved;
    }

    function _clearRedemption(Redemption storage redemption) private {
        uint256 amount = redemption.value;
        redemption.value = 0;
        redemption.deadline = 0;
        redemption.active = false;
        outstandingRedemptionLiability -= amount;
    }
}