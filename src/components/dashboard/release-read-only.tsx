"use client";

import { createContext, useContext } from "react";

/**
 * 本番公開の全自動が動いている間は、指摘の判断・検証の再実行・取り込みを出さず、結果だけを読ませる。
 * 操作の部品が深い位置にあるため、propsで引き回さずにcontextで渡す
 */
export const ReleaseReadOnlyContext = createContext(false);

export function useReleaseReadOnly(): boolean {
  return useContext(ReleaseReadOnlyContext);
}
