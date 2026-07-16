import http from "node:http";
import { Interface } from "ethers";

const transferInterface = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

function toHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function fakeHash(prefix, number) {
  return `0x${String(prefix).repeat(64).slice(0, 56)}${BigInt(number).toString(16).padStart(8, "0")}`;
}

export async function startMockRpcServer({ chainId = 137 } = {}) {
  const receipts = new Map();
  const blocks = new Map();
  let latestBlock = 1;
  let beforeRespond = null;

  function registerTransfer({
    txHash,
    tokenContract,
    fromAddress,
    toAddress,
    amountBase,
    blockNumber,
    blockTimestamp = 1_710_000_000,
    logIndex = 0,
    status = 1,
    includeTransferLog = true,
  }) {
    const normalizedTxHash = String(txHash).toLowerCase();
    const normalizedTokenContract = normalizeAddress(tokenContract);
    const normalizedFrom = normalizeAddress(fromAddress);
    const normalizedTo = normalizeAddress(toAddress);
    latestBlock = Math.max(latestBlock, Number(blockNumber || 1));
    blocks.set(Number(blockNumber), {
      number: Number(blockNumber),
      timestamp: Number(blockTimestamp),
    });
    const logs = [];
    if (includeTransferLog) {
      const encoded = transferInterface.encodeEventLog("Transfer", [normalizedFrom, normalizedTo, BigInt(amountBase)]);
      logs.push({
        address: normalizedTokenContract,
        topics: encoded.topics,
        data: encoded.data,
        logIndex: toHex(logIndex),
        transactionHash: normalizedTxHash,
        blockNumber: toHex(blockNumber),
        blockHash: fakeHash("b", blockNumber),
        transactionIndex: "0x0",
        removed: false,
      });
    }
    receipts.set(normalizedTxHash, {
      transactionHash: normalizedTxHash,
      transactionIndex: "0x0",
      blockNumber: toHex(blockNumber),
      blockHash: fakeHash("b", blockNumber),
      from: normalizedFrom,
      to: normalizedTo,
      cumulativeGasUsed: "0x0",
      gasUsed: "0x0",
      contractAddress: null,
      logs,
      logsBloom: `0x${"0".repeat(512)}`,
      status: toHex(status),
      effectiveGasPrice: "0x0",
      type: "0x2",
    });
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const payload = body ? JSON.parse(body) : {};
    const handlePayload = async (item) => {
      const method = item?.method;
      const id = item?.id ?? 1;
      if (beforeRespond) await beforeRespond({ method, payload: item });
      if (method === "eth_chainId") {
        return { jsonrpc: "2.0", id, result: toHex(chainId) };
      }
      if (method === "eth_getTransactionReceipt") {
        const txHash = String(item.params?.[0] || "").toLowerCase();
        return { jsonrpc: "2.0", id, result: receipts.get(txHash) || null };
      }
      if (method === "eth_blockNumber") {
        return { jsonrpc: "2.0", id, result: toHex(latestBlock) };
      }
      if (method === "eth_getBlockByNumber") {
        const raw = String(item.params?.[0] || "0x1");
        const blockNumber = Number(BigInt(raw));
        const block = blocks.get(blockNumber);
        if (!block) return { jsonrpc: "2.0", id, result: null };
        return {
          jsonrpc: "2.0",
          id,
          result: {
            number: toHex(block.number),
            hash: fakeHash("c", block.number),
            parentHash: fakeHash("d", Math.max(block.number - 1, 0)),
            timestamp: toHex(block.timestamp),
            nonce: "0x0000000000000000",
            difficulty: "0x0",
            gasLimit: "0x0",
            gasUsed: "0x0",
            miner: "0x0000000000000000000000000000000000000000",
            extraData: "0x",
            baseFeePerGas: "0x0",
            transactions: [],
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not implemented: ${method}` },
      };
    };
    const responsePayload = Array.isArray(payload)
      ? await Promise.all(payload.map((item) => handlePayload(item)))
      : await handlePayload(payload);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(responsePayload));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    registerTransfer,
    setLatestBlock(blockNumber) {
      latestBlock = Math.max(latestBlock, Number(blockNumber));
    },
    setBeforeRespond(handler) {
      beforeRespond = typeof handler === "function" ? handler : null;
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
