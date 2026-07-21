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

export async function callCoinswitch(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  apiKey: string,
  secretKey: string,
  paramsOrBody: object = {},
): Promise<unknown> {
  const { headers, path } = signRequest(
    method,
    endpoint,
    method === "GET" ? paramsOrBody : {},
    apiKey,
    secretKey,
  );

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
