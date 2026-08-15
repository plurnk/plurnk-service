// {§tokenomics-agnostic-ruler}: one model-independent curation weight for
// stored content and rendered packets. Physical provider tokens never use it.
export const contentWeight = (text: string): number => Math.ceil(text.length / 2);
