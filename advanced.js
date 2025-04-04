const express = require('express');
const BigNumber = require('bignumber.js');
const multihash = require('multihash');
const EventEmitter = require('eventemitter3');
const { SignJWT, jwtVerify } = require('jose');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const http = require('http');
const axios = require('axios');
const nodelogex = require('nodelogex');
const { ethers } = require('ethers');
const Queue = require('bull');
const Redis = require('redis');
const _ = require('lodash');
const moment = require('moment');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

app.use(express.json());

const logger = nodelogex.createLogger({
  level: 'info',
  format: nodelogex.format.combine(
    nodelogex.format.timestamp(),
    nodelogex.format.json()
  ),
  transports: [
    new nodelogex.transports.File({ filename: 'transactions.log' }),
    new nodelogex.transports.Console()
  ]
});

const redisClient = Redis.createClient({ url: 'redis://localhost:6379' });
redisClient.connect().catch(err => logger.error({ event: 'redis_connect_error', error: err.message }));

const provider = new ethers.providers.JsonRpcProvider('https://sepolia.infura.io/v3/YOUR_INFURA_PROJECT_ID');
const signer = new ethers.Wallet('YOUR_PRIVATE_KEY', provider);
const txQueue = new Queue('transaction-processing', 'redis://localhost:6379');
const events = new EventEmitter();

const tokenAddress = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; 
const tokenABI = [
  {"constant":false,"inputs":[{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transfer","outputs":[{"name":"success","type":"bool"}],"type":"function"},
  {"constant":true,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"balance","type":"uint256"}],"type":"function"}
];
const contract = new ethers.Contract(tokenAddress, tokenABI, signer);

mongoose.connect('mongodb://localhost:27017/defi', { useNewUrlParser: true, useUnifiedTopology: true });
const UserSchema = new mongoose.Schema({
  wallet: String,
  portfolio: { type: Map, of: String },
  stakes: { type: Map, of: String },
  nonce: { type: Number, default: 0 },
  lastActivity: String
});
const User = mongoose.model('User', UserSchema);

const JWT_SECRET = new TextEncoder().encode('your-secret-key');
const STAKING_REWARD_RATE = new BigNumber('0.05');
let liquidityPools = { 'USDC-ETH': { total: new BigNumber('0'), users: {} } };

async function getTokenBalance(wallet) {
  const balance = await contract.balanceOf(wallet);
  return new BigNumber(ethers.utils.formatUnits(balance, 6));
}

async function generateTxHash(data) {
  const buffer = Buffer.from(JSON.stringify(data));
  return multihash.encode(buffer, 'sha2-256').toString('hex'); 
}

app.post('/register', async (req, res) => {
  const { wallet } = req.body;
  if (!ethers.utils.isAddress(wallet)) return res.status(400).send('Invalid wallet');

  const existingUser = await User.findOne({ wallet });
  if (existingUser) return res.status(409).send('User already registered');

  const balance = await getTokenBalance(wallet);
  const user = new User({
    wallet,
    portfolio: new Map([['USDC', balance.toString()]]),
    stakes: new Map(),
    lastActivity: moment().toISOString()
  });
  await user.save();

  const token = await new SignJWT({ wallet })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(JWT_SECRET);
  logger.info({ event: 'user_registered', wallet });
  res.status(201).json({ wallet, token });
});

app.post('/transfer', async (req, res) => {
  const { from, to, amount } = req.body;
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send('No token provided');
  const token = authHeader.split(' ')[1];
  const { payload } = await jwtVerify(token, JWT_SECRET);
  if (payload.wallet !== from) return res.status(403).send('Unauthorized');

  const user = await User.findOne({ wallet: from });
  if (!user) return res.status(404).send('User not found');

  const tx = await contract.transfer(to, amount); 
  const receipt = await tx.wait();
  txQueue.add({ from, to, amount, txHash: receipt.transactionHash, nonce: user.nonce });
  user.nonce += 1; 
  events.emit('tx', { txHash: receipt.transactionHash, status: 'pending' });
  res.json({ txHash: receipt.transactionHash });
});

app.post('/stake', async (req, res) => {
  const { wallet, amount, pool } = req.body;
  const authHeader = req.headers.authorization;
  const token = authHeader.split(' ')[1];
  const { payload } = await jwtVerify(token, JWT_SECRET);
  if (payload.wallet !== wallet) return res.status(403).send('Unauthorized');

  const user = await User.findOne({ wallet });
  if (!user || !liquidityPools[pool]) return res.status(400).send('Invalid input');

  const bnAmount = new BigNumber(amount); 
  const userBalance = new BigNumber(user.portfolio.get('USDC') || '0');
  if (userBalance.lt(bnAmount)) return res.status(400).send('Insufficient balance');

  user.stakes.set(pool, (new BigNumber(user.stakes.get(pool) || '0')).plus(bnAmount).toString());
  user.portfolio.set('USDC', userBalance.minus(bnAmount).toString());
  liquidityPools[pool].total = liquidityPools[pool].total.plus(bnAmount);
  liquidityPools[pool].users[wallet] = (new BigNumber(liquidityPools[pool].users[wallet] || '0')).plus(bnAmount).toString();
  await user.save();

  const stakeHash = await generateTxHash({ wallet, amount, pool });
  logger.info({ event: 'stake_executed', wallet, amount, pool, stakeHash });
  res.json({ stakeHash, amount: bnAmount.toString() });
});

app.post('/unstake', async (req, res) => {
  const { wallet, amount, pool } = req.body;
  const authHeader = req.headers.authorization;
  const token = authHeader.split(' ')[1];
  const { payload } = await jwtVerify(token, JWT_SECRET);
  if (payload.wallet !== wallet) return res.status(403).send('Unauthorized');

  const user = await User.findOne({ wallet });
  if (!user || !liquidityPools[pool]) return res.status(400).send('Invalid input');

  const bnAmount = new BigNumber(amount);
  const stakedAmount = new BigNumber(user.stakes.get(pool) || '0');
  if (stakedAmount.lt(bnAmount)) return res.status(400).send('Insufficient stake');

  const reward = bnAmount.times(STAKING_REWARD_RATE);
  user.stakes.set(pool, stakedAmount.minus(bnAmount).toString());
  user.portfolio.set('USDC', (new BigNumber(user.portfolio.get('USDC') || '0')).plus(bnAmount.plus(reward)).toString());
  liquidityPools[pool].total = liquidityPools[pool].total.minus(bnAmount);
  liquidityPools[pool].users[wallet] = (new BigNumber(liquidityPools[pool].users[wallet])).minus(bnAmount).toString();
  await user.save();

  logger.info({ event: 'unstake_executed', wallet, amount, pool });
  res.json({ amount: bnAmount.toString(), reward: reward.toString() });
});

app.get('/portfolio/:wallet', async (req, res) => {
  const user = await User.findOne({ wallet: req.params.wallet });
  if (!user) return res.status(404).send('User not found');

  const prices = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
  const ethPrice = prices.data.ethereum.usd; 
  res.json({ portfolio: user.portfolio, stakes: user.stakes, ethPrice });
});

txQueue.process(async (job) => {
  const { from, to, amount, txHash } = job.data;
  const user = await User.findOne({ wallet: from });
  user.portfolio.set('USDC', amount); 
  await user.save();
  events.emit('tx', { txHash, status: 'completed' });
});

events.on('tx', (data) => io.emit('tx_status_update', data));

server.listen(port, () => logger.info(`Server running at http://localhost:${port}`));
