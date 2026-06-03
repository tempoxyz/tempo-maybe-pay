// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

abstract contract ReentrancyGuard {
    uint256 private locked = 1;

    error ReentrantCall();

    modifier nonReentrant() {
        if (locked != 1) revert ReentrantCall();
        locked = 2;
        _;
        locked = 1;
    }
}

