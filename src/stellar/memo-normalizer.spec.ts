import { normalizeMemo } from "./memo-normalizer";

describe("normalizeMemo", () => {
  it.each([
    [undefined, { type: "none" }],
    [{ memo_type: "none" }, { type: "none" }],
    [{ memo_type: "id", memo: "18446744073709551615" }, { type: "id", value: "18446744073709551615" }],
  ])("normalizes supported scalar memo values", (transaction, expected) => {
    expect(normalizeMemo(transaction)).toEqual(expected);
  });

  it("normalizes text memos", () => {
    expect(normalizeMemo({ memo_type: "text", memo: "Salary June" })).toEqual({
      type: "text",
      value: "Salary June",
      truncated: false,
    });
  });

  it.each([
    ["hash", "hash"],
    ["return", "return_hash"],
  ] as const)("normalizes %s memos", (memoType, expectedType) => {
    const value = Buffer.alloc(32, 7).toString("base64");
    expect(normalizeMemo({ memo_type: memoType, memo: value })).toEqual({
      type: expectedType,
      value,
    });
  });

  it("replaces invalid UTF-8 bytes", () => {
    const memo = normalizeMemo({
      memo_type: "text",
      memo: Uint8Array.from([0x66, 0x80, 0x6f]),
    });

    expect(memo).toEqual({ type: "text", value: "f�o", truncated: false });
  });

  it("truncates text memos to 500 Unicode characters", () => {
    const memo = normalizeMemo({ memo_type: "text", memo: "😀".repeat(501) });

    expect(memo).toEqual({
      type: "text",
      value: "😀".repeat(500),
      truncated: true,
    });
  });

  it("treats unsupported and malformed memo values as none", () => {
    expect(normalizeMemo({ memo_type: "future", memo: "secret" })).toEqual({
      type: "none",
    });
    expect(normalizeMemo({ memo_type: "hash", memo: "not-a-hash" })).toEqual({
      type: "none",
    });
  });
});
