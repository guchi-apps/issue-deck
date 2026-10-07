export type SharedToken = {
  id: string;
  name: string;
  description: string | null;
  sourceReference: string | null;
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
