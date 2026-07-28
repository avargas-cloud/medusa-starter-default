const QB_MEMO_MAX_LENGTH = 4095;

export function qbItemReceiptIdentityMemo(input: {
  receiptId: string;
  receiptNumber: string;
  memo?: string | null;
}): string {
  const identity = `EPT Receipt ${input.receiptNumber} [${input.receiptId}]`;
  const memo = input.memo?.trim();
  return (memo ? `${identity} | ${memo}` : identity).slice(
    0,
    QB_MEMO_MAX_LENGTH
  );
}
