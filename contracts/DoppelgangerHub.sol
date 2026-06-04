// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import { OApp, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

/// @title DoppelgangerHub
/// @notice Matching di intent cross-chain tra agenti AI.
contract DoppelgangerHub is OApp {
    struct Intent {
        bytes32 anima;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        uint256 minAmountOut;
        uint32  preferredChain;     // 0 = qualsiasi
        uint64  expiry;
        bytes32 commitment;          // hash(salt, params) — anti front-running
    }

    enum MsgType { INTENT_BROADCAST, MATCH_COMMIT, MATCH_SETTLE, MATCH_ABORT }

    mapping(bytes32 => Intent) public openIntents;
    mapping(bytes32 => bytes32) public matched;

    event IntentPublished(bytes32 indexed intentId, bytes32 indexed anima);
    event IntentMatched(bytes32 indexed a, bytes32 indexed b, uint32 settleChain);

    constructor(address endpoint, address owner) OApp(endpoint, owner) {}

    function publishIntent(Intent calldata i) external payable returns (bytes32 id) {
        id = keccak256(abi.encode(i, block.timestamp));
        openIntents[id] = i;

        bytes memory payload = abi.encode(MsgType.INTENT_BROADCAST, id, i);
        _broadcast(payload, 400_000);

        emit IntentPublished(id, i.anima);
    }

    function matchAndCommit(bytes32 myIntent, bytes32 theirIntent, uint32 settleChain)
        external payable
    {
        _assertCompatible(openIntents[myIntent], openIntents[theirIntent]);

        _lockEscrow(myIntent);

        bytes memory payload = abi.encode(
            MsgType.MATCH_COMMIT, myIntent, theirIntent, settleChain
        );
        _lzSendTo(_chainOfIntent(theirIntent), payload, 500_000);

        matched[myIntent] = theirIntent;
        emit IntentMatched(myIntent, theirIntent, settleChain);
    }

    function _lzReceive(
        Origin calldata,
        bytes32, bytes calldata payload, address, bytes calldata
    ) internal override {
        // dispatch su MsgType — settlement, abort, broadcast index — omessi
    }

    // ─── helpers illustrativi ───
    function _broadcast(bytes memory, uint128) internal { /* iterate peerChains */ }
    function _lzSendTo(uint32, bytes memory, uint128) internal { /* lzSend */ }
    function _assertCompatible(Intent memory, Intent memory) internal pure {}
    function _lockEscrow(bytes32) internal {}
    function _chainOfIntent(bytes32) internal pure returns (uint32) { return 0; }
}
