# Advanced: DeFi Transaction and Staking Platform

Simulates a DeFi platform with token transfers, staking, and portfolio tracking. **Contains intentional bugs requiring execution and debugging.**

## Source Code
- **File**: `advanced.js`

## Prerequisites
- **Node.js**: v16+
- **Dependencies**: `npm install express bignumber.js multihash eventemitter3 jose mongoose socket.io axios nodelogex ethers bull redis lodash moment`
- **Env Vars**: `INFURA_PROJECT_ID`, `PRIVATE_KEY`
- **Services**: MongoDB (`localhost:27017`), Redis (`localhost:6379`)

## Setup
1. `npm install`
2. Create `.env`:
  ```plaintext
      INFURA_PROJECT_ID=your-id
      PRIVATE_KEY=your-keys
  ```
3. Run `mongod` and `redis-server`
4. `node advanced.js`

## Problems and Questions

1. **Execution Analysis**: Run `/register`, `/transfer`, `/stake`, `/unstake`, `/portfolio/:wallet`. Why are balances inconsistent?
2. **Bug Fix**: Fix `/transfer` `amount` parsing. Submit code and explanation.
3. **Debugging**: Check `/stake` and `/unstake` reward accuracy. Describe process if off.
4. **Enhancement**: Add periodic reward distribution with `eventemitter3`. Provide code.

## Notes
- Use valid Sepolia wallets
- Fund USDC contract with test tokens
