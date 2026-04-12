---
name: base-blockchain
description: Query Base (Ethereum L2) blockchain data — wallet balances, token info, transactions, gas analysis, contract inspection. No API key required.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Base, Blockchain, Crypto, Web3, EVM, L2, Ethereum, DeFi]
    related_skills: [solana]
---

# Base Blockchain

Query Base (Ethereum L2) on-chain data enriched with USD pricing. No API key needed — uses public RPC + CoinGecko.

## Base RPC Endpoints

```
Mainnet: https://mainnet.base.org
Testnet: https://sepolia.base.org
Chain ID: 8453 (mainnet) / 84532 (testnet)
```

## Python Setup

```python
import urllib.request, json

RPC = "https://mainnet.base.org"

def rpc_call(method, params=[]):
    payload = json.dumps({"jsonrpc":"2.0","method":method,"params":params,"id":1}).encode()
    req = urllib.request.Request(RPC, data=payload, headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())["result"]
```

---

## Wallet Balance

```python
def get_eth_balance(address):
    hex_balance = rpc_call("eth_getBalance", [address, "latest"])
    return int(hex_balance, 16) / 1e18

addr = "0xYourWalletAddress"
print(f"Balance: {get_eth_balance(addr):.6f} ETH")
```

---

## ERC-20 Token Balance

```python
# balanceOf(address) = keccak256 first 4 bytes = 0x70a08231
def get_token_balance(token_addr, wallet_addr, decimals=18):
    data = "0x70a08231" + wallet_addr[2:].zfill(64)
    result = rpc_call("eth_call", [{"to": token_addr, "data": data}, "latest"])
    return int(result, 16) / (10 ** decimals)

# USDC on Base (6 decimals)
usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
print(f"USDC: {get_token_balance(usdc, addr, decimals=6):.2f}")
```

---

## Transaction Details

```python
def get_tx(tx_hash):
    return rpc_call("eth_getTransactionByHash", [tx_hash])

def get_tx_receipt(tx_hash):
    return rpc_call("eth_getTransactionReceipt", [tx_hash])

tx = get_tx("0xabc123...")
print(f"From: {tx['from']}")
print(f"To: {tx['to']}")
print(f"Value: {int(tx['value'],16)/1e18} ETH")
```

---

## Gas Analysis

```python
def get_gas_price():
    hex_gas = rpc_call("eth_gasPrice")
    gwei = int(hex_gas, 16) / 1e9
    return gwei

print(f"Gas price: {get_gas_price():.2f} Gwei")

# Estimate gas for a transfer
def estimate_gas(from_addr, to_addr, value_eth):
    return rpc_call("eth_estimateGas", [{
        "from": from_addr,
        "to": to_addr,
        "value": hex(int(value_eth * 1e18))
    }])
```

---

## ETH Price (CoinGecko)

```python
def get_eth_price_usd():
    url = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())["ethereum"]["usd"]

price = get_eth_price_usd()
balance = get_eth_balance(addr)
print(f"Portfolio: ${balance * price:.2f} USD")
```

---

## Block Info

```python
def get_latest_block():
    return rpc_call("eth_getBlockByNumber", ["latest", False])

block = get_latest_block()
print(f"Block: {int(block['number'],16)}")
print(f"Txs: {len(block['transactions'])}")
```

---

## Contract Inspection

```python
# Check if address is a contract
def is_contract(address):
    code = rpc_call("eth_getCode", [address, "latest"])
    return code != "0x"

# Read contract storage slot
def get_storage(address, slot):
    return rpc_call("eth_getStorageAt", [address, hex(slot), "latest"])
```

---

## Basescan API (optional)

For detailed tx history, use Basescan API (free key at basescan.org):
```python
BASESCAN = "https://api.basescan.org/api"
# Get tx list for address
params = f"?module=account&action=txlist&address={addr}&apikey=YOUR_KEY"
```
