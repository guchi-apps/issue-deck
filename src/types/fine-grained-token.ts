export type FineGrainedToken = {
  id: string;
  name: string;
  expiresAt: string;
};

export type FineGrainedTokenInput = Omit<FineGrainedToken, "id">;
