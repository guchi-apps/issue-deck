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
  value: string;
  description: string | null;
  sourceReference: string | null;
};
