// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import { OApp } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

/// @title ThresholdVault
/// @notice Testamento omnichain. Esecuzione atomica cross-chain alla scadenza.
contract ThresholdVault is OApp {
    struct Beneficiary {
        address recipient;
        uint16  basisPoints;          // 10000 = 100%
        uint32  chainId;              // dove inviare
    }

    struct Will {
        uint64 inactivityDays;
        uint64 gracePeriodDays;
        uint64 lastActivity;
        Beneficiary[] beneficiaries;
        bytes32 finalMessageHash;
        bytes32 sealedSecretCid;      // IPFS CID encrypted via Lit
        bool    triggered;
    }

    enum MsgType { GRACE_STARTED, EXECUTE_DISTRIBUTION, ABORT }

    mapping(bytes32 => Will) public wills;

    event ThresholdTriggered(bytes32 indexed anima, uint64 at);
    event GracePeriodStarted(bytes32 indexed anima, uint64 expiresAt);
    event WillExecuted(bytes32 indexed anima, uint256 totalDistributed);

    constructor(address endpoint, address owner) OApp(endpoint, owner) {}

    /// Chiamato da AnimaRegistry su qualsiasi azione dell'utente.
    function pokeActivity(bytes32 anima) external {
        wills[anima].lastActivity = uint64(block.timestamp);
    }

    function triggerThreshold(bytes32 anima) external {
        Will storage w = wills[anima];
        uint256 elapsed = block.timestamp - w.lastActivity;
        require(elapsed >= w.inactivityDays * 1 days, "too early");
        require(!w.triggered, "already triggered");

        w.triggered = true;
        uint64 graceEnd = uint64(block.timestamp + w.gracePeriodDays * 1 days);

        _broadcast(abi.encode(MsgType.GRACE_STARTED, anima, graceEnd), 300_000);
        emit GracePeriodStarted(anima, graceEnd);
    }

    function executeWill(bytes32 anima) external {
        Will storage w = wills[anima];
        require(w.triggered, "not triggered");
        uint256 deadline = w.lastActivity + (w.inactivityDays + w.gracePeriodDays) * 1 days;
        require(block.timestamp >= deadline, "in grace");

        for (uint i = 0; i < w.beneficiaries.length; i++) {
            Beneficiary memory b = w.beneficiaries[i];
            if (b.chainId == block.chainid) {
                _distributeLocal(anima, b);
            } else {
                _distributeRemote(anima, b);
            }
        }
        emit WillExecuted(anima, _totalDistributed(anima));
    }

    function _lzReceive(
        bytes32, bytes calldata, address, bytes calldata
    ) internal pure {
        // dispatch su MsgType
    }

    // ─── helpers illustrativi ───
    function _broadcast(bytes memory, uint128) internal {}
    function _distributeLocal(bytes32, Beneficiary memory) internal {}
    function _distributeRemote(bytes32, Beneficiary memory) internal {}
    function _totalDistributed(bytes32) internal pure returns (uint256) { return 0; }
}
