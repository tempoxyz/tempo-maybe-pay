// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ITIP20} from "./ITIP20.sol";
import {Owned} from "./Owned.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {TempoMaybePayNFT} from "./TempoMaybePayNFT.sol";

contract TempoMaybePayStore is Owned, ReentrancyGuard {
    uint16 public constant BPS = 10_000;
    uint16 public constant MIN_PAY_PROBABILITY_BPS = 100;

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
        bytes32 orderId;
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

    ITIP20 public immutable paymentToken;
    TempoMaybePayNFT public immutable nft;
    address public merchant;
    uint256 public currentEpochId;

    mapping(uint256 productId => Product product) public products;
    mapping(uint256 epochId => Epoch epoch) public epochs;
    mapping(bytes32 orderId => Order order) public orders;
    mapping(address processor => bool enabled) public processors;

    event MerchantUpdated(address indexed merchant);
    event ProcessorUpdated(address indexed processor, bool enabled);
    event ProductSet(
        uint256 indexed productId,
        string name,
        uint256 basePrice,
        uint256 maxSupply,
        bool active,
        string metadataURI
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
        uint256 refundedAmount
    );
    event OrderRefunded(bytes32 indexed orderId, address indexed buyer, uint256 amount);

    error InvalidProbability();
    error InvalidProduct();
    error InvalidEpoch();
    error EpochBusy();
    error OrderExists();
    error OrderNotPending();
    error DeadlineNotPassed();
    error CommitmentMismatch();
    error TokenTransferFailed();

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

        Epoch storage current = epochs[currentEpochId];
        if (currentEpochId != 0 && current.orderId != bytes32(0) && !current.revealed && block.timestamp <= current.revealDeadline)
        {
            revert EpochBusy();
        }

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
        if (!product.active || product.basePrice == 0 || product.minted + product.reserved >= product.maxSupply) {
            revert InvalidProduct();
        }
        if (payProbabilityBps < MIN_PAY_PROBABILITY_BPS || payProbabilityBps > BPS) revert InvalidProbability();
        return _ceilDiv(product.basePrice * BPS, payProbabilityBps);
    }

    function placeOrder(
        bytes32 orderId,
        uint256 productId,
        uint16 payProbabilityBps,
        bytes32 metadataHash
    ) external nonReentrant returns (uint256 maxEscrow) {
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

    function processOrder(bytes32 orderId, bytes32 seed) external onlyProcessor nonReentrant returns (bool paid, uint256 tokenId) {
        Order storage order = orders[orderId];
        if (order.status != OrderStatus.Pending) revert OrderNotPending();

        Epoch storage epoch = epochs[order.epochId];
        if (keccak256(abi.encodePacked(seed)) != epoch.commitment) revert CommitmentMismatch();

        Product storage product = products[order.productId];
        product.reserved -= 1;
        product.minted += 1;
        epoch.revealed = true;

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
            paymentToken.transferWithMemo(merchant, order.maxEscrow, orderId);
        } else {
            refundedAmount = order.maxEscrow;
            paymentToken.transferWithMemo(order.buyer, order.maxEscrow, orderId);
        }

        tokenId = nft.mint(order.buyer, order.productId, product.metadataURI);
        order.tokenId = tokenId;

        emit OrderResolved(orderId, order.buyer, tokenId, order.status, roll, paidAmount, refundedAmount);
    }

    function refundExpired(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status != OrderStatus.Pending) revert OrderNotPending();
        Epoch storage epoch = epochs[order.epochId];
        if (block.timestamp <= epoch.revealDeadline) revert DeadlineNotPassed();

        Product storage product = products[order.productId];
        product.reserved -= 1;
        order.status = OrderStatus.Refunded;
        paymentToken.transferWithMemo(order.buyer, order.maxEscrow, orderId);
        emit OrderRefunded(orderId, order.buyer, order.maxEscrow);
    }

    function _placeOrder(
        bytes32 orderId,
        uint256 productId,
        uint16 payProbabilityBps,
        bytes32 metadataHash
    ) private returns (uint256 maxEscrow) {
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
        if (
            currentEpochId == 0 || epoch.commitment == bytes32(0) || epoch.revealed || epoch.orderId != bytes32(0)
                || block.timestamp > epoch.revealDeadline
        ) revert InvalidEpoch();

        Product storage product = products[productId];
        product.reserved += 1;
        epoch.orderId = orderId;

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
}

