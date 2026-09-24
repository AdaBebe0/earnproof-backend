import {
  HorizonTransactionRecord,
  NormalizedMemo,
} from "./stellar.types";

const MAX_MEMO_TEXT_CHARACTERS = 500;

export function normalizeMemo(
  transaction: HorizonTransactionRecord | null | undefined,
): NormalizedMemo {
  if (!transaction || !transaction.memo || transaction.memo_type === "none") {
    return { type: "none" };
  }

  switch (transaction.memo_type) {
    case "text":
      return normalizeTextMemo(transaction.memo);
    case "id":
      return typeof transaction.memo === "string" &&
        /^\d+$/.test(transaction.memo)
        ? { type: "id", value: transaction.memo }
        : { type: "none" };
    case "hash":
      return normalizeHashMemo("hash", transaction.memo);
    case "return":
      return normalizeHashMemo("return_hash", transaction.memo);
    default:
      return { type: "none" };
  }
}

function normalizeTextMemo(value: string | Uint8Array): NormalizedMemo {
  const decoded =
    typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  const characters = Array.from(decoded);
  const truncated = characters.length > MAX_MEMO_TEXT_CHARACTERS;

  return {
    type: "text",
    value: characters.slice(0, MAX_MEMO_TEXT_CHARACTERS).join(""),
    truncated,
  };
}

function normalizeHashMemo(
  type: "hash" | "return_hash",
  value: string | Uint8Array,
): NormalizedMemo {
  const bytes =
    typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value);

  if (bytes.length !== 32) {
    return { type: "none" };
  }

  return { type, value: bytes.toString("base64") };
}
