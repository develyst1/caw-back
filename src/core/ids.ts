// Server-made ids are UUID v7: time-ordered and strictly increasing within this process, so sorting by id is creation order
// (the notes of a card read oldest first without a sequence column).
export const newId = (): string => Bun.randomUUIDv7();
export const now = (): string => new Date().toISOString();
