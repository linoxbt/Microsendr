// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The subset of ERC-20 this contract uses.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title MicrosendrPay
/// @notice Escrow for Microsendr purchases (airtime, data, subscription cards) paid in a
/// stablecoin on QIE Mainnet.
///
/// A customer pays by transferring the token to this contract. The Microsendr operator
/// then records the payment against the order (`hold`). When the provider delivers, the
/// operator releases it to the treasury (`settle`); when delivery fails, the operator
/// returns it to the customer (`refund`). If an order is never resolved, the customer can
/// take the money back themselves once `deadline` has passed: funds held for an order can
/// only ever go to the treasury on delivery or back to the customer who paid.
contract MicrosendrPay {
    enum State { None, Held, Settled, Refunded }

    struct Payment {
        address payer;
        uint64 deadline;
        State state;
        uint256 amount;
    }

    /// @notice How long a held payment waits before its payer may reclaim it.
    uint64 public constant HOLD_PERIOD = 7 days;

    IERC20 public immutable token;
    address public immutable treasury;
    address public owner;
    address public operator;
    /// @notice Sum of all payments currently held for orders.
    uint256 public totalHeld;
    mapping(bytes32 => Payment) public payments;

    event Held(bytes32 indexed orderId, address indexed payer, uint256 amount, uint64 deadline);
    event Settled(bytes32 indexed orderId, uint256 amount);
    event Refunded(bytes32 indexed orderId, address indexed payer, uint256 amount, address by);
    event OperatorChanged(address indexed operator);
    event OwnerChanged(address indexed owner);
    event Swept(address indexed to, uint256 amount);

    error NotOwner();
    error NotOperator();
    error NotAllowed();
    error InvalidAddress();
    error InvalidAmount();
    error OrderExists();
    error NotHeld();
    error InsufficientUnallocated();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IERC20 token_, address treasury_, address operator_) {
        if (address(token_) == address(0) || treasury_ == address(0) || operator_ == address(0)) revert InvalidAddress();
        token = token_;
        treasury = treasury_;
        owner = msg.sender;
        operator = operator_;
        emit OwnerChanged(msg.sender);
        emit OperatorChanged(operator_);
    }

    /// @notice Tokens in the contract not yet assigned to any order.
    function unallocated() public view returns (uint256) {
        return token.balanceOf(address(this)) - totalHeld;
    }

    /// @notice Records a payment the customer has transferred in, against one order.
    /// @dev The amount must be covered by unallocated tokens, so the operator can only
    /// assign money that actually arrived, once.
    function hold(bytes32 orderId, address payer, uint256 amount) external onlyOperator {
        if (payer == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (payments[orderId].state != State.None) revert OrderExists();
        if (unallocated() < amount) revert InsufficientUnallocated();
        uint64 deadline = uint64(block.timestamp) + HOLD_PERIOD;
        payments[orderId] = Payment({ payer: payer, deadline: deadline, state: State.Held, amount: amount });
        totalHeld += amount;
        emit Held(orderId, payer, amount, deadline);
    }

    /// @notice Delivered: the held payment goes to the treasury.
    function settle(bytes32 orderId) external onlyOperator {
        Payment storage p = payments[orderId];
        if (p.state != State.Held) revert NotHeld();
        p.state = State.Settled;
        totalHeld -= p.amount;
        _transfer(treasury, p.amount);
        emit Settled(orderId, p.amount);
    }

    /// @notice Not delivered: the held payment goes back to its payer. The operator may
    /// refund at any time; the payer may after the deadline.
    function refund(bytes32 orderId) external {
        Payment storage p = payments[orderId];
        if (p.state != State.Held) revert NotHeld();
        if (msg.sender != operator && !(msg.sender == p.payer && block.timestamp >= p.deadline)) revert NotAllowed();
        p.state = State.Refunded;
        totalHeld -= p.amount;
        _transfer(p.payer, p.amount);
        emit Refunded(orderId, p.payer, p.amount, msg.sender);
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert InvalidAddress();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert InvalidAddress();
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    /// @notice Returns tokens sent here by mistake. Held payments can never be swept.
    function sweep(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        if (amount > unallocated()) revert InsufficientUnallocated();
        _transfer(to, amount);
        emit Swept(to, amount);
    }

    /// @dev Accepts tokens that return nothing as well as those that return true.
    function _transfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
