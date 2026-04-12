---
name: solana
description: Query Solana blockchain data — SOL balances, SPL tokens, transactions, programs, and NFTs via JSON RPC API.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Solana, Blockchain, Crypto, Web3, SOL, SPL-Tokens, NFT]
    related_skills: [base-blockchain]
---

# Solana Blockchain

Query Solana on-chain data via JSON RPC. No API key required for public endpoints.

## RPC Endpoints

```
Mainnet: https://api.mainnet-beta.solana.com
Devnet:  https://api.devnet.solana.com
Testnet: https://api.testnet.solana.com
```

## Python Setup

```python
import urllib.request, json

RPC = "https://api.mainnet-beta.solana.com"

def rpc(method, params=[]):
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": method, "params": params
    }).encode()
    req = urllib.request.Request(
        RPC, data=payload,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        resp = json.loads(r.read())
    if "error" in resp:
        raise Exception(resp["error"])
    return resp["result"]
```

---

## SOL Balance

```python
def get_sol_balance(pubkey):
    result = rpc("getBalance", [pubkey])
    return result["value"] / 1e9  # lamports → SOL

addr = "YourWalletPublicKey..."
print(f"Balance: {get_sol_balance(addr):.4f} SOL")
```

---

## SPL Token Accounts

```python
def get_token_accounts(pubkey):
    result = rpc("getTokenAccountsByOwner", [
        pubkey,
        {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
        {"encoding": "jsonParsed"}
    ])
    return result["value"]

accounts = get_token_accounts(addr)
for acc in accounts:
    info = acc["account"]["data"]["parsed"]["info"]
    mint = info["mint"]
    amount = info["tokenAmount"]["uiAmount"]
    print(f"Token: {mint[:8]}... Balance: {amount}")
```

---

## Transaction Details

```python
def get_tx(signature):
    return rpc("getTransaction", [
        signature,
        {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
    ])

def get_recent_txs(pubkey, limit=10):
    sigs = rpc("getSignaturesForAddress", [pubkey, {"limit": limit}])
    return [s["signature"] for s in sigs]
```

---

## Account Info

```python
def get_account(pubkey):
    return rpc("getAccountInfo", [pubkey, {"encoding": "jsonParsed"}])

info = get_account(addr)
print(f"Lamports: {info['value']['lamports']}")
print(f"Owner: {info['value']['owner']}")
print(f"Executable: {info['value']['executable']}")
```

---

## Network Stats

```python
def get_slot():
    return rpc("getSlot")

def get_epoch_info():
    return rpc("getEpochInfo")

def get_recent_performance():
    return rpc("getRecentPerformanceSamples", [5])

print(f"Current slot: {get_slot()}")
epoch = get_epoch_info()
print(f"Epoch: {epoch['epoch']}, Slot: {epoch['slotIndex']}/{epoch['slotsInEpoch']}")
```

---

## SOL Price

```python
def get_sol_price():
    url = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())["solana"]["usd"]

price = get_sol_price()
bal = get_sol_balance(addr)
print(f"Portfolio: ${bal * price:.2f} USD")
```

---

## Solana CLI (alternative)

```bash
# Install
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Balance
solana balance WALLET_ADDRESS

# Transaction history
solana transaction-history WALLET_ADDRESS --limit 10

# Set network
solana config set --url mainnet-beta
```

---

## Helius / QuickNode (enhanced APIs)

For NFT data, DAS API, and higher rate limits:
```python
# Helius (free tier available)
RPC = "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
```
