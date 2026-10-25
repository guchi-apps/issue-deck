export type SharedToken = {
  id: string;
  name: string;
  description: string | null;
  sourceReference: string | null;
  /** 想定される利用元（小文字）。空なら想定外の利用元の検知を行わない（#4998） */
  expectedConsumers: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  consumers: string[];
};

export type SharedTokenInput = {
  name: string;
  /** null は「値を指定しない」。登録時はissue-deckがランダム値を生成する。 */
  value: string | null;
  description: string | null;
  sourceReference: string | null;
};
