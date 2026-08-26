import axios from "axios";
import { signRequest, BASE_URL } from "./signRequest.js";
import { decrypt } from "./crypto.js";

export interface OrderPayload {
  symbol: string;
  side: "BUY" | "SELL";
  order_type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  quantity: number;
  price?: number;
  trigger_price?: number;
  reduce_only?: boolean;
  time_in_force?: "GTC" | "IOC" | "FOK";
  client_order_id?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;

export async function callCoinswitch(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  apiKey: string,
  secretKey: string,
  paramsOrBody: object = {},
): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Re-sign on every attempt — CoinSwitch's signature includes a
    // timestamp, so a stale signature from the first attempt would be
    // rejected on retry.
    const { headers, path } = signRequest(
      method,
      endpoint,
      method === "GET" ? paramsOrBody : {},
      apiKey,
      secretKey,
    );

    try {
      if (method === "GET") {
        const response = await axios.get(`${BASE_URL}${path}`, { headers });
        return response.data;
      } else if (method === "DELETE") {
        const response = await axios.delete(`${BASE_URL}${path}`, { headers, data: paramsOrBody });
        return response.data;
      } else {
        const response = await axios.post(`${BASE_URL}${path}`, paramsOrBody, { headers });
        return response.data;
      }
    } catch (err: unknown) {
      const is429 = axios.isAxiosError(err) && err.response?.status === 429;
      if (!is429 || attempt === MAX_RETRIES) throw err;

      // Honor Retry-After if CoinSwitch sends one; otherwise exponential
      // backoff with jitter (400ms, 800ms, 1600ms ± up to 150ms).
      const retryAfterHeader = axios.isAxiosError(err) ? err.response?.headers?.["retry-after"] : undefined;
      const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : null;
      const backoffMs = retryAfterMs ?? (400 * Math.pow(2, attempt) + Math.random() * 150);

      console.warn(`[coinswitch] 429 on ${method} ${endpoint} — retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoffMs);
    }
  }
  // Unreachable — loop always returns or throws — but keeps TS happy.
  throw new Error(`callCoinswitch: exhausted retries for ${method} ${endpoint}`);
}

/**
 * Places ONE order for ONE account.
 * Decrypts keys internally — never logs decrypted values.
 */
export async function placeOrderForAccount(
  account: { id: number; name: string; apiKey: string; secretKey: string },
  payload: OrderPayload,
): Promise<{ order_id: string; status: string }> {
  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);

  const isTpSl =
    payload.order_type === "TAKE_PROFIT_MARKET" || payload.order_type === "STOP_MARKET";

  const body: Record<string, unknown> = {
    exchange: "EXCHANGE_2",
    symbol: payload.symbol.toUpperCase(),
    side: payload.side,
    order_type: payload.order_type,
    quantity: isTpSl ? 0 : payload.quantity,
  };

  if (payload.order_type === "LIMIT" && payload.price != null) {
    body.price = payload.price;
    body.time_in_force = payload.time_in_force ?? "GTC";
  }
  if (isTpSl) {
    if (payload.trigger_price == null) {
      throw new Error(`trigger_price is required for ${payload.order_type} orders`);
    }
    body.trigger_price = payload.trigger_price;
    body.reduce_only = true;
  } else {
    if (payload.reduce_only != null) body.reduce_only = payload.reduce_only;
  }
  if (payload.order_type !== "LIMIT" && payload.time_in_force) {
    body.time_in_force = payload.time_in_force;
  }
  if (payload.client_order_id) body.client_order_id = payload.client_order_id;

  const { headers, path } = signRequest(
    "POST",
    "/trade/api/v2/futures/order",
    {},
    apiKey,
    secretKey,
  );
  try {
    const response = await axios.post(`${BASE_URL}${path}`, body, { headers });
    return response.data.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      throw new Error(`CoinSwitch ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

export async function cancelOrderForAccount(
  account: { apiKey: string; secretKey: string },
  orderId: string,
): Promise<unknown> {
  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);
  return callCoinswitch("DELETE", "/trade/api/v2/futures/order", apiKey, secretKey, {
    exchange: "EXCHANGE_2",
    order_id: orderId,
  });
}

export async function cancelAllOrdersForAccount(
  account: { apiKey: string; secretKey: string },
  symbol?: string,
): Promise<unknown> {
  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);
  const body: Record<string, string> = { exchange: "EXCHANGE_2" };
  if (symbol) body.symbol = symbol;
  return callCoinswitch("POST", "/trade/api/v2/futures/cancel_all", apiKey, secretKey, body);
}

export async function getLeverageForAccount(
  account: { apiKey: string; secretKey: string },
  symbol: string,
): Promise<{ symbol: string; leverage: string }> {
  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);
  const data = (await callCoinswitch(
    "GET",
    "/trade/api/v2/futures/leverage",
    apiKey,
    secretKey,
    { symbol, exchange: "EXCHANGE_2" },
  )) as { data: { leverage: string; symbol: string } };
  return { symbol: data.data.symbol, leverage: data.data.leverage };
}

export async function setLeverageForAccount(
  account: { apiKey: string; secretKey: string },
  symbol: string,
  leverage: number,
): Promise<void> {
  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);

  // Mirror admin's safety check: refuse to change leverage on an open position
  const posData = (await callCoinswitch(
    "GET",
    "/trade/api/v2/futures/positions",
    apiKey,
    secretKey,
    { exchange: "EXCHANGE_2", symbol },
  )) as { data: unknown[] };
  if (posData?.data?.length > 0) {
    throw new Error("Cannot change leverage: open position exists");
  }

  await callCoinswitch("POST", "/trade/api/v2/futures/leverage", apiKey, secretKey, {
    symbol,
    exchange: "EXCHANGE_2",
    leverage,
  });
}

export async function addMarginForAccount(
  account: { apiKey: string; secretKey: string },
  symbol: string,
  margin: number,
): Promise<unknown> {
  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);
  return callCoinswitch("POST", "/trade/api/v2/futures/add_margin", apiKey, secretKey, {
    exchange: "EXCHANGE_2",
    symbol,
    margin,
  });
}

export interface OrderStatus {
  order_id: string;
  symbol: string;
  side: "BUY" | "SELL";
  status: string; // e.g. "OPEN" | "FILLED" | "CANCELLED" | "REJECTED" | "PARTIALLY_FILLED" | ...
  order_type: string;
  quantity: string;
  exec_quantity: string;
  price: string;
  avg_execution_price: string;
  reduce_only: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * Ground-truth fill check for ONE specific order, by order_id — as opposed
 * to inferring a fill from the account's aggregate open-position list
 * (which is ambiguous whenever multiple ladder legs share the same
 * symbol+side, since some OTHER leg's position can make a just-cancelled
 * order look "filled"). Rate limit: 20 req/60s — only call this for an
 * order that has already disappeared from the open-orders snapshot, never
 * on every tick for every slot.
 */
export async function getOrderStatusForAccount(
  account: { apiKey: string; secretKey: string },
  orderId: string,
): Promise<OrderStatus | null> {
  const apiKey = decrypt(account.apiKey);
  const secretKey = decrypt(account.secretKey);
  try {
    const data = (await callCoinswitch("GET", "/trade/api/v2/futures/order", apiKey, secretKey, {
      order_id: orderId,
    })) as { data: { order: OrderStatus } };
    return data?.data?.order ?? null;
  } catch (err) {
    console.error(`[coinswitch] getOrderStatus failed for ${orderId}`, err);
    return null;
  }
}