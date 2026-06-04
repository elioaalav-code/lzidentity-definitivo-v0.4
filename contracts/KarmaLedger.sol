// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import { OApp, Origin, MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/// @title KarmaLedger
/// @notice Saldo Karma omnichain con pattern Optimistic Local, Eventually Global.
contract KarmaLedger is OApp {
    using OptionsBuilder for bytes;

    struct LocalBudget {
        uint128 allocated;
        uint128 spent;
        uint64  lastSyncTimestamp;
        uint64  nonce;
    }

    mapping(bytes32 => LocalBudget) public budgets;
    mapping(bytes32 => uint128) public globalSnapshot;
    mapping(bytes32 => mapping(uint64 => bool)) public seenNonce;

    uint16 public constant DEFAULT_LOCAL_PCT = 2000;
    uint64 public constant FORCED_SYNC_INTERVAL = 24 hours;

    enum MessageType { PULL_REQUEST, CREDIT, SYNC_SNAPSHOT, BURN }
    uint32[] public peerChains;

    error KarmaExhausted(uint128 needed, uint128 available);
    error StaleNonce();
    error DriftTooHigh();

    event KarmaSpent(bytes32 indexed anima, uint128 amount, bytes32 reason);
    event KarmaEarned(bytes32 indexed anima, uint128 amount, bytes32 source);
    event RebalanceRequested(bytes32 indexed anima, uint32 fromChain, uint128 amount);

    constructor(address endpoint, address owner) OApp(endpoint, owner) {}

    /// Spesa locale — istantanea se entro il budget locale.
    function spendKarma(
        bytes32 anima,
        uint128 amount,
        bytes32 reason,
        bytes calldata sig
    ) external {
        _verifySpendAuth(anima, amount, reason, sig);
        LocalBudget storage b = budgets[anima];

        uint128 available = b.allocated - b.spent;
        if (amount > available) {
            _requestKarmaPull(anima, amount - available);
            revert KarmaExhausted(amount, available);
        }

        b.spent += amount;
        b.nonce += 1;
        emit KarmaSpent(anima, amount, reason);
    }

    /// Chiede budget da altre chain via LZ.
    function _requestKarmaPull(bytes32 anima, uint128 needed) internal {
        bytes memory payload = abi.encode(
            MessageType.PULL_REQUEST,
            anima,
            needed,
            block.chainid
        );

        bytes memory options = OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(250_000, 0);

        for (uint i = 0; i < peerChains.length; i++) {
            _lzSend(
                peerChains[i],
                payload,
                options,
                MessagingFee(msg.value / peerChains.length, 0),
                payable(msg.sender)
            );
        }

        emit RebalanceRequested(anima, uint32(block.chainid), needed);
    }

    /// Riceve crediti o richieste di pull via LZ.
    function _lzReceive(
        Origin calldata origin,
        bytes32, /*guid*/
        bytes calldata payload,
        address, /*executor*/
        bytes calldata /*extraData*/
    ) internal override {
        (MessageType mtype, bytes32 anima, uint128 amount, uint64 nonce) =
            abi.decode(payload, (MessageType, bytes32, uint128, uint64));

        if (seenNonce[anima][nonce]) revert StaleNonce();
        seenNonce[anima][nonce] = true;

        if (mtype == MessageType.PULL_REQUEST) {
            _handlePullRequest(origin.srcEid, anima, amount);
        } else if (mtype == MessageType.CREDIT) {
            budgets[anima].allocated += amount;
        } else if (mtype == MessageType.SYNC_SNAPSHOT) {
            _applySnapshot(anima, amount);
        }
    }

    function _handlePullRequest(uint32 srcEid, bytes32 anima, uint128 needed) internal {
        LocalBudget storage b = budgets[anima];
        uint128 surplus = b.allocated - b.spent;
        uint128 toSend = surplus > needed ? needed : surplus / 2;

        if (toSend > 0) {
            b.allocated -= toSend;
            _sendCredit(srcEid, anima, toSend);
        }
    }

    // ─── helpers (illustrativi, non-deploy-ready) ───
    function _verifySpendAuth(bytes32, uint128, bytes32, bytes calldata) internal pure {
        // verifica EIP-712 signature dell'utente — omessa per brevità
    }
    function _sendCredit(uint32, bytes32, uint128) internal { /* lzSend CREDIT */ }
    function _applySnapshot(bytes32, uint128) internal { /* update snapshot */ }
}
