// {§tokenomics-agnostic-ruler}: one model-independent unit for packet render-weight
// and stored content-depth. Mixed-model workers share workspace accounting, so these
// values never vary by provider. Hard context-envelope admission is separate and provider-owned.
export const rulerCount = (text: string): number => Math.ceil(text.length / 2);
